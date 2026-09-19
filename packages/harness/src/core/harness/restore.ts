import type { CompletionMessage, ProviderToolCall } from "../provider";
import type { SessionRecord } from "../session";
import type { PendingAgentLoop } from "./types";

export type UsageBaseline = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly messageCount: number;
  readonly model?: string;
};

export type RestoredToolBatch = {
  readonly remaining: readonly ProviderToolCall[];
};

export function restoredPending(
  messages: readonly CompletionMessage[],
): PendingAgentLoop | null {
  const last = messages.at(-1);
  if (
    last === undefined ||
    (last.role === "assistant" &&
      (last.toolCalls === undefined || last.toolCalls.length === 0))
  ) {
    return null;
  }
  return { reason: "restored" };
}

export function restoredToolBatch(
  messages: readonly CompletionMessage[],
): RestoredToolBatch | undefined {
  const lastUserIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  let assistantIndex = -1;
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      (message.toolCalls?.length ?? 0) > 0
    ) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) {
    return undefined;
  }
  const assistant = messages[assistantIndex];
  if (assistant?.role !== "assistant" || assistant.toolCalls === undefined) {
    return undefined;
  }
  const completed = new Set(
    messages
      .slice(assistantIndex + 1)
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId),
  );
  const remaining = assistant.toolCalls.filter(
    (toolCall) => !completed.has(toolCall.id),
  );
  return remaining.length === 0 ? undefined : { remaining };
}

export function restoreUsageBaseline(
  records: readonly SessionRecord[],
): UsageBaseline | undefined {
  let baseline: UsageBaseline | undefined;
  let messageCount = 0;
  for (const record of records) {
    if (record.type === "message") {
      messageCount += 1;
    } else if (record.type === "usage") {
      baseline = {
        ...(record.model !== undefined ? { model: record.model } : {}),
        inputTokens: record.usage.inputTokens,
        outputTokens: record.usage.outputTokens,
        messageCount,
      };
    } else if (record.type === "compaction") {
      baseline = undefined;
    }
  }
  return baseline;
}
