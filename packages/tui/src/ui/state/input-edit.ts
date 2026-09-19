import { moveInputCursorVertically } from "../input-layout";
import type { TuiInputCursor, TuiState } from "./types";

export function insertInput(state: TuiState, text: string): TuiState {
  const normalizedText = text.replace(/\r\n?/g, "\n");
  if (normalizedText === "") {
    return { ...state, notice: null };
  }

  const lines = state.input.split("\n");
  const { row, column } = state.inputCursor;
  const line = lines[row] ?? "";
  const updatedLine = `${line.slice(0, column)}${normalizedText}${line.slice(column)}`;
  const updatedLines = updatedLine.split("\n");
  const insertedLines = normalizedText.split("\n");
  const insertedLastLineLength =
    insertedLines[insertedLines.length - 1]?.length ?? 0;
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

export function backspaceInput(state: TuiState): TuiState {
  const lines = state.input.split("\n");
  const { row, column } = state.inputCursor;

  if (row === 0 && column === 0) return state;
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

export function moveCursorUp(
  state: TuiState,
  inputWidth?: number,
): TuiInputCursor {
  if (inputWidth !== undefined) {
    return moveInputCursorVertically(
      state.input,
      state.inputCursor,
      inputWidth,
      -1,
    );
  }
  if (state.inputCursor.row === 0) return { row: 0, column: 0 };
  const row = state.inputCursor.row - 1;
  return {
    row,
    column: Math.min(
      state.inputCursor.column,
      state.input.split("\n")[row]?.length ?? 0,
    ),
  };
}

export function moveCursorDown(
  state: TuiState,
  inputWidth?: number,
): TuiInputCursor {
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

export function moveCursorLeft(state: TuiState): TuiInputCursor {
  const { row, column } = state.inputCursor;
  if (column > 0) return { row, column: column - 1 };
  if (row === 0) return { row: 0, column: 0 };
  return {
    row: row - 1,
    column: state.input.split("\n")[row - 1]?.length ?? 0,
  };
}

export function moveCursorRight(state: TuiState): TuiInputCursor {
  const lines = state.input.split("\n");
  const { row, column } = state.inputCursor;
  const lineLength = lines[row]?.length ?? 0;
  if (column < lineLength) return { row, column: column + 1 };
  if (row < lines.length - 1) return { row: row + 1, column: 0 };
  return { row, column: lineLength };
}

export function cursorAtEnd(input: string): TuiInputCursor {
  const lines = input.split("\n");
  const row = lines.length - 1;
  return { row, column: lines[row]?.length ?? 0 };
}

export function clearedDraftState(state: TuiState) {
  return {
    input: "",
    inputCursor: { row: 0, column: 0 },
    inputHistoryIndex: state.inputHistory.length,
    inputHistoryActive: false,
    slashCommandSelectedIndex: 0,
  } as const;
}
