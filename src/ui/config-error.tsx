import { Box, Text, useInput } from "ink";
import type { ConfigErrorView } from "../core/config-error";

export type ConfigErrorAppProps = {
  readonly view: ConfigErrorView;
  readonly onReload: () => void;
  readonly onExit: () => void;
};

export function ConfigErrorApp({
  view,
  onReload,
  onExit,
}: ConfigErrorAppProps) {
  useInput((input, key) => {
    if (input === "r") {
      onReload();
      return;
    }
    if (key.escape) {
      onExit();
    }
  });

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text color="red">⚠ {view.heading}</Text>
      <Text dimColor>{view.code}</Text>
      <Text>{view.configPath}</Text>
      {view.issues.map((issue) => (
        <Text key={`${issue.path}:${issue.message}`}>
          {issue.path}: {issue.message}
        </Text>
      ))}
      {view.example === null ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>最小 Config 示例：</Text>
          <Text>{view.example}</Text>
        </Box>
      )}
      <Text dimColor>{view.hint}</Text>
    </Box>
  );
}
