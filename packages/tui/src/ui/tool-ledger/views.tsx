import { Box, Text } from "ink";
import { toolResultRows } from "./rows";
import type { TuiToolCard, TuiToolResultRow } from "./types";

export function toolLedgerRowCount(tools: readonly TuiToolCard[]): number {
  return tools
    .filter((tool) => tool.status !== "requested" && tool.status !== "running")
    .reduce((sum, tool) => sum + 1 + toolResultRows(tool).length, 0);
}

export function ToolLedgerView({
  tools,
}: {
  readonly tools: readonly TuiToolCard[];
}) {
  const results = tools.filter((tool) => tool.status !== "requested" && tool.status !== "running");
  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      {results.map((tool) => (
        <Box key={tool.id} flexDirection="column" flexShrink={0} width="100%">
          <ToolLineView tool={tool} />
          <ToolResultRows tool={tool} />
        </Box>
      ))}
    </Box>
  );
}

function ToolLineView({ tool }: { readonly tool: TuiToolCard }) {
  if (tool.status === "requested" || tool.status === "running") return null;
  const color = tool.status === "completed" ? "green" : "red";
  return (
    <Box justifyContent="space-between" width="100%" flexShrink={0}>
      <Box flexShrink={1} marginRight={1}>
        <Text wrap="truncate-end">
          <Text bold color={color}>{tool.name}</Text>
          <Text dimColor> {tool.invocationLabel}</Text>
        </Text>
      </Box>
      {tool.summary === "" ? null : (
        <Box flexShrink={0}>
          <Text dimColor wrap="truncate-end">
            {tool.summary}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function ToolResultRows({ tool }: { readonly tool: TuiToolCard }) {
  const rows = toolResultRows(tool);
  const gutterWidth = toolGutterWidth(rows);
  return (
    <>
      {rows.map((row, index) => (
        <ToolResultRowView
          key={`${tool.id}-result-${index}`}
          row={row}
          gutterWidth={gutterWidth}
          failed={tool.status === "failed" && tool.name !== "bash"}
        />
      ))}
    </>
  );
}

function ToolResultRowView({
  row,
  gutterWidth,
  failed,
}: {
  readonly row: TuiToolResultRow;
  readonly gutterWidth: number;
  readonly failed: boolean;
}) {
  if (row.gap) {
    return (
      <Text dimColor italic wrap="truncate-end">
        {"⋮".padStart(gutterWidth, " ")}  {row.text}
      </Text>
    );
  }
  if (row.lineNumber === undefined) {
    const empty = row.text === "(empty)" || row.text === "无匹配" || row.text === "空目录";
    return (
      <Text
        color={failed ? "red" : undefined}
        dimColor={empty}
        italic={empty}
        wrap="truncate-end"
      >
        {" ".repeat(gutterWidth + 2)}{row.text}
      </Text>
    );
  }
  const signColor = row.sign === "+" ? "green" : row.sign === "-" ? "red" : undefined;
  const dimBody = row.sign === " ";
  return (
    <Text wrap="truncate-end">
      <Text
        color={signColor}
        dimColor={signColor === undefined}
      >
        {formatGutter(row, gutterWidth)}  </Text>
      <Text
        color={signColor}
        dimColor={dimBody}
      >
        {row.text}
      </Text>
    </Text>
  );
}

function formatGutter(row: TuiToolResultRow, gutterWidth: number): string {
  const digits = String(row.lineNumber ?? "").padStart(gutterWidth, " ");
  if ((row.sign !== "+" && row.sign !== "-") || !digits.startsWith(" ")) {
    return digits;
  }
  return `${row.sign}${digits.slice(1)}`;
}

function toolGutterWidth(rows: readonly TuiToolResultRow[]): number {
  const numbers = rows.flatMap((row) =>
    row.lineNumber === undefined ? [] : [row.lineNumber],
  );
  if (numbers.length === 0) {
    return 4;
  }
  return Math.max(4, String(Math.max(...numbers)).length);
}
