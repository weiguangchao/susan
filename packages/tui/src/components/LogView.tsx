import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { formatDuration } from "../duration.js";
import type { LogItem, ToolItem } from "../session-state.js";
import { glyphs, theme } from "../theme.js";
import { TimedLabel } from "./TimedLabel.js";

function ToolRow({ item }: { item: ToolItem }) {
  const { preview } = item;
  const failed = item.status === "error";
  const width = Math.max(...preview.lines.map(line => String(line.lineNumber ?? "").length));
  const hidden = preview.totalLines - preview.lines.length;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text wrap="wrap">
        <Text color={theme.text} bold>{item.name}</Text>
        <Text color={theme.muted}>{item.summary ? ` ${item.summary}` : ""} </Text>
        <Text color={failed ? theme.error : theme.success}>{failed ? glyphs.fail : glyphs.ok}</Text>
      </Text>
      <Box flexDirection="column" marginLeft={4}>
        {preview.lines.map((line, index) => (
          <Box key={index}>
            {!failed && line.lineNumber !== undefined ? (
              <Box flexShrink={0}><Text color={theme.muted}>{String(line.lineNumber).padStart(width)} </Text></Box>
            ) : null}
            <Box flexGrow={1} flexBasis={0} minWidth={0}>
              <Text wrap="wrap" color={failed ? theme.error : theme.muted}>{line.text}</Text>
            </Box>
          </Box>
        ))}
        {hidden > 0 ? <Text color={failed ? theme.error : theme.muted}>… {hidden}L · Total {preview.totalLines}L</Text> : null}
        {preview.sourceCapped ? <Text color={failed ? theme.error : theme.muted}>{preview.capNotice ?? "… [source output capped]"}</Text> : null}
        {preview.linesClipped ? <Text color={failed ? theme.error : theme.muted}>… [long preview lines clipped]</Text> : null}
      </Box>
    </Box>
  );
}

/**
 * One reasoning block. The streaming block and the committed one share this
 * markup, so nothing moves when a block completes; only the timer stops.
 */
export function ReasoningBlock({ text, duration }: { text: string; duration: ReactNode }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <TimedLabel duration={duration}>
        <Text color={theme.thinking}>{glyphs.thinking} Thinking</Text>
      </TimedLabel>
      <Text color={theme.thinking} dimColor italic>
        {text}
      </Text>
    </Box>
  );
}

export function LogEntry({ item }: { item: LogItem }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginBottom={1}>
          <Text color={theme.user} bold>
            {glyphs.prompt}{" "}
          </Text>
          <Text color={theme.user}>{item.text}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box marginBottom={1}>
          <Text color={theme.text}>{item.text}</Text>
        </Box>
      );

    case "reasoning":
      return <ReasoningBlock text={item.text} duration={formatDuration(item.ms)} />;

    case "tool":
      return <ToolRow item={item} />;

    case "notice": {
      // Info is chrome (command output, hints); warn and error are events the
      // user needs to notice, so only those get a marker.
      const color =
        item.level === "error"
          ? theme.error
          : item.level === "warn"
            ? theme.warn
            : theme.muted;
      const marker = item.level === "info" ? "" : "! ";
      return (
        <Box marginBottom={1}>
          <Text color={color}>
            {marker}
            {item.text}
          </Text>
        </Box>
      );
    }
  }
}

export function LogList({ items }: { items: LogItem[] }) {
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <LogEntry key={item.id} item={item} />
      ))}
    </Box>
  );
}
