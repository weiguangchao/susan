import { isJsonValue, isRecord } from "@weiguangchao/susan-core";
import type { HarnessEvent } from "@weiguangchao/susan-harness";
import {
  createCompletedToolCard,
  createToolCard,
  formatToolCallDetail,
  type TuiToolCard,
} from "../tool-ledger";
import {
  appendCompletedMessages,
  appendCompletedToolBatch,
  formatProviderFailure,
  isTerminalTool,
  streamMessages,
} from "./transcript";
import type { TuiState } from "./types";

const emptyStream = {
  text: "",
  reasoning: "",
  reasoningStartedAt: null,
  reasoningEndedAt: null,
};

export function reduceHarnessEvent(
  state: TuiState,
  event: HarnessEvent,
): TuiState {
  switch (event.type) {
    case "text-delta":
    case "reasoning-delta": {
      const stream = state.stream ?? emptyStream;
      const reasoningDelta = event.type === "reasoning-delta";
      const now = reasoningDelta ? Date.now() : null;
      return {
        ...state,
        awaitingModelAfterTools: false,
        stream: {
          text: reasoningDelta ? stream.text : stream.text + event.textDelta,
          reasoning: reasoningDelta
            ? stream.reasoning + event.textDelta
            : stream.reasoning,
          reasoningStartedAt:
            reasoningDelta && stream.reasoningStartedAt === null
              ? now
              : stream.reasoningStartedAt,
          reasoningEndedAt:
            reasoningDelta && now !== null ? now : stream.reasoningEndedAt,
        },
        retry: null,
        notice: null,
      };
    }
    case "tool-call-delta": {
      const placeholderId = `tool-call-${event.index}`;
      const existing = state.tools.find(
        (tool) =>
          tool.status === "requested" &&
          ((event.id !== undefined && tool.id === event.id) ||
            tool.id === placeholderId ||
            tool.streamIndex === event.index),
      );
      const id = event.id ?? existing?.id ?? placeholderId;
      const name = event.name ?? existing?.name ?? "tool";
      const argumentsText =
        (existing?.argumentsText ?? "") + event.argumentsDelta;
      let invocationLabel = existing?.invocationLabel ?? "";
      try {
        const arguments_: unknown = JSON.parse(argumentsText);
        if (isRecord(arguments_) && isJsonValue(arguments_)) {
          invocationLabel = formatToolCallDetail(
            { id, name, arguments: arguments_ },
            state.cwd,
          );
        }
      } catch {
        // Incomplete streamed JSON: keep the tool name until arguments are complete.
      }
      return {
        ...state,
        awaitingModelAfterTools: false,
        stream: state.stream ?? emptyStream,
        retry: null,
        tools: placeToolAtIndex(state.tools, event.index, {
          id,
          name,
          invocationLabel,
          argumentsText,
          streamIndex: event.index,
          status: "requested",
          summary: "等待执行",
          supplementalLines: [],
        }),
      };
    }
    case "tool-started": {
      const completedMessages = streamMessages(state.stream);
      return {
        ...state,
        awaitingModelAfterTools: true,
        messages: [...state.messages, ...completedMessages],
        completedOutput: appendCompletedMessages(
          state.completedOutput,
          completedMessages,
        ),
        stream: null,
        tools: updateTool(
          state.tools,
          event.toolCall.id,
          createToolCard(event.toolCall, "running", state.cwd),
        ),
      };
    }
    case "tool-completed": {
      const card = createCompletedToolCard(
        event.toolCall,
        event.result,
        event.isError,
        state.cwd,
      );
      const completedMessages = streamMessages(state.stream);
      return {
        ...state,
        awaitingModelAfterTools: true,
        messages: [...state.messages, ...completedMessages],
        completedOutput: appendCompletedToolBatch(
          appendCompletedMessages(state.completedOutput, completedMessages),
          [card],
        ),
        stream: null,
        tools: updateTool(state.tools, event.toolCall.id, card),
      };
    }
    case "tool-batch-completed": {
      const ids = new Set(event.toolCalls.map((toolCall) => toolCall.id));
      return {
        ...state,
        awaitingModelAfterTools: true,
        completedOutput: appendCompletedToolBatch(
          state.completedOutput,
          state.tools.filter((tool) => ids.has(tool.id) && isTerminalTool(tool)),
        ),
      };
    }
    case "context-compacted":
      return {
        ...state,
        contextTokens: event.contextTokens,
        notice: `上下文已压缩 · ${event.tokensBefore} → ${event.tokensAfterEstimate} est.`,
      };
    case "session-usage-updated":
      return {
        ...state,
        contextTokens: event.contextTokens,
        sessionTotalTokens: event.sessionTotalTokens,
        sessionInputTokens: event.sessionInputTokens,
        sessionCachedInputTokens: event.sessionCachedInputTokens,
        contextWindow: event.contextWindow,
      };
    case "compaction-failed": {
      const message = { kind: "error" as const, text: event.message };
      return {
        ...state,
        messages: [...state.messages, message],
        completedOutput: appendCompletedMessages(state.completedOutput, [message]),
      };
    }
    case "provider-retrying":
      return {
        ...state,
        awaitingModelAfterTools: false,
        retry: {
          reason: formatProviderFailure(event.failure),
          retry: event.retry,
          maxRetries: event.maxRetries,
          delayMs: event.delayMs,
          startedAt: Date.now(),
        },
        notice: null,
      };
    case "agent-loop-completed": {
      const completedMessages = streamMessages(state.stream);
      return {
        ...state,
        awaitingModelAfterTools: false,
        messages: [...state.messages, ...completedMessages],
        completedOutput: appendCompletedMessages(
          state.completedOutput,
          completedMessages,
        ),
        stream: null,
        retry: null,
        failure: null,
        pending: null,
        status: "idle",
        notice: null,
      };
    }
    case "provider-failed":
      return {
        ...state,
        awaitingModelAfterTools: false,
        retry: null,
        failure: event.failure,
        pending: { reason: "provider-failure", failure: event.failure },
        status: "pending",
      };
    case "interrupted-response": {
      const message = {
        kind: "interrupted" as const,
        text: event.response.content ?? event.response.reasoning ?? "",
      };
      return {
        ...state,
        awaitingModelAfterTools: false,
        messages: [...state.messages, message],
        completedOutput: appendCompletedMessages(state.completedOutput, [message]),
        stream: null,
        retry: null,
        failure: event.failure,
        pending: { reason: "interrupted", failure: event.failure },
        status: "pending",
      };
    }
    case "agent-loop-interrupted": {
      const interruptedTools = state.tools.map((tool) =>
        tool.status === "running"
          ? { ...tool, status: "interrupted" as const, summary: "已中断" }
          : tool,
      );
      return {
        ...state,
        awaitingModelAfterTools: false,
        stream: null,
        retry: null,
        tools: interruptedTools,
        completedOutput: appendCompletedToolBatch(
          state.completedOutput,
          interruptedTools.filter(isTerminalTool),
        ),
        pending: { reason: "user-interrupt" },
        status: "pending",
        notice: "Agent Loop 已中断",
      };
    }
    case "harness-failed": {
      const message = { kind: "error" as const, text: event.error.message };
      return {
        ...state,
        awaitingModelAfterTools: false,
        messages: [...state.messages, message],
        completedOutput: appendCompletedMessages(state.completedOutput, [message]),
      };
    }
    default:
      return state;
  }
}

function placeToolAtIndex(
  tools: readonly TuiToolCard[],
  index: number,
  next: TuiToolCard,
): readonly TuiToolCard[] {
  const placeholderId = `tool-call-${index}`;
  const placeholderIndex = tools.findIndex((tool) => tool.id === placeholderId);
  if (placeholderIndex !== -1) {
    return tools.flatMap((tool) => {
      if (tool.id === placeholderId) return [next];
      return tool.id === next.id ? [] : [tool];
    });
  }
  const existingIndex = tools.findIndex((tool) => tool.id === next.id);
  if (existingIndex !== -1) {
    return tools.map((tool, toolIndex) =>
      toolIndex === existingIndex ? next : tool,
    );
  }
  const at = Math.min(index, tools.length);
  return [...tools.slice(0, at), next, ...tools.slice(at)];
}

function updateTool(
  tools: readonly TuiToolCard[],
  id: string,
  next: TuiToolCard,
): readonly TuiToolCard[] {
  const index = tools.findIndex((tool) => tool.id === id);
  if (index === -1) return [...tools, next];
  return tools.map((tool, toolIndex) => (toolIndex === index ? next : tool));
}
