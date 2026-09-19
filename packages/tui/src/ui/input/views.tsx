import { useEffect } from "react";
import { Box, Text, useCursor, useStdout } from "ink";
import type { TuiInputCursor } from "../state";
import {
  inputBoxWidth,
  inputContentWidth,
  inputImeCursorPosition,
  layoutInput,
} from "./layout";

const STEADY_UNDERLINE_CURSOR = "\u001B[4 q";
const RESET_CURSOR_SHAPE = "\u001B[0 q";

export function ImeInputLine({
  input,
  cursor,
  columns,
  screenRows,
  maxRows,
}: {
  readonly input: string;
  readonly cursor: TuiInputCursor;
  readonly columns: number;
  readonly screenRows: number;
  readonly maxRows: number;
}) {
  const { stdout } = useStdout();
  const { setCursorPosition } = useCursor();
  const visualRows = layoutInput(
    input,
    cursor,
    inputContentWidth(columns),
    maxRows,
  );
  setCursorPosition(
    inputImeCursorPosition({
      visualRows,
      screenRows,
    }),
  );
  useEffect(() => {
    stdout.write(STEADY_UNDERLINE_CURSOR);
    return () => {
      stdout.write(RESET_CURSOR_SHAPE);
    };
  }, [stdout]);
  return (
    <InputLine
      input={input}
      cursor={cursor}
      columns={columns}
      maxRows={maxRows}
    />
  );
}

export function InputLine({
  input,
  cursor,
  columns = 80,
  maxRows = 10,
}: {
  readonly input: string;
  readonly cursor: TuiInputCursor;
  readonly columns?: number;
  readonly maxRows?: number;
}) {
  const boxWidth = inputBoxWidth(columns);
  const contentWidth = inputContentWidth(columns);
  const rows = layoutInput(input, cursor, contentWidth, maxRows);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>╭{"─".repeat(Math.max(0, boxWidth - 2))}╮</Text>
      <Box
        borderStyle="round"
        borderTop={false}
        width={boxWidth}
        height={rows.length + 1}
        overflow="hidden"
        flexDirection="column"
        flexShrink={0}
      >
        <Box
          flexDirection="column"
          width={Math.max(1, boxWidth - 2)}
          height={rows.length}
          overflow="hidden"
          paddingLeft={1}
          paddingRight={1}
        >
          {rows.map((row, index) => (
            <Text key={`input-${index}`} wrap="truncate-end">
              {index === 0 ? "❯ " : "  "}
              {row.text}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
