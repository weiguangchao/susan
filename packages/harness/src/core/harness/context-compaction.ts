import {
  shouldCompact,
  prepareCompaction,
  buildSummaryPrompt,
  buildTurnPrefixPrompt,
  getSummarizationFailure,
  type CompactionSettings,
} from "../compaction/compaction";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../compaction/prompts";
import { computeFileLists, formatFileOperations } from "../compaction/utils";
import { retryAssistantCall } from "../compaction/retry";
import type {
  ModelInput,
  ProviderClient,
  ProviderRequest,
  ProviderResponse,
  ProviderUsage,
  ReasoningEffort,
} from "../provider";
import type { CompactionEntry } from "../session";
import type { SessionState } from "./session-state";
import type { HarnessClock, HarnessCommandResult, HarnessEvent } from "./types";

export type CompactContext = (
  force?: boolean,
  customInstructions?: string,
) => Promise<HarnessCommandResult>;

type CompactSession = Pick<
  SessionState,
  "estimateCurrentContext" | "messages" | "checkpoint" | "appendProviderUsage" | "commitCompaction"
>;

export function createCompactContext(input: {
  sessionState: CompactSession;
  provider: () => ProviderClient | undefined;
  model: () => string | undefined;
  modelInput: () => ModelInput;
  reasoningEffort: () => ReasoningEffort | undefined;
  maxOutputTokens: () => number;
  contextWindow: () => number;
  signal: () => AbortSignal | undefined;
  compactionSettings: CompactionSettings;
  clock: HarnessClock;
  emit: (event: HarnessEvent) => void;
}): CompactContext {
  const { sessionState, compactionSettings } = input;

  return async (force = false, customInstructions?: string): Promise<HarnessCommandResult> => {
    const tokensBefore = sessionState.estimateCurrentContext();
    if (!force && !shouldCompact(tokensBefore, input.contextWindow(), compactionSettings)) return { ok: true };
    if (input.signal()?.aborted) return { ok: false, error: { code: "HARNESS_ABORTED", message: "Compaction aborted" } };
    const preparation = prepareCompaction(sessionState.messages(), sessionState.checkpoint(), compactionSettings);
    // Pi skips automatic compaction when there is nothing eligible to summarize.
    if (!preparation) return force
      ? { ok: false, error: { code: "HARNESS_COMPACTION", message: "Nothing to compact" } }
      : { ok: true };
    let summaryUsage: ProviderUsage | undefined;
    const summarize = async (prompt: string, factor: number, label: string): Promise<string> => {
      const request: ProviderRequest = {
        model: input.model()!, modelInput: input.modelInput(), reasoningEffort: input.reasoningEffort(),
        maxTokens: Math.min(Math.floor(factor * compactionSettings.reserveTokens), input.maxOutputTokens() > 0 ? input.maxOutputTokens() : Infinity),
        messages: [{ role: "system", content: SUMMARIZATION_SYSTEM_PROMPT }, { role: "user", content: prompt }],
      };
      const signal = input.signal() ?? new AbortController().signal;
      const response = await retryAssistantCall(async () => {
        if (signal.aborted) return { code: "PROVIDER_ABORT", message: "Compaction aborted", hadSemanticOutput: false };
        try { return await input.provider()!.complete(request, signal); }
        catch (error) { return { code: signal.aborted ? "PROVIDER_ABORT" : "PROVIDER_NETWORK", message: error instanceof Error ? error.message : "Network error", hadSemanticOutput: false }; }
      }, signal, input.clock, (retry, delayMs, failure) => input.emit({ type: "provider-retrying", retry, maxRetries: 2, delayMs, failure }));
      if (signal.aborted || ("code" in response && response.code === "PROVIDER_ABORT")) throw new Error("Compaction aborted");
      if (!("code" in response) && response.usage) {
        const appended = await sessionState.appendProviderUsage(response.usage, { model: input.model()!, reasoningEffort: input.reasoningEffort()! });
        if (!appended.ok) throw new Error(appended.error.message);
        const u = response.usage;
        summaryUsage = {
          inputTokens: (summaryUsage?.inputTokens ?? 0) + u.inputTokens,
          outputTokens: (summaryUsage?.outputTokens ?? 0) + u.outputTokens,
          totalTokens: (summaryUsage?.totalTokens ?? 0) + u.totalTokens,
          ...((summaryUsage?.cachedInputTokens !== undefined || u.cachedInputTokens !== undefined)
            ? { cachedInputTokens: (summaryUsage?.cachedInputTokens ?? 0) + (u.cachedInputTokens ?? 0) } : {}),
        };
      }
      const failure = getSummarizationFailure(response, label);
      if (failure) throw new Error(failure);
      return (response as ProviderResponse).assistant.content ?? "";
    };
    try {
      let summary: string;
      if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
        const historyText = preparation.messagesToSummarize.length > 0
          ? await summarize(buildSummaryPrompt(preparation.messagesToSummarize, preparation.previousSummary, customInstructions), 0.8, "Summarization")
          : preparation.previousSummary ?? "No prior history.";
        const prefix = await summarize(buildTurnPrefixPrompt(preparation.turnPrefixMessages), 0.5, "Turn prefix summarization");
        summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${prefix}`;
      } else {
        summary = await summarize(buildSummaryPrompt(preparation.messagesToSummarize, preparation.previousSummary, customInstructions), 0.8, "Summarization");
      }
      const details = computeFileLists(preparation.fileOps);
      summary += formatFileOperations(details.readFiles, details.modifiedFiles);
      if (input.signal()?.aborted) throw new Error("Compaction aborted");
      const candidate: CompactionEntry = {
        type: "compaction", summary, firstKeptEntryId: preparation.firstKeptEntryId,
        retainedTail: preparation.retainedTail, details, tokensBefore,
        ...(summaryUsage ? { usage: summaryUsage } : {}), timestamp: new Date().toISOString(),
      };
      const appended = await sessionState.commitCompaction(candidate);
      if (!appended.ok) return appended;
      const tokensAfterEstimate = sessionState.estimateCurrentContext();
      input.emit({ type: "context-compacted", tokensBefore, tokensAfterEstimate, contextTokens: tokensAfterEstimate });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: { code: input.signal()?.aborted ? "HARNESS_ABORTED" : "HARNESS_COMPACTION", message: error instanceof Error ? error.message : "Compaction failed" } };
    }
  };
}
