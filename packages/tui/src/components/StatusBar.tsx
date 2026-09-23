import { Box, Text } from "ink";
import type { Usage } from "@susan/harness";
import { theme } from "../theme.js";
import { Spinner } from "./Spinner.js";

export interface StatusBarProps {
  busy: boolean;
  status: string;
  usage: Usage;
  mode: string;
  model?: string;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

export function StatusBar({ busy, status, usage, mode, model }: StatusBarProps) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        {busy ? (
          <>
            <Spinner />
            <Text color={theme.muted}> {status || "working"}</Text>
          </>
        ) : (
          <Text color={theme.muted}>
            {mode} mode{model ? ` · ${model}` : ""} · enter to send · esc to interrupt
          </Text>
        )}
      </Box>
      <Box>
        <Text color={theme.muted}>
          {compact(usage.inputTokens)} in · {compact(usage.outputTokens)} out
          {usage.cacheReadTokens > 0
            ? ` · ${compact(usage.cacheReadTokens)} cached`
            : ""}
        </Text>
      </Box>
    </Box>
  );
}
