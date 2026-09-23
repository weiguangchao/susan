import { Box, Text } from "ink";
import type { LogItem, ToolItem } from "../session-state.js";
import { glyphs, theme } from "../theme.js";
import { Spinner } from "./Spinner.js";

const statusColor: Record<ToolItem["status"], string> = {
  pending: theme.muted,
  running: theme.accent,
  done: theme.success,
  error: theme.error,
  denied: theme.warn,
};

function ToolRow({ item }: { item: ToolItem }) {
  const color = statusColor[item.status];
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        {item.status === "running" || item.status === "pending" ? (
          <Spinner color={color} />
        ) : (
          <Text color={color}>
            {item.status === "done" ? glyphs.ok : glyphs.fail}
          </Text>
        )}
        <Text color={theme.text} bold>
          {" "}
          {item.name}
        </Text>
        <Text color={theme.muted}> {item.summary}</Text>
      </Box>
      {item.display ? (
        <Box paddingLeft={2}>
          <Text color={theme.muted}>└ {item.display}</Text>
        </Box>
      ) : null}
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
