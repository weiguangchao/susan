import stringWidth from "string-width";
import type { TuiInputCursor } from "./state.js";

export type InputVisualRow = {
  readonly text: string;
  readonly cursorStart: number | null;
  readonly cursorEnd: number | null;
};

const INPUT_PROMPT_WIDTH = 2;
const INPUT_BORDER_WIDTH = 2;
const INPUT_PADDING_WIDTH = 2;
const INPUT_CURSOR_SLACK = 1;
const INPUT_TRAILING_GUTTER = 1;

export function inputBoxWidth(columns: number): number {
  return Math.max(1, columns - INPUT_TRAILING_GUTTER);
}

export function inputContentWidth(columns: number): number {
  return Math.max(
    1,
    inputBoxWidth(columns) -
      INPUT_BORDER_WIDTH -
      INPUT_PADDING_WIDTH -
      INPUT_PROMPT_WIDTH -
      INPUT_CURSOR_SLACK,
  );
}

export type InputImeCursorPosition = {
  readonly x: number;
  readonly y: number;
};

const INPUT_BORDER_LEFT = 1;
const INPUT_PADDING_LEFT = 1;
const INPUT_BORDER_BOTTOM = 1;

export function inputImeCursorPosition(options: {
  readonly visualRows: readonly InputVisualRow[];
  readonly screenRows: number;
  readonly statusRows?: number;
  readonly boxLeft?: number;
}): InputImeCursorPosition | undefined {
  const statusRows = options.statusRows ?? 1;
  const boxLeft = options.boxLeft ?? 0;
  const index = options.visualRows.findIndex(
    (row) => row.cursorStart !== null,
  );
  const row = options.visualRows[index];
  if (row === undefined || row.cursorStart === null) {
    return undefined;
  }
  return {
    x:
      boxLeft +
      INPUT_BORDER_LEFT +
      INPUT_PADDING_LEFT +
      INPUT_PROMPT_WIDTH +
      stringWidth(row.text.slice(0, row.cursorStart)),
    y:
      options.screenRows -
      statusRows -
      INPUT_BORDER_BOTTOM -
      options.visualRows.length +
      index,
  };
}

type PositionedGrapheme = {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly width: number;
};

type WrappedRow = {
  readonly graphemes: readonly PositionedGrapheme[];
  readonly start: number;
  readonly end: number;
  readonly isLogicalLineEnd: boolean;
};

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export function layoutInput(
  input: string,
  cursor: TuiInputCursor,
  width: number,
  maxRows: number,
): readonly InputVisualRow[] {
  const safeWidth = Math.max(1, width);
  const safeMaxRows = Math.max(1, maxRows);
  const cursorOffset = offsetOfCursor(input, cursor);
  const wrappedRows = rowsWithCursor(input, safeWidth, cursorOffset);
  const cursorRow = findCursorRow(wrappedRows, cursorOffset);
  const viewportStart = Math.min(
    Math.max(0, cursorRow - safeMaxRows + 1),
    Math.max(0, wrappedRows.length - safeMaxRows),
  );

  return wrappedRows
    .slice(viewportStart, viewportStart + safeMaxRows)
    .map((row, visibleIndex) => {
      const text = row.graphemes.map((grapheme) => grapheme.text).join("");
      if (viewportStart + visibleIndex !== cursorRow) {
        return { text, cursorStart: null, cursorEnd: null };
      }

      const cursorGrapheme = row.graphemes.find(
        (grapheme) =>
          cursorOffset >= grapheme.start && cursorOffset < grapheme.end,
      );
      if (cursorGrapheme === undefined) {
        return {
          text,
          cursorStart: text.length,
          cursorEnd: text.length,
        };
      }

      const cursorStart = row.graphemes
        .filter((grapheme) => grapheme.start < cursorGrapheme.start)
        .reduce((length, grapheme) => length + grapheme.text.length, 0);
      return {
        text,
        cursorStart,
        cursorEnd: cursorStart + cursorGrapheme.text.length,
      };
    });
}

export function moveInputCursorVertically(
  input: string,
  cursor: TuiInputCursor,
  width: number,
  direction: -1 | 1,
): TuiInputCursor {
  const safeWidth = Math.max(1, width);
  const cursorOffset = offsetOfCursor(input, cursor);
  const rows = rowsWithCursor(input, safeWidth, cursorOffset);
  const cursorRow = findCursorRow(rows, cursorOffset);
  const targetRow = rows[cursorRow + direction];
  if (targetRow === undefined) {
    return cursor;
  }

  const visualColumn = visualColumnAt(rows[cursorRow]!, cursorOffset);
  return cursorOfOffset(
    input,
    offsetAtVisualColumn(targetRow, visualColumn),
  );
}

function rowsWithCursor(
  input: string,
  width: number,
  cursorOffset: number,
): WrappedRow[] {
  const wrappedRows = [...wrapInput(input, width)];
  const lineEndRow = wrappedRows.findIndex(
    (row) => row.isLogicalLineEnd && row.end === cursorOffset,
  );
  if (
    lineEndRow !== -1 &&
    rowWidth(wrappedRows[lineEndRow]!) >= width
  ) {
    const fullRow = wrappedRows[lineEndRow]!;
    wrappedRows.splice(
      lineEndRow,
      1,
      { ...fullRow, isLogicalLineEnd: false },
      {
        graphemes: [],
        start: cursorOffset,
        end: cursorOffset,
        isLogicalLineEnd: true,
      },
    );
  }
  return wrappedRows;
}

function offsetOfCursor(input: string, cursor: TuiInputCursor): number {
  const lines = input.split("\n");
  let offset = 0;
  for (let row = 0; row < cursor.row; row += 1) {
    offset += (lines[row]?.length ?? 0) + 1;
  }
  return Math.min(input.length, offset + cursor.column);
}

function wrapInput(input: string, width: number): readonly WrappedRow[] {
  const logicalLines = input.split("\n");
  const rows: WrappedRow[] = [];
  let lineOffset = 0;

  logicalLines.forEach((line) => {
    const graphemes = Array.from(graphemeSegmenter.segment(line), (segment) => ({
      text: segment.segment,
      start: lineOffset + segment.index,
      end: lineOffset + segment.index + segment.segment.length,
      width: Math.max(1, stringWidth(segment.segment)),
    }));
    const chunks = wrapGraphemes(graphemes, width, lineOffset);
    chunks.forEach((chunk, index) => {
      rows.push({
        ...chunk,
        isLogicalLineEnd: index === chunks.length - 1,
      });
    });
    lineOffset += line.length + 1;
  });

  return rows;
}

function wrapGraphemes(
  graphemes: readonly PositionedGrapheme[],
  width: number,
  lineOffset: number,
): readonly Omit<WrappedRow, "isLogicalLineEnd">[] {
  if (graphemes.length === 0) {
    return [{ graphemes: [], start: lineOffset, end: lineOffset }];
  }

  const rows: Omit<WrappedRow, "isLogicalLineEnd">[] = [];
  let current: PositionedGrapheme[] = [];
  let currentWidth = 0;

  for (const grapheme of graphemes) {
    if (current.length > 0 && currentWidth + grapheme.width > width) {
      rows.push(toWrappedRow(current));
      current = [];
      currentWidth = 0;
    }
    current.push(grapheme);
    currentWidth += grapheme.width;
  }
  rows.push(toWrappedRow(current));
  return rows;
}

function toWrappedRow(
  graphemes: readonly PositionedGrapheme[],
): Omit<WrappedRow, "isLogicalLineEnd"> {
  return {
    graphemes,
    start: graphemes[0]?.start ?? 0,
    end: graphemes.at(-1)?.end ?? 0,
  };
}

function findCursorRow(
  rows: readonly WrappedRow[],
  cursorOffset: number,
): number {
  const logicalLineEndRow = rows.findIndex(
    (candidate) => candidate.isLogicalLineEnd && cursorOffset === candidate.end,
  );
  if (logicalLineEndRow !== -1) {
    return logicalLineEndRow;
  }

  const wrappedRowEnd = rows.findIndex(
    (candidate) => !candidate.isLogicalLineEnd && cursorOffset === candidate.end,
  );
  if (wrappedRowEnd !== -1) {
    return wrappedRowEnd;
  }

  const row = rows.findIndex(
    (candidate) =>
      (cursorOffset >= candidate.start && cursorOffset < candidate.end) ||
      (candidate.isLogicalLineEnd && cursorOffset === candidate.end),
  );
  return row === -1 ? rows.length - 1 : row;
}

function visualColumnAt(row: WrappedRow, cursorOffset: number): number {
  return row.graphemes
    .filter((grapheme) => grapheme.end <= cursorOffset)
    .reduce((column, grapheme) => column + grapheme.width, 0);
}

function offsetAtVisualColumn(row: WrappedRow, column: number): number {
  let currentColumn = 0;
  for (const grapheme of row.graphemes) {
    if (currentColumn + grapheme.width > column) {
      return grapheme.start;
    }
    currentColumn += grapheme.width;
  }
  return row.end;
}

function cursorOfOffset(input: string, offset: number): TuiInputCursor {
  const beforeCursor = input.slice(0, offset).split("\n");
  return {
    row: beforeCursor.length - 1,
    column: beforeCursor.at(-1)?.length ?? 0,
  };
}

function rowWidth(row: WrappedRow): number {
  return row.graphemes.reduce(
    (width, grapheme) => width + grapheme.width,
    0,
  );
}
