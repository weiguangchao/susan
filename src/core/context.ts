import type {
  CompletionMessage,
  ProviderToolDefinition,
} from "./provider.js";
import type {
  SessionCompactionRecord,
  SessionRecord,
} from "./session.js";

export const RECENT_TAIL_TARGET_TOKENS = 20_000;

export const COMPACTION_SUMMARY_PROMPT = `Update the rolling Session summary from the previous summary and the newly compacted transcript.

Use exactly these headings when they contain known facts: Goal, Constraints, Progress, Key Decisions, Next Steps, Critical Context, Files. Omit empty headings. Preserve concrete paths, identifiers, errors, decisions, and unfinished work. Do not invent facts.`;

export const MODEL_CONTEXT_SUMMARY_PREFIX = "Session summary:\n";

export function estimateTextTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 3);
}

export function estimateMessageTokens(message: CompletionMessage): number {
  if (message.role === "system" || message.role === "user") {
    return estimateTextTokens(message.content);
  }
  if (message.role === "tool") {
    return estimateTextTokens(message.toolCallId) +
      estimateTextTokens(JSON.stringify(message.content));
  }
  return estimateTextTokens(message.content ?? "") +
    (message.toolCalls ?? []).reduce(
      (total, call) =>
        total +
        estimateTextTokens(call.id) +
        estimateTextTokens(call.name) +
        estimateTextTokens(JSON.stringify(call.arguments)),
      0,
    );
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
): SessionCompactionRecord | undefined {
  return records.findLast(
    (record): record is SessionCompactionRecord => record.type === "compaction",
  );
}

export function modelContextMessages(
  messages: readonly CompletionMessage[],
  checkpoint: SessionCompactionRecord | undefined,
): CompletionMessage[] {
  if (checkpoint === undefined) {
    return [...messages];
  }
  return [
    {
      role: "user",
      content: `${MODEL_CONTEXT_SUMMARY_PREFIX}${checkpoint.summary}`,
    },
    ...messages.slice(checkpoint.firstKeptMessageIndex),
  ];
}

function canStartAt(
  messages: readonly CompletionMessage[],
  index: number,
): boolean {
  const first = messages[index];
  if (first === undefined || first.role === "tool") {
    return false;
  }
  if (first.role !== "assistant" || first.toolCalls === undefined) {
    return true;
  }
  const retainedToolResultIds = new Set(
    messages
      .slice(index + 1)
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId),
  );
  return first.toolCalls.every((call) => retainedToolResultIds.has(call.id));
}

export function selectRecentTailStart(
  messages: readonly CompletionMessage[],
  minimumStart: number,
  targetTokens = RECENT_TAIL_TARGET_TOKENS,
): number {
  if (messages.length === 0) {
    return 0;
  }
  const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
  if (lastUserIndex < minimumStart) {
    return minimumStart;
  }

  let start = lastUserIndex;
  const userStarts = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => message.role === "user" && index >= minimumStart)
    .map(({ index }) => index);

  for (let position = userStarts.length - 2; position >= 0; position -= 1) {
    const candidate = userStarts[position]!;
    if (estimateMessagesTokens(messages.slice(candidate)) <= targetTokens) {
      start = candidate;
      continue;
    }

    const nextUser = userStarts[position + 1] ?? messages.length;
    for (let index = candidate + 1; index < nextUser; index += 1) {
      if (
        canStartAt(messages, index) &&
        estimateMessagesTokens(messages.slice(index)) <= targetTokens
      ) {
        start = index;
        break;
      }
    }
    break;
  }
  return start;
}

export function serializeCompactionInput(
  previousSummary: string | undefined,
  messages: readonly CompletionMessage[],
): string {
  const lines = [COMPACTION_SUMMARY_PROMPT];
  if (previousSummary !== undefined) {
    lines.push(`Previous summary:\n${previousSummary}`);
  }
  lines.push(
    "Newly compacted transcript:",
    ...messages.map((message) => {
      if (message.role === "user") {
        return `[User]\n${message.content}`;
      }
      if (message.role === "system") {
        return `[System]\n${message.content}`;
      }
      if (message.role === "tool") {
        return `[Tool result ${message.toolCallId}]\n${JSON.stringify(message.content)}`;
      }
      const parts = ["[Assistant]"];
      if (message.content !== undefined) {
        parts.push(message.content);
      }
      if (message.reasoning !== undefined) {
        parts.push(`[Assistant reasoning]\n${message.reasoning}`);
      }
      for (const call of message.toolCalls ?? []) {
        parts.push(
          `[Assistant tool call ${call.id} ${call.name}]\n${JSON.stringify(call.arguments)}`,
        );
      }
      return parts.join("\n");
    }),
  );
  return lines.join("\n\n");
}
