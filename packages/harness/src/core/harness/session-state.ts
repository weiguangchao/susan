import type { CompletionMessage, ProviderToolDefinition, ProviderUsage, ReasoningEffort } from "../provider";
import {
  estimateMessagesTokens,
  estimateTextTokens,
  estimateToolsTokens,
  latestCompactionCheckpoint,
  modelContextMessages,
} from "../context";
import type { CompactionEntry, SessionRecord, SessionStore, SessionTranscript } from "../session";
import { buildSystemPrompt } from "../system-prompt";
import { restoreUsageBaseline, type UsageBaseline } from "./restore";
import type { HarnessError, HarnessEvent, HarnessCommandResult, HarnessTool } from "./types";

export type SessionState = {
  messages(): readonly CompletionMessage[];
  checkpoint(): CompactionEntry | undefined;
  usageBaseline(): UsageBaseline | undefined;
  sessionTotalTokens(): number;
  sessionInputTokens(): number;
  sessionCachedInputTokens(): number;
  estimateCurrentContext(): number;
  clearUsageBaseline(): void;
  setUsageBaseline(baseline: UsageBaseline): void;
  appendMessage(message: CompletionMessage): Promise<HarnessCommandResult>;
  appendProviderUsage(
    usage: ProviderUsage | undefined,
    modelConfiguration:
      | { readonly model: string; readonly reasoningEffort: ReasoningEffort }
      | undefined,
  ): Promise<HarnessCommandResult>;
  commitCompaction(entry: CompactionEntry): Promise<HarnessCommandResult>;
};

export function createSessionState(input: {
  session: SessionTranscript;
  sessionStore: SessionStore;
  tools: readonly HarnessTool[];
  toolDefinitions: readonly ProviderToolDefinition[];
  model: () => string | undefined;
  contextWindow: () => number;
  emit: (event: HarnessEvent) => void;
  markFailed: (error: HarnessError) => void;
}): SessionState {
  const messages = [...input.session.messages];
  let checkpoint = latestCompactionCheckpoint(input.session.records);
  let usageBaseline: UsageBaseline | undefined = restoreUsageBaseline(input.session.records);
  let sessionTotalTokens = sumUsage(input.session.records, (usage) => usage.inputTokens + usage.outputTokens);
  let sessionInputTokens = sumUsage(input.session.records, (usage) => usage.inputTokens);
  let sessionCachedInputTokens = sumUsage(
    input.session.records,
    (usage) => usage.cachedInputTokens ?? 0,
  );
  const model = input.model();
  if (
    usageBaseline?.model !== undefined &&
    model !== undefined &&
    usageBaseline.model !== model
  ) {
    usageBaseline = undefined;
  }

  const failPersist = (message: string): HarnessCommandResult => {
    const error: HarnessError = { code: "HARNESS_SESSION", message };
    input.markFailed(error);
    return { ok: false, error };
  };

  const estimateCurrentContext = (): number => {
    if (usageBaseline !== undefined) {
      return (
        usageBaseline.inputTokens +
        usageBaseline.outputTokens +
        estimateMessagesTokens(
          messages.slice(usageBaseline.messageCount + 1),
        )
      );
    }
    if (messages.length === 0) {
      return 0;
    }
    return (
      estimateTextTokens(buildSystemPrompt(input.tools, input.session.header.cwd)) +
      estimateToolsTokens(input.toolDefinitions) +
      estimateMessagesTokens(modelContextMessages(messages, checkpoint))
    );
  };

  return {
    messages: () => messages,
    checkpoint: () => checkpoint,
    usageBaseline: () => usageBaseline,
    sessionTotalTokens: () => sessionTotalTokens,
    sessionInputTokens: () => sessionInputTokens,
    sessionCachedInputTokens: () => sessionCachedInputTokens,
    estimateCurrentContext,
    clearUsageBaseline() {
      usageBaseline = undefined;
    },
    setUsageBaseline(baseline) {
      usageBaseline = baseline;
    },
    async appendMessage(message) {
      const result = await input.sessionStore.appendMessage(
        input.session.header.id,
        message,
      );
      if (!result.ok) {
        return failPersist(result.error.message);
      }
      messages.push(message);
      return { ok: true };
    },
    async appendProviderUsage(usage, modelConfiguration) {
      if (usage === undefined) {
        return { ok: true };
      }
      const result = await input.sessionStore.appendUsage(
        input.session.header.id,
        usage,
        modelConfiguration,
      );
      if (!result.ok) {
        return failPersist(result.error.message);
      }
      sessionTotalTokens += usage.inputTokens + usage.outputTokens;
      sessionInputTokens += usage.inputTokens;
      sessionCachedInputTokens += usage.cachedInputTokens ?? 0;
      input.emit({
        type: "session-usage-updated",
        sessionTotalTokens,
        sessionInputTokens,
        sessionCachedInputTokens,
        contextWindow: input.contextWindow(),
        contextTokens: estimateCurrentContext(),
      });
      return { ok: true };
    },
    async commitCompaction(entry) {
      const appended = await input.sessionStore.appendCompaction(
        input.session.header.id,
        entry,
      );
      if (!appended.ok) {
        return { ok: false, error: { code: "HARNESS_SESSION", message: appended.error.message } };
      }
      checkpoint = entry;
      usageBaseline = undefined;
      return { ok: true };
    },
  };
}

function sumUsage(
  records: readonly SessionRecord[],
  read: (usage: ProviderUsage) => number,
): number {
  return records.reduce(
    (total, record) => (record.type === "usage" ? total + read(record.usage) : total),
    0,
  );
}
