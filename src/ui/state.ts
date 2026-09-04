import type {
  HarnessEvent,
  HarnessSnapshot,
  HarnessStatus,
  PendingAgentLoop,
  ToolResult,
} from "../core/harness.js";
import type {
  ProviderFailure,
  ProviderToolCall,
} from "../core/provider.js";
import { moveInputCursorVertically } from "./input-layout.js";

export type TuiMessage =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "interrupted"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

export type TuiToolStatus =
  | "waiting-approval"
  | "running"
  | "completed"
  | "denied"
  | "failed"
  | "interrupted";

export type TuiToolCard = {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly status: TuiToolStatus;
  readonly summary: string;
  readonly preview?: readonly string[];
};

export type TuiApproval = {
  readonly approvalId: string;
  readonly toolCall: ProviderToolCall;
};

export type TuiRetry = {
  readonly reason: string;
  readonly retry: 1 | 2;
  readonly maxRetries: 2;
  readonly delayMs: number;
  readonly startedAt: number;
};

export type TuiState = {
  readonly status: HarnessStatus;
  readonly messages: readonly TuiMessage[];
  readonly tools: readonly TuiToolCard[];
  readonly approval: TuiApproval | null;
  readonly stream: {
    readonly text: string;
    readonly reasoning: string;
  } | null;
  readonly retry: TuiRetry | null;
  readonly failure: ProviderFailure | null;
  readonly pending: PendingAgentLoop | null;
  readonly model: string;
  readonly reasoningLevel: string;
  readonly contextWindow: number;
  readonly sessionTotalTokens: number;
  readonly notice: string | null;
  readonly input: string;
  readonly inputCursor: TuiInputCursor;
  readonly inputHistory: readonly string[];
  readonly inputHistoryIndex: number;
  readonly inputHistoryActive: boolean;
};

export type TuiInputCursor = {
  readonly row: number;
  readonly column: number;
};

export type TuiInputKey = {
  readonly input: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly inputWidth?: number;
};

export type TuiInputIntent =
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "newline" }
  | { readonly type: "backspace" }
  | { readonly type: "move-cursor-up"; readonly inputWidth?: number }
  | { readonly type: "move-cursor-down"; readonly inputWidth?: number }
  | { readonly type: "move-cursor-left" }
  | { readonly type: "move-cursor-right" }
  | { readonly type: "move-cursor-to-line-start" }
  | { readonly type: "move-cursor-to-line-end" }
  | { readonly type: "history-previous" }
  | { readonly type: "history-next" }
  | { readonly type: "submit"; readonly content: string }
  | { readonly type: "clear-input" }
  | { readonly type: "clear" }
  | { readonly type: "exit" }
  | { readonly type: "interrupt" }
  | { readonly type: "approve-approval"; readonly approvalId: string }
  | { readonly type: "deny-approval"; readonly approvalId: string }
  | { readonly type: "retry" }
  | { readonly type: "new-session" }
  | { readonly type: "dismiss-failure" }
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "none" };

export type TuiSubmissionIntent =
  | { readonly type: "exit" }
  | { readonly type: "clear" }
  | { readonly type: "submit"; readonly content: string };

export type TuiAction =
  | { readonly type: "harness-event"; readonly event: HarnessEvent }
  | { readonly type: "snapshot"; readonly snapshot: HarnessSnapshot }
  | { readonly type: "input-key"; readonly key: TuiInputKey }
  | { readonly type: "input-intent"; readonly intent: TuiInputIntent }
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "clear-input" }
  | { readonly type: "new-session"; readonly snapshot: HarnessSnapshot };

const emptyStream = { text: "", reasoning: "" };

export function createTuiState(
  snapshot: HarnessSnapshot,
  globalInputHistory?: readonly string[],
): TuiState {
  const inputHistory =
    globalInputHistory ??
    snapshot.messages.flatMap((message) =>
      message.role === "user" ? [message.content] : [],
    );
  return {
    status: snapshot.status,
    messages: snapshot.messages.flatMap(messageToTuiMessages),
    tools: [],
    approval: null,
    stream: null,
    retry: null,
    failure: null,
    pending: snapshot.pending,
    model: snapshot.model,
    reasoningLevel: snapshot.reasoningLevel,
    contextWindow: snapshot.contextWindow,
    sessionTotalTokens: snapshot.sessionTotalTokens,
    notice: snapshot.pending === null ? null : pendingNotice(snapshot.pending),
    input: "",
    inputCursor: { row: 0, column: 0 },
    inputHistory,
    inputHistoryIndex: inputHistory.length,
    inputHistoryActive: false,
  };
}

export function normalizeSubmission(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function resolveSubmission(value: string): TuiSubmissionIntent {
  const content = normalizeSubmission(value);
  if (content === "/exit") {
    return { type: "exit" };
  }
  if (content === "/clear" || content === "/new") {
    return { type: "clear" };
  }
  return { type: "submit", content };
}

export function isEmptySession(
  snapshot: Pick<HarnessSnapshot, "messages">,
): boolean {
  return snapshot.messages.length === 0;
}

export function resolveInputIntent(
  state: TuiState,
  key: TuiInputKey,
): TuiInputIntent {
  if (key.ctrl && key.input === "c") {
    if (state.approval !== null) {
      return {
        type: "deny-approval",
        approvalId: state.approval.approvalId,
      };
    }
    if (state.status === "running" || state.status === "awaiting-approval") {
      return { type: "interrupt" };
    }
    if (state.input !== "") {
      return { type: "clear-input" };
    }
    return { type: "exit" };
  }

  if (key.ctrl && key.input === "j") {
    return { type: "newline" };
  }
  if (key.ctrl && key.input === "d") {
    return { type: "clear-input" };
  }
  if (key.input === "\n" && key.return !== true) {
    return { type: "newline" };
  }
  if (key.ctrl && key.input === "a") {
    return { type: "move-cursor-to-line-start" };
  }
  if (key.ctrl && key.input === "e") {
    return { type: "move-cursor-to-line-end" };
  }
  if (key.upArrow) {
    if (
      (state.input === "" || state.inputHistoryActive) &&
      state.inputHistoryIndex > 0
    ) {
      return { type: "history-previous" };
    }
    return { type: "move-cursor-up", inputWidth: key.inputWidth };
  }
  if (key.downArrow) {
    if (
      (state.input === "" || state.inputHistoryActive) &&
      state.inputHistoryIndex < state.inputHistory.length
    ) {
      return { type: "history-next" };
    }
    return { type: "move-cursor-down", inputWidth: key.inputWidth };
  }
  if (key.leftArrow) {
    return { type: "move-cursor-left" };
  }
  if (key.rightArrow) {
    return { type: "move-cursor-right" };
  }

  if (state.approval !== null) {
    if (key.return) {
      return {
        type: "approve-approval",
        approvalId: state.approval.approvalId,
      };
    }
    if (key.escape) {
      return {
        type: "deny-approval",
        approvalId: state.approval.approvalId,
      };
    }
    return { type: "none" };
  }

  if (key.escape && state.failure !== null) {
    return { type: "dismiss-failure" };
  }

  if (state.status === "running" || state.status === "awaiting-approval") {
    if (key.return) {
      return { type: "notice", message: "生成中 · Ctrl+C 可中断" };
    }
    if (key.backspace) {
      return { type: "backspace" };
    }
    return { type: "insert", text: key.input };
  }

  if (state.status === "pending") {
    if (state.input === "") {
      if (key.input === "r") {
        return { type: "retry" };
      }
      if (key.input === "n") {
        return { type: "new-session" };
      }
      if (key.return && state.failure !== null) {
        return { type: "retry" };
      }
      if (key.return) {
        return {
          type: "notice",
          message: "Pending Agent Loop · r 重试 · n 新对话",
        };
      }
    }
    if (key.backspace) {
      return { type: "backspace" };
    }
    if (key.return) {
      return {
        type: "notice",
        message: "Pending Agent Loop · 清空输入后 r 重试 / n 新对话",
      };
    }
    return { type: "insert", text: key.input };
  }

  if (key.backspace) {
    return { type: "backspace" };
  }
  if (key.return) {
    const submission = resolveSubmission(state.input);
    if (submission.type === "submit" && submission.content.length === 0) {
      return { type: "none" };
    }
    return submission;
  }
  if (key.input === "") {
    return { type: "none" };
  }
  return { type: "insert", text: key.input };
}

export function reduceTuiState(
  state: TuiState,
  action: TuiAction,
): TuiState {
  switch (action.type) {
    case "harness-event":
      return reduceHarnessEvent(state, action.event);
    case "snapshot":
      return {
        ...state,
        status: action.snapshot.status,
        pending: action.snapshot.pending,
        model: action.snapshot.model,
        reasoningLevel: action.snapshot.reasoningLevel,
        contextWindow: action.snapshot.contextWindow,
        sessionTotalTokens: action.snapshot.sessionTotalTokens,
        ...(action.snapshot.pending === null
          ? {}
          : { notice: pendingNotice(action.snapshot.pending) }),
      };
    case "input-key":
      return applyInputIntent(state, resolveInputIntent(state, action.key));
    case "input-intent":
      return applyInputIntent(state, action.intent);
    case "notice":
      return { ...state, notice: action.message };
    case "clear-input":
      return {
        ...state,
        input: "",
        inputCursor: { row: 0, column: 0 },
        inputHistoryIndex: state.inputHistory.length,
        inputHistoryActive: false,
        notice: null,
      };
    case "new-session":
      return createTuiState(action.snapshot, state.inputHistory);
    default:
      return state;
  }
}

function insertInput(state: TuiState, text: string): TuiState {
  const normalizedText = normalizeInputText(text);
  if (normalizedText === "") {
    return { ...state, notice: null };
  }

  const lines = state.input.split("\n");
  const { row, column } = state.inputCursor;
  const line = lines[row] ?? "";
  const updatedLine = `${line.slice(0, column)}${normalizedText}${line.slice(column)}`;
  const updatedLines = updatedLine.split("\n");
  const insertedLines = normalizedText.split("\n");
  const insertedLastLineLength = insertedLines[insertedLines.length - 1]?.length ?? 0;
  lines.splice(row, 1, ...updatedLines);

  return {
    ...state,
    input: lines.join("\n"),
    inputCursor: {
      row: row + updatedLines.length - 1,
      column:
        insertedLines.length === 1
          ? column + insertedLastLineLength
        : insertedLastLineLength,
    },
    inputHistoryActive: false,
    notice: null,
  };
}

function normalizeInputText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function backspaceInput(state: TuiState): TuiState {
  const lines = state.input.split("\n");
  const { row, column } = state.inputCursor;

  if (row === 0 && column === 0) {
    return state;
  }
  if (column > 0) {
    lines[row] =
      (lines[row] ?? "").slice(0, column - 1) +
      (lines[row] ?? "").slice(column);
    return {
      ...state,
    input: lines.join("\n"),
    inputCursor: { row, column: column - 1 },
    inputHistoryActive: false,
      notice: null,
    };
  }

  const previousLine = lines[row - 1] ?? "";
  const currentLine = lines[row] ?? "";
  lines.splice(row - 1, 2, `${previousLine}${currentLine}`);
  return {
    ...state,
    input: lines.join("\n"),
    inputCursor: { row: row - 1, column: previousLine.length },
    inputHistoryActive: false,
    notice: null,
  };
}

function moveCursorUp(state: TuiState, inputWidth?: number): TuiInputCursor {
  if (inputWidth !== undefined) {
    return moveInputCursorVertically(
      state.input,
      state.inputCursor,
      inputWidth,
      -1,
    );
  }
  if (state.inputCursor.row === 0) {
    return { row: 0, column: 0 };
  }
  const row = state.inputCursor.row - 1;
  return {
    row,
    column: Math.min(
      state.inputCursor.column,
      state.input.split("\n")[row]?.length ?? 0,
    ),
  };
}

function moveCursorDown(state: TuiState, inputWidth?: number): TuiInputCursor {
  if (inputWidth !== undefined) {
    return moveInputCursorVertically(
      state.input,
      state.inputCursor,
      inputWidth,
      1,
    );
  }
  const lines = state.input.split("\n");
  if (state.inputCursor.row >= lines.length - 1) {
    return {
      row: lines.length - 1,
      column: lines[lines.length - 1]?.length ?? 0,
    };
  }
  const row = state.inputCursor.row + 1;
  return {
    row,
    column: Math.min(state.inputCursor.column, lines[row]?.length ?? 0),
  };
}

function moveCursorLeft(state: TuiState): TuiInputCursor {
  const { row, column } = state.inputCursor;
  if (column > 0) {
    return { row, column: column - 1 };
  }
  if (row === 0) {
    return { row: 0, column: 0 };
  }
  return {
    row: row - 1,
    column: state.input.split("\n")[row - 1]?.length ?? 0,
  };
}

function moveCursorRight(state: TuiState): TuiInputCursor {
  const lines = state.input.split("\n");
  const { row, column } = state.inputCursor;
  const lineLength = lines[row]?.length ?? 0;
  if (column < lineLength) {
    return { row, column: column + 1 };
  }
  if (row < lines.length - 1) {
    return { row: row + 1, column: 0 };
  }
  return { row, column: lineLength };
}

function cursorAtEnd(input: string): TuiInputCursor {
  const lines = input.split("\n");
  const row = lines.length - 1;
  return { row, column: lines[row]?.length ?? 0 };
}

function applyInputIntent(
  state: TuiState,
  intent: TuiInputIntent,
): TuiState {
  switch (intent.type) {
    case "insert":
      return insertInput(state, intent.text);
    case "newline":
      return insertInput(state, "\n");
    case "backspace":
      return backspaceInput(state);
    case "move-cursor-up":
      return {
        ...state,
        inputCursor: moveCursorUp(state, intent.inputWidth),
        notice: null,
      };
    case "move-cursor-down":
      return {
        ...state,
        inputCursor: moveCursorDown(state, intent.inputWidth),
        notice: null,
      };
    case "move-cursor-left":
      return {
        ...state,
        inputCursor: moveCursorLeft(state),
        notice: null,
      };
    case "move-cursor-right":
      return {
        ...state,
        inputCursor: moveCursorRight(state),
        notice: null,
      };
    case "move-cursor-to-line-start":
      return {
        ...state,
        inputCursor: { row: state.inputCursor.row, column: 0 },
        notice: null,
      };
    case "move-cursor-to-line-end":
      return {
        ...state,
        inputCursor: {
          row: state.inputCursor.row,
          column: state.input.split("\n")[state.inputCursor.row]?.length ?? 0,
        },
        notice: null,
      };
    case "history-previous": {
      const index = Math.max(0, state.inputHistoryIndex - 1);
      const input = state.inputHistory[index] ?? "";
      return {
        ...state,
        input,
        inputCursor: cursorAtEnd(input),
        inputHistoryIndex: index,
        inputHistoryActive: true,
        notice: null,
      };
    }
    case "history-next": {
      const index = Math.min(
        state.inputHistory.length,
        state.inputHistoryIndex + 1,
      );
      const input =
        index === state.inputHistory.length
          ? ""
          : state.inputHistory[index] ?? "";
      return {
        ...state,
        input,
        inputCursor: cursorAtEnd(input),
        inputHistoryIndex: index,
        inputHistoryActive: index !== state.inputHistory.length,
        notice: null,
      };
    }
    case "submit": {
      const inputHistory = [...state.inputHistory, intent.content];
      return {
        ...state,
        status: "running",
        messages: [
          ...state.messages,
          { kind: "user", text: intent.content },
        ],
        input: "",
        inputCursor: { row: 0, column: 0 },
        inputHistory,
        inputHistoryIndex: inputHistory.length,
        inputHistoryActive: false,
        notice: null,
        failure: null,
      };
    }
    case "clear-input":
      return {
        ...state,
        input: "",
        inputCursor: { row: 0, column: 0 },
        inputHistoryIndex: state.inputHistory.length,
        inputHistoryActive: false,
        notice: "已清空输入",
      };
    case "notice":
      return { ...state, notice: intent.message };
    case "approve-approval":
    case "deny-approval":
      const deniedToolId = state.approval?.toolCall.id;
      return {
        ...state,
        status: "running",
        approval: null,
        ...(intent.type === "deny-approval"
          ? {
              tools:
                deniedToolId === undefined
                  ? state.tools
                  : denyTool(state.tools, deniedToolId),
            }
          : {}),
      };
    case "retry":
      return {
        ...state,
        status: "running",
        pending: null,
        failure: null,
        notice: null,
      };
    case "dismiss-failure":
      return { ...state, failure: null, notice: "已放弃重试 · Pending Agent Loop 保留" };
    default:
      return state;
  }
}

function reduceHarnessEvent(
  state: TuiState,
  event: HarnessEvent,
): TuiState {
  switch (event.type) {
    case "text-delta":
    case "reasoning-delta": {
      const stream = state.stream ?? emptyStream;
      return {
        ...state,
        stream: {
          text:
            event.type === "text-delta"
              ? stream.text + event.textDelta
              : stream.text,
          reasoning:
            event.type === "reasoning-delta"
              ? stream.reasoning + event.textDelta
              : stream.reasoning,
        },
        retry: null,
        notice: null,
      };
    }
    case "tool-call-delta": {
      const id = event.id ?? `tool-call-${event.index}`;
      const tools =
        event.id === undefined
          ? state.tools
          : state.tools.filter((tool) => tool.id !== `tool-call-${event.index}`);
      return {
        ...state,
        tools: upsertTool(tools, {
          id,
          name: event.name ?? "tool",
          detail: "",
          status: "waiting-approval",
          summary: "等待审批",
        }),
      };
    }
    case "approval-requested":
      return {
        ...state,
        approval: {
          approvalId: event.approvalId,
          toolCall: event.toolCall,
        },
        tools: upsertTool(state.tools, toolCard(event.toolCall, "waiting-approval")),
        notice: null,
      };
    case "tool-started":
      return {
        ...state,
        tools: updateTool(
          state.tools,
          event.toolCall.id,
          toolCard(event.toolCall, "running"),
        ),
      };
    case "tool-completed": {
      const card = completedToolCard(event.toolCall, event.result);
      return {
        ...state,
        tools: updateTool(state.tools, event.toolCall.id, card),
      };
    }
    case "tool-round-limit-reached":
      return { ...state, notice: `Tool 轮次达到上限 ${event.limit}，改为无 Tool 最终请求` };
    case "context-compacted":
      return {
        ...state,
        notice: `上下文已压缩 · ${event.tokensBefore} → ${event.tokensAfterEstimate} est.`,
      };
    case "session-usage-updated":
      return {
        ...state,
        sessionTotalTokens: event.sessionTotalTokens,
        contextWindow: event.contextWindow,
      };
    case "compaction-failed":
      return {
        ...state,
        messages: [...state.messages, { kind: "error", text: event.message }],
      };
    case "provider-retrying":
      return {
        ...state,
        retry: {
          reason: formatProviderFailure(event.failure),
          retry: event.retry,
          maxRetries: event.maxRetries,
          delayMs: event.delayMs,
          startedAt: Date.now(),
        },
        notice: null,
      };
    case "agent-loop-completed":
      return {
        ...state,
        messages: finalizeStream(state),
        stream: null,
        retry: null,
        failure: null,
        pending: null,
        status: "idle",
        notice: null,
      };
    case "provider-failed":
      return {
        ...state,
        retry: null,
        failure: event.failure,
        pending: { reason: "provider-failure", failure: event.failure },
        status: "pending",
      };
    case "interrupted-response":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            kind: "interrupted",
            text: event.response.content ?? event.response.reasoning ?? "",
          },
        ],
        stream: null,
        retry: null,
        failure: event.failure,
        pending: { reason: "interrupted", failure: event.failure },
        status: "pending",
      };
    case "agent-loop-interrupted":
      return {
        ...state,
        stream: null,
        retry: null,
        tools: state.tools.map((tool) =>
          tool.status === "running" ? { ...tool, status: "interrupted", summary: "已中断" } : tool,
        ),
        pending: { reason: "user-interrupt" },
        status: "pending",
        notice: "Agent Loop 已中断",
      };
    case "harness-failed":
      return {
        ...state,
        messages: [...state.messages, { kind: "error", text: event.error.message }],
      };
    default:
      return state;
  }
}

function messageToTuiMessages(message: HarnessSnapshot["messages"][number]): TuiMessage[] {
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

function finalizeStream(state: TuiState): readonly TuiMessage[] {
  if (state.stream === null) {
    return state.messages;
  }
  return [
    ...state.messages,
    ...(state.stream.reasoning === ""
      ? []
      : [{ kind: "reasoning" as const, text: state.stream.reasoning }]),
    ...(state.stream.text === ""
      ? []
      : [{ kind: "assistant" as const, text: state.stream.text }]),
  ];
}

function pendingNotice(pending: PendingAgentLoop): string {
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
    ...(failure.requestId === undefined ? [] : [`request_id: ${failure.requestId}`]),
  ].join(" · ");
}

function toolCard(
  toolCall: ProviderToolCall,
  status: TuiToolStatus,
): TuiToolCard {
  return {
    id: toolCall.id,
    name: toolCall.name,
    detail: formatToolCallDetail(toolCall),
    status,
    summary:
      status === "waiting-approval"
        ? "等待审批"
        : status === "running"
          ? "执行中"
          : "",
  };
}

function completedToolCard(
  toolCall: ProviderToolCall,
  result: ToolResult,
): TuiToolCard {
  const card = toolCard(toolCall, result.ok ? "completed" : "failed");
  if (!result.ok) {
    const denied = result.error.code === "EAPPROVAL_DENIED";
    return {
      ...card,
      status: denied ? "denied" : "failed",
      summary: `${result.error.code} · ${result.error.message}`,
    };
  }

  const value = result.result;
  if (
    toolCall.name === "read_file" &&
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).content === "string"
  ) {
    const record = value as {
      path?: unknown;
      content: string;
      truncated?: unknown;
    };
    const content = record.content;
    const lines = content.split("\n");
    const bytes = new TextEncoder().encode(content).length;
    return {
      ...card,
      summary: `已读 ${lines.length} 行 · ${bytes} B${record.truncated === true ? " · 截断" : ""}`,
      preview: lines.slice(0, 2),
      detail: formatToolCallDetail(toolCall),
    };
  }
  return { ...card, summary: "完成" };
}

export function formatToolCallDetail(toolCall: ProviderToolCall): string {
  const arguments_ = toolCall.arguments;
  if (typeof arguments_ !== "object" || arguments_ === null) {
    return toolCall.name;
  }
  const record = arguments_ as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  const offset =
    typeof record.offset === "number" ? ` offset=${record.offset}` : "";
  const limit =
    typeof record.limit === "number" ? ` limit=${record.limit}` : "";
  return path === undefined ? toolCall.name : `${path}${offset}${limit}`;
}

function upsertTool(
  tools: readonly TuiToolCard[],
  next: TuiToolCard,
): readonly TuiToolCard[] {
  return updateTool(tools, next.id, next);
}

function updateTool(
  tools: readonly TuiToolCard[],
  id: string,
  next: TuiToolCard,
): readonly TuiToolCard[] {
  const index = tools.findIndex((tool) => tool.id === id);
  if (index === -1) {
    return [...tools, next];
  }
  return tools.map((tool, toolIndex) => (toolIndex === index ? next : tool));
}

function denyTool(
  tools: readonly TuiToolCard[],
  approvalId: string,
): readonly TuiToolCard[] {
  const tool = tools.find((candidate) => candidate.id === approvalId);
  if (tool === undefined) {
    return tools;
  }
  return tools.map((candidate) =>
    candidate.id === tool.id
      ? { ...candidate, status: "denied" as const, summary: "EAPPROVAL_DENIED · 已拒绝" }
      : candidate,
  );
}
