import type {
  CompletionMessage,
  ProviderToolDefinition,
} from "./provider.js";
import type {
  CompactionEntry,
  SessionRecord,
} from "./session.js";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

// Pi's character heuristic, including thinking and a fixed image estimate.
export function estimateTextTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
export function estimateMessageTokens(message: CompletionMessage): number {
  if (message.role === "system") return 0;
  if (message.role === "user") return estimateTextTokens(message.content);
  if (message.role === "tool") {
    return Math.ceil(message.content.reduce((chars, b) => chars + (b.type === "image" ? 4800 : b.text.length), 0) / 4);
  }
  return Math.ceil(((message.content?.length ?? 0) + (message.reasoning?.length ?? 0) +
    (message.toolCalls ?? []).reduce((chars, call) => chars + call.name.length + JSON.stringify(call.arguments).length, 0)) / 4);
}

export function estimateMessagesTokens(
  messages: readonly CompletionMessage[],
): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );
}

export function estimateToolsTokens(
  tools: readonly ProviderToolDefinition[],
): number {
  return tools.reduce(
    (total, tool) => total + estimateTextTokens(JSON.stringify(tool)),
    0,
  );
}

export function latestCompactionCheckpoint(
  records: readonly SessionRecord[],
): CompactionEntry | undefined {
  return records.findLast(
    (record): record is CompactionEntry => record.type === "compaction",
  );
}

export function modelContextMessages(
  messages: readonly CompletionMessage[],
  checkpoint: CompactionEntry | undefined,
): CompletionMessage[] {
  if (checkpoint === undefined) {
    return [...messages];
  }
  return [
    {
      role: "user",
      content: `${COMPACTION_SUMMARY_PREFIX}${checkpoint.summary}${COMPACTION_SUMMARY_SUFFIX}`,
    },
    ...checkpoint.retainedTail,
    ...messages.slice(compactionEndIndex(checkpoint)),
  ];
}

// Linear append-only transcripts give message entries a stable ordinal identity.
export function messageEntryId(index: number): string { return `message:${index}`; }
export function compactionStartIndex(entry: CompactionEntry): number {
  return Number(entry.firstKeptEntryId.slice("message:".length));
}
export function compactionEndIndex(entry: CompactionEntry): number {
  return compactionStartIndex(entry) + entry.retainedTail.length;
}
