import { Box, Text } from "ink";
import { ToolLedgerView, type TuiToolCard } from "../tool-ledger";
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
