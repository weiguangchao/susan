import { resolveSlashCommandMenu } from "../slash-command-menu";
import {
  backspaceInput,
  clearedDraftState,
  cursorAtEnd,
  insertInput,
  moveCursorDown,
  moveCursorLeft,
  moveCursorRight,
  moveCursorUp,
} from "./input-edit";
import { normalizeSubmission } from "./keyboard";
import { appendCompletedMessages } from "./transcript";
import type { TuiInputIntent, TuiState } from "./types";

export function applyInputIntent(
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
      return { ...state, inputCursor: moveCursorLeft(state), notice: null };
    case "move-cursor-right":
      return { ...state, inputCursor: moveCursorRight(state), notice: null };
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
      if (menu.selectedIndex === null) return state;
      return {
        ...state,
        slashCommandSelectedIndex: Math.max(
          0,
          Math.min(
            menu.candidates.length - 1,
            menu.selectedIndex + intent.delta,
          ),
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
        completedOutput: appendCompletedMessages(state.completedOutput, [message]),
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
      return {
        ...state,
        ...clearedDraftState(state),
        status: "running",
        notice: "正在压缩上下文…",
        failure: null,
      };
    case "model-picker": {
      const selectedFromMenu =
        resolveSlashCommandMenu(state).selected?.intent === "model-picker";
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
