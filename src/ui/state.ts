import type {
  HarnessEvent,
  HarnessSnapshot,
  HarnessStatus,
  PendingAgentLoop,
} from "../core/harness";
import { isJsonValue, isRecord } from "../core/json";
import { type ToolResult } from "../core/tool-result";
import type { ProviderFailure, ReasoningEffort } from "../core/provider";
import { moveInputCursorVertically } from "./input-layout";
import {
  resolveSlashCommandMenu,
  slashCommands,
} from "./slash-command-menu";
import {
  createCompletedToolCard,
  createToolCard,
  formatToolCallDetail,
  type TuiToolCard,
  type TuiToolStatus,
} from "./tool-ledger";

export { formatToolCallDetail } from "./tool-ledger";
export { resolveSlashCommandMenu, slashCommands } from "./slash-command-menu";
export type { TuiToolCard, TuiToolStatus } from "./tool-ledger";
export type { SlashCommand, SlashCommandMenu } from "./slash-command-menu";

export type TuiMessage =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | {
      readonly kind: "reasoning";
      readonly text: string;
      readonly durationMs?: number;
    }
  | { readonly kind: "interrupted"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

export type TuiCompletedOutput =
  | {
      readonly id: string;
      readonly kind: "message";
      readonly message: TuiMessage;
    }
  | {
      readonly id: string;
      readonly kind: "tool-batch";
      readonly tools: readonly TuiToolCard[];
    };

export type TuiRetry = {
  readonly reason: string;
  readonly retry: 1 | 2;
  readonly maxRetries: 2;
  readonly delayMs: number;
  readonly startedAt: number;
};

export type TuiState = {
  readonly cwd: string;
  readonly status: HarnessStatus;
  readonly messages: readonly TuiMessage[];
  readonly tools: readonly TuiToolCard[];
  readonly completedOutput: readonly TuiCompletedOutput[];
  // Covers the initial Provider wait, Tool execution, and the following Provider wait without resetting the animation.
  readonly awaitingModelAfterTools: boolean;
  readonly stream: {
    readonly text: string;
    readonly reasoning: string;
    readonly reasoningStartedAt: number | null;
    readonly reasoningEndedAt: number | null;
  } | null;
  readonly retry: TuiRetry | null;
  readonly failure: ProviderFailure | null;
  readonly pending: PendingAgentLoop | null;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly contextWindow: number;
  readonly contextTokens: number;
  readonly sessionTotalTokens: number;
  readonly sessionInputTokens: number;
  readonly sessionCachedInputTokens: number;
  readonly notice: string | null;
  readonly input: string;
  readonly inputCursor: TuiInputCursor;
  readonly inputHistory: readonly string[];
  readonly inputHistoryIndex: number;
  readonly inputHistoryActive: boolean;
  readonly slashCommandSelectedIndex: number;
  readonly modelPickerActive: boolean;
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
  | { readonly type: "move-slash-command-selection"; readonly delta: -1 | 1 }
  | { readonly type: "submit"; readonly content: string }
  | { readonly type: "clear-input" }
  | { readonly type: "clear" }
  | { readonly type: "compact"; readonly customInstructions?: string }
  | { readonly type: "model-picker" }
  | { readonly type: "reload" }
  | { readonly type: "exit" }
  | { readonly type: "interrupt" }
  | { readonly type: "retry" }
  | { readonly type: "new-session" }
  | { readonly type: "dismiss-failure" }
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "none" };

export type TuiSubmissionIntent =
  | { readonly type: "exit" }
  | { readonly type: "clear" }
  | { readonly type: "compact"; readonly customInstructions?: string }
  | { readonly type: "model-picker" }
  | { readonly type: "reload" }
  | { readonly type: "submit"; readonly content: string };

export type TuiAction =
  | { readonly type: "harness-event"; readonly event: HarnessEvent }
  | { readonly type: "snapshot"; readonly snapshot: HarnessSnapshot }
  | { readonly type: "input-key"; readonly key: TuiInputKey }
  | { readonly type: "input-intent"; readonly intent: TuiInputIntent }
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "clear-input" }
  | { readonly type: "close-model-picker" }
  | { readonly type: "new-session"; readonly snapshot: HarnessSnapshot; readonly inputHistory?: readonly string[] };

const emptyStream = {
  text: "",
  reasoning: "",
  reasoningStartedAt: null,
  reasoningEndedAt: null,
};

export function createTuiState(
  snapshot: HarnessSnapshot,
  globalInputHistory?: readonly string[],
): TuiState {
  const inputHistory =
    globalInputHistory ??
    snapshot.messages.flatMap((message) =>
      message.role === "user" ? [message.content] : [],
    );
  const messages = snapshot.messages.flatMap(messageToTuiMessages);
  const tools = toolsFromMessages(snapshot.messages, snapshot.cwd);
  return {
    cwd: snapshot.cwd,
    status: snapshot.status,
    messages,
    tools,
    completedOutput: completedOutputFromMessages(
      snapshot.messages,
      tools,
    ),
    awaitingModelAfterTools: false,
    stream: null,
    retry: null,
    failure: null,
    pending: snapshot.pending,
    model: snapshot.model,
    reasoningEffort: snapshot.reasoningEffort,
    contextWindow: snapshot.contextWindow,
    contextTokens: snapshot.contextTokens,
    sessionTotalTokens: snapshot.sessionTotalTokens,
    sessionInputTokens: snapshot.sessionInputTokens,
    sessionCachedInputTokens: snapshot.sessionCachedInputTokens,
    notice:
      snapshot.pending !== null
        ? pendingNotice(snapshot.pending)
        : snapshot.model === undefined || snapshot.reasoningEffort === undefined
          ? "模型配置未完整 · /model 选择"
          : null,
    input: "",
    inputCursor: { row: 0, column: 0 },
    inputHistory,
    inputHistoryIndex: inputHistory.length,
    inputHistoryActive: false,
    slashCommandSelectedIndex: 0,
    modelPickerActive: false,
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
  if (content.startsWith("/compact ")) return { type: "compact", customInstructions: content.slice(9).trim() };
  const command = slashCommands.find((candidate) => candidate.name === content);
  if (command !== undefined) {
    return { type: command.intent };
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
    if (state.status === "running") {
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
  const slashCommandMenu = resolveSlashCommandMenu(state);
  if (key.upArrow) {
    if (slashCommandMenu.visible) {
      return { type: "move-slash-command-selection", delta: -1 };
    }
    if (
      (state.input === "" || state.inputHistoryActive) &&
      state.inputHistoryIndex > 0
    ) {
      return { type: "history-previous" };
    }
    return { type: "move-cursor-up", inputWidth: key.inputWidth };
  }
  if (key.downArrow) {
    if (slashCommandMenu.visible) {
      return { type: "move-slash-command-selection", delta: 1 };
    }
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

  if (key.escape && (slashCommandMenu.visible || state.failure !== null)) {
    return { type: "dismiss-failure" };
  }

  if (state.status === "running") {
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
        return state.model === undefined || state.reasoningEffort === undefined
          ? { type: "model-picker" }
          : { type: "retry" };
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
      if (slashCommandMenu.selected !== null) {
        return { type: slashCommandMenu.selected.intent };
      }
      const submission = resolveSubmission(state.input);
      if (submission.type !== "submit") {
        return submission;
      }
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
    if (slashCommandMenu.selected !== null) {
      return { type: slashCommandMenu.selected.intent };
    }
    const submission = resolveSubmission(state.input);
    if (submission.type === "submit" && submission.content.length === 0) {
      return { type: "none" };
    }
    if (
      submission.type === "submit" &&
      (state.model === undefined || state.reasoningEffort === undefined)
    ) {
      return { type: "model-picker" };
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
        cwd: action.snapshot.cwd,
        status: action.snapshot.status,
        awaitingModelAfterTools: action.snapshot.status === "running" && state.awaitingModelAfterTools,
        pending: action.snapshot.pending,
        model: action.snapshot.model,
        reasoningEffort: action.snapshot.reasoningEffort,
        contextWindow: action.snapshot.contextWindow,
        contextTokens: action.snapshot.contextTokens,
        sessionTotalTokens: action.snapshot.sessionTotalTokens,
        sessionInputTokens: action.snapshot.sessionInputTokens,
        sessionCachedInputTokens: action.snapshot.sessionCachedInputTokens,
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
        ...clearedDraftState(state),
        notice: null,
      };
    case "close-model-picker":
      return { ...state, modelPickerActive: false };
    case "new-session":
      return createTuiState(action.snapshot, action.inputHistory ?? state.inputHistory);
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
    slashCommandSelectedIndex: 0,
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
      slashCommandSelectedIndex: 0,
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
    slashCommandSelectedIndex: 0,
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

function clearedDraftState(state: TuiState) {
  return {
    input: "",
    inputCursor: { row: 0, column: 0 },
    inputHistoryIndex: state.inputHistory.length,
    inputHistoryActive: false,
    slashCommandSelectedIndex: 0,
  } as const;
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
        slashCommandSelectedIndex: 0,
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
        slashCommandSelectedIndex: 0,
        notice: null,
      };
    }
    case "move-slash-command-selection": {
      const menu = resolveSlashCommandMenu(state);
      if (menu.selectedIndex === null) {
        return state;
      }
      return {
        ...state,
        slashCommandSelectedIndex: Math.max(
          0,
          Math.min(menu.candidates.length - 1, menu.selectedIndex + intent.delta),
        ),
        notice: null,
      };
    }
    case "submit": {
      const inputHistory = [...state.inputHistory, intent.content];
      const message = { kind: "user" as const, text: intent.content };
      return {
        ...state,
        ...clearedDraftState(state),
        status: "running",
        awaitingModelAfterTools: true,
        messages: [...state.messages, message],
        completedOutput: appendCompletedMessages(
          state.completedOutput,
          [message],
        ),
        inputHistory,
        inputHistoryIndex: inputHistory.length,
        notice: null,
        failure: null,
      };
    }
    case "clear-input":
      return {
        ...state,
        ...clearedDraftState(state),
        notice: "已清空输入",
      };
    case "notice":
      return { ...state, notice: intent.message };
    case "clear":
    case "new-session":
    case "reload":
      return { ...state, ...clearedDraftState(state), notice: null };
    case "compact":
      return { ...state, ...clearedDraftState(state), status: "running", notice: "正在压缩上下文…", failure: null };
    case "model-picker": {
      const selectedFromMenu = resolveSlashCommandMenu(state).selected?.intent === "model-picker";
      const clearInput =
        selectedFromMenu || normalizeSubmission(state.input) === "/model";
      return {
        ...state,
        ...(clearInput
          ? clearedDraftState(state)
          : { slashCommandSelectedIndex: 0 }),
        modelPickerActive: true,
        notice: null,
      };
    }
    case "retry":
      return {
        ...state,
        status: "running",
        awaitingModelAfterTools: true,
        pending: null,
        failure: null,
        notice: null,
      };
    case "dismiss-failure": {
      const clearInput = resolveSlashCommandMenu(state).visible;
      return {
        ...state,
        ...(clearInput ? clearedDraftState(state) : {}),
        failure: null,
        notice:
          state.failure === null
            ? null
            : "已放弃重试 · Pending Agent Loop 保留",
      };
    }
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
      const reasoningDelta = event.type === "reasoning-delta";
      const now = reasoningDelta ? Date.now() : null;
      return {
        ...state,
        awaitingModelAfterTools: false,
        stream: {
          text: reasoningDelta
            ? stream.text
            : stream.text + event.textDelta,
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
      const existing = state.tools.find(tool =>
        tool.status === "requested" &&
        ((event.id !== undefined && tool.id === event.id) ||
          tool.id === placeholderId || tool.streamIndex === event.index));
      const id = event.id ?? existing?.id ?? placeholderId;
      const name = event.name ?? existing?.name ?? "tool";
      const argumentsText = (existing?.argumentsText ?? "") + event.argumentsDelta;
      let invocationLabel = existing?.invocationLabel ?? "";
      try {
        const arguments_: unknown = JSON.parse(argumentsText);
        if (isRecord(arguments_) && isJsonValue(arguments_)) {
          invocationLabel = formatToolCallDetail({ id, name, arguments: arguments_ }, state.cwd);
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
          id, name, invocationLabel, argumentsText, streamIndex: event.index,
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
        completedOutput: appendCompletedMessages(
          state.completedOutput,
          [message],
        ),
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
        completedOutput: appendCompletedMessages(
          state.completedOutput,
          [message],
        ),
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
        completedOutput: appendCompletedMessages(
          state.completedOutput,
          [message],
        ),
      };
    }
    default:
      return state;
  }
}

function toolsFromMessages(
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

function streamMessages(
  stream: TuiState["stream"],
): readonly TuiMessage[] {
  if (stream === null) {
    return [];
  }
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

function completedOutputFromMessages(
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
    if (message.role !== "assistant") {
      continue;
    }
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

function appendCompletedMessages(
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

function appendCompletedToolBatch(
  output: readonly TuiCompletedOutput[],
  tools: readonly TuiToolCard[],
): readonly TuiCompletedOutput[] {
  const completedIds = new Set(
    output.flatMap((item) =>
      item.kind === "tool-batch" ? item.tools.map((tool) => tool.id) : [],
    ),
  );
  const pendingTools = tools.filter((tool) => !completedIds.has(tool.id));
  if (pendingTools.length === 0) {
    return output;
  }
  return [
    ...output,
    {
      id: `tool-batch:live:${output.length}`,
      kind: "tool-batch",
      tools: pendingTools,
    },
  ];
}

function isTerminalTool(tool: TuiToolCard): boolean {
  return (
    tool.status === "completed" ||
    tool.status === "failed" ||
    tool.status === "interrupted"
  );
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

function upsertTool(
  tools: readonly TuiToolCard[],
  next: TuiToolCard,
): readonly TuiToolCard[] {
  return updateTool(tools, next.id, next);
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
      if (tool.id === placeholderId) {
        return [next];
      }
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
  if (index === -1) {
    return [...tools, next];
  }
  return tools.map((tool, toolIndex) => (toolIndex === index ? next : tool));
}
