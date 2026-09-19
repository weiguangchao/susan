import { Box, Text } from "ink";
import { toolResultRows, type TuiToolCard, type TuiToolResultRow } from "../tool-ledger";
import type { TuiCompletedOutput, TuiMessage } from "../state";
import {
  USER_MESSAGE_BAR,
  USER_MESSAGE_BAR_COLUMNS,
  messageGapAbove,
  outputLines,
  thinkDurationLabel,
  wrapLines,
} from "./layout";

export function CompletedOutputView({
  item,
  width,
  gapAbove = 0,
}: {
  readonly item: TuiCompletedOutput;
  readonly width: number;
  readonly gapAbove?: number;
}) {
  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={1} marginTop={gapAbove}>
      {item.kind === "message" ? (
        <MessageView message={item.message} width={width} />
      ) : (
        <ToolLedgerView tools={item.tools} />
      )}
    </Box>
  );
}

export function SessionContentView({
  messages,
  tools,
  width = 80,
}: {
  readonly messages: readonly TuiMessage[];
  readonly tools: readonly TuiToolCard[];
  readonly width?: number;
}) {
  return (
    <>
      <ToolLedgerView tools={tools} />
      {messages.map((message, index) => (
        <MessageView
          key={`message-${index}`}
          message={message}
          width={width}
          gapAbove={messageGapAbove(messages, index)}
        />
      ))}
    </>
  );
}

function MessageView({
  message,
  width,
  gapAbove = 0,
}: {
  readonly message: TuiMessage;
  readonly width: number;
  readonly gapAbove?: number;
}) {
  if (message.kind === "user") {
    const lines = wrapLines(message.text, width - USER_MESSAGE_BAR_COLUMNS);
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {lines.map((line, index) => (
          <Text key={index} wrap="truncate-end">
            <Text color="cyan">{USER_MESSAGE_BAR} </Text>
            <Text bold>{line}</Text>
          </Text>
        ))}
      </Box>
    );
  }
  if (message.kind === "assistant") {
    const lines = outputLines(message.text, width);
    return (
      <Box flexDirection="column" marginTop={gapAbove}>
        {lines.map((line, index) => (
          <Text key={index} wrap="truncate-end">
            {line === "" ? " " : line}
          </Text>
        ))}
      </Box>
    );
  }
  if (message.kind === "reasoning") {
    const lines = outputLines(message.text, width);
    return (
      <Box flexDirection="column">
        {message.durationMs === undefined ? null : (
          <Text dimColor wrap="truncate-end">
            {thinkDurationLabel(message.durationMs)}
          </Text>
        )}
        {lines.map((line, index) => (
          <Text key={index} dimColor wrap="truncate-end">
            {line === "" ? " " : line}
          </Text>
        ))}
      </Box>
    );
  }
  if (message.kind === "interrupted") {
    const lines = wrapLines(message.text, width);
    return (
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Text key={index} color="red" wrap="truncate-end">
            {index === 0 ? <Text>[已中断] </Text> : null}
            {line === "" ? " " : line}
          </Text>
        ))}
        <Text dimColor>└ 未写入 Session Transcript · Enter 显式重试</Text>
      </Box>
    );
  }
  return <Text color="red">⚠ {message.text}</Text>;
}

export function ToolLineView({ tool }: { readonly tool: TuiToolCard }) {
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

export function ToolLedgerView({
  tools,
}: {
  readonly tools: readonly TuiToolCard[];
}) {
  const results = tools.filter(tool => tool.status !== "requested" && tool.status !== "running");
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

