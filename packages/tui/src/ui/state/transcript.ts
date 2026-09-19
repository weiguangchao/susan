import type {
  HarnessSnapshot,
  PendingAgentLoop,
  ProviderFailure,
  ToolResult,
} from "@weiguangchao/susan-harness";
import {
  createCompletedToolCard,
  createToolCard,
  type TuiToolCard,
} from "../tool-ledger";
import type { TuiCompletedOutput, TuiMessage, TuiState } from "./types";

export function isEmptySession(
  snapshot: Pick<HarnessSnapshot, "messages">,
): boolean {
  return snapshot.messages.length === 0;
}

export function toolsFromMessages(
  messages: HarnessSnapshot["messages"],
  sessionCwd: string,
): readonly TuiToolCard[] {
  const cards: TuiToolCard[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || message.toolCalls === undefined) {
      continue;
    }
    const results = new Map(
      messages
        .slice(index + 1)
        .filter((entry) => entry.role === "tool")
        .map((entry) => [
          entry.toolCallId,
          {
            content: entry.content,
            ...(entry.details === undefined ? {} : { details: entry.details }),
          } as ToolResult,
        ]),
    );
    const errorIds = new Set(
      messages
        .slice(index + 1)
        .filter((entry) => entry.role === "tool")
        .filter((entry) => entry.isError === true)
        .map((entry) => entry.toolCallId),
    );
    for (const toolCall of message.toolCalls) {
      const result = results.get(toolCall.id);
      cards.push(
        result === undefined
          ? createToolCard(toolCall, "requested", sessionCwd)
          : createCompletedToolCard(
              toolCall,
              result,
              errorIds.has(toolCall.id),
              sessionCwd,
            ),
      );
    }
  }
  return cards;
}

export function messageToTuiMessages(
  message: HarnessSnapshot["messages"][number],
): TuiMessage[] {
  if (message.role === "user") {
    return [{ kind: "user", text: message.content }];
  }
  if (message.role === "assistant") {
    return [
      ...(message.reasoning === undefined
        ? []
        : [{ kind: "reasoning" as const, text: message.reasoning }]),
      ...(message.content === undefined
        ? []
        : [{ kind: "assistant" as const, text: message.content }]),
    ];
  }
  return [];
}

export function streamMessages(
  stream: TuiState["stream"],
): readonly TuiMessage[] {
  if (stream === null) return [];
  return [
    ...(stream.reasoning === ""
      ? []
      : [
          {
            kind: "reasoning" as const,
            text: stream.reasoning,
            ...(stream.reasoningStartedAt !== null &&
            stream.reasoningEndedAt !== null
              ? {
                  durationMs: Math.max(
                    0,
                    stream.reasoningEndedAt - stream.reasoningStartedAt,
                  ),
                }
              : {}),
          },
        ]),
    ...(stream.text === ""
      ? []
      : [{ kind: "assistant" as const, text: stream.text }]),
  ];
}

export function completedOutputFromMessages(
  messages: HarnessSnapshot["messages"],
  tools: readonly TuiToolCard[],
): readonly TuiCompletedOutput[] {
  const toolById = new Map(tools.map((tool) => [tool.id, tool]));
  const output: TuiCompletedOutput[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    for (const [partIndex, tuiMessage] of messageToTuiMessages(
      message,
    ).entries()) {
      output.push({
        id: `message:${messageIndex}:${partIndex}`,
        kind: "message",
        message: tuiMessage,
      });
    }
    if (message.role !== "assistant") continue;
    const batch = (message.toolCalls ?? [])
      .map((toolCall) => toolById.get(toolCall.id))
      .filter(
        (tool): tool is TuiToolCard =>
          tool !== undefined && isTerminalTool(tool),
      );
    if (batch.length > 0) {
      output.push({
        id: `tool-batch:${messageIndex}`,
        kind: "tool-batch",
        tools: batch,
      });
    }
  }
  return output;
}

export function appendCompletedMessages(
  output: readonly TuiCompletedOutput[],
  messages: readonly TuiMessage[],
): readonly TuiCompletedOutput[] {
  return [
    ...output,
    ...messages.map((message, index) => ({
      id: `message:live:${output.length + index}`,
      kind: "message" as const,
      message,
    })),
  ];
}

export function appendCompletedToolBatch(
  output: readonly TuiCompletedOutput[],
  tools: readonly TuiToolCard[],
): readonly TuiCompletedOutput[] {
  const completedIds = new Set(
    output.flatMap((item) =>
      item.kind === "tool-batch" ? item.tools.map((tool) => tool.id) : [],
    ),
  );
  const pendingTools = tools.filter((tool) => !completedIds.has(tool.id));
  if (pendingTools.length === 0) return output;
  return [
    ...output,
    {
      id: `tool-batch:live:${output.length}`,
      kind: "tool-batch",
      tools: pendingTools,
    },
  ];
}

export function isTerminalTool(tool: TuiToolCard): boolean {
  return (
    tool.status === "completed" ||
    tool.status === "failed" ||
    tool.status === "interrupted"
  );
}

export function pendingNotice(pending: PendingAgentLoop): string {
  if (pending.reason === "restored") {
    return "上次响应未完成（Pending Agent Loop）";
  }
  if (pending.reason === "interrupted" || pending.reason === "user-interrupt") {
    return "响应未完成（Interrupted Response / Pending Agent Loop）";
  }
  return pending.failure === undefined
    ? "上次响应未完成（Pending Agent Loop）"
    : formatProviderFailure(pending.failure);
}

export function formatProviderFailure(failure: ProviderFailure): string {
  return [
    failure.httpStatus === undefined ? failure.code : `${failure.httpStatus}`,
    failure.message,
    ...(failure.requestId === undefined
      ? []
      : [`request_id: ${failure.requestId}`]),
  ].join(" · ");
}
