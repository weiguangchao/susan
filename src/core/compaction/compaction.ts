// Ported from Pi 400d690 (MIT); linear Session and Provider adapters are Susan-specific.
import { estimateMessageTokens, messageEntryId, compactionStartIndex, compactionEndIndex } from "../context";
import type { CompletionMessage, ProviderFailure, ProviderResponse } from "../provider";
import type { CompactionEntry } from "../session";
import { createFileOps, extractFileOpsFromMessage, type FileOperations, serializeConversation } from "./utils";
import { SUMMARIZATION_PROMPT, UPDATE_SUMMARIZATION_PROMPT, TURN_PREFIX_SUMMARIZATION_PROMPT } from "./prompts";

export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true, reserveTokens: 16384, keepRecentTokens: 20000,
};
export function shouldCompact(tokens: number, window: number, settings: CompactionSettings): boolean {
  return settings.enabled && tokens > window - settings.reserveTokens;
}
export interface CutPointResult {
  firstKeptEntryIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}
export function findTurnStartIndex(messages: readonly CompletionMessage[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}
export function findCutPoint(messages: readonly CompletionMessage[], startIndex: number, endIndex: number, keepRecentTokens: number): CutPointResult {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    if (messages[i].role === "user" || messages[i].role === "assistant") cutPoints.push(i);
  }
  if (cutPoints.length === 0) return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  let accumulatedTokens = 0;
  let cutIndex = cutPoints[0];
  for (let i = endIndex - 1; i >= startIndex; i--) {
    accumulatedTokens += estimateMessageTokens(messages[i]);
    if (accumulatedTokens >= keepRecentTokens) {
      for (const candidate of cutPoints) {
        if (candidate >= i) { cutIndex = candidate; break; }
      }
      break;
    }
  }
  const isUserMessage = messages[cutIndex].role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(messages, cutIndex, startIndex);
  return { firstKeptEntryIndex: cutIndex, turnStartIndex, isSplitTurn: !isUserMessage && turnStartIndex !== -1 };
}
export interface CompactionPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: CompletionMessage[];
  turnPrefixMessages: CompletionMessage[];
  retainedTail: CompletionMessage[];
  isSplitTurn: boolean;
  previousSummary?: string;
  fileOps: FileOperations;
  settings: CompactionSettings;
}
export function prepareCompaction(messages: readonly CompletionMessage[], checkpoint: CompactionEntry | undefined, settings: CompactionSettings): CompactionPreparation | undefined {
  if (messages.length === 0 || (checkpoint && compactionEndIndex(checkpoint) === messages.length)) return undefined;
  const start = checkpoint ? compactionStartIndex(checkpoint) : 0;
  const compactable = checkpoint
    ? [...checkpoint.retainedTail, ...messages.slice(compactionEndIndex(checkpoint))]
    : [...messages];
  const cut = findCutPoint(compactable, 0, compactable.length, settings.keepRecentTokens);
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const messagesToSummarize = compactable.slice(0, historyEnd);
  const turnPrefixMessages = cut.isSplitTurn ? compactable.slice(cut.turnStartIndex, cut.firstKeptEntryIndex) : [];
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;
  const fileOps = createFileOps();
  for (const path of checkpoint?.details.readFiles ?? []) fileOps.read.add(path);
  for (const path of checkpoint?.details.modifiedFiles ?? []) fileOps.edited.add(path);
  for (const msg of [...messagesToSummarize, ...turnPrefixMessages]) extractFileOpsFromMessage(msg, fileOps);
  return {
    firstKeptEntryId: messageEntryId(start + cut.firstKeptEntryIndex),
    messagesToSummarize, turnPrefixMessages,
    retainedTail: compactable.slice(cut.firstKeptEntryIndex),
    isSplitTurn: cut.isSplitTurn, previousSummary: checkpoint?.summary, fileOps, settings,
  };
}
export function buildSummaryPrompt(messages: readonly CompletionMessage[], previousSummary?: string, customInstructions?: string): string {
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) basePrompt += `\n\nAdditional focus: ${customInstructions}`;
  let promptText = `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n`;
  if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  return promptText + basePrompt;
}
export function buildTurnPrefixPrompt(messages: readonly CompletionMessage[]): string {
  return `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
}
export function getSummarizationFailure(response: ProviderResponse | ProviderFailure, label: string): string | undefined {
  if ("code" in response) {
    if (response.code === "PROVIDER_INCOMPLETE") return `${label} failed: generation hit the token cap and the summary is incomplete`;
    return `${label} failed: ${response.message || "Unknown error"}`;
  }
  if (response.assistant.toolCalls?.length) return `${label} attempted to call a tool`;
  return undefined;
}
