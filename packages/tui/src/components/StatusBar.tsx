import { Box, Text } from "ink";
import { cacheHitRate } from "@susan/harness";
import { theme } from "../theme.js";
import type { UsageDisplay } from "../usage-display.js";

export interface StatusBarProps {
  root: string;
  usageDisplay: UsageDisplay | null;
  contextWindow?: number;
  model: string;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

function formatUsage(display: UsageDisplay, contextWindow?: number): string {
  if (!display.usage) return "counting tokens...";
  // The final input count is the provider-measured prompt context of the last request.
  // Cache rate uses measured usage across the session, including the active turn when available.
  const usage = display.usage;
  const used = usage.inputTokens;
  const percentage = contextWindow
    ? `${((used / contextWindow) * 100).toFixed(1)}%`
    : "—%";
  const hitRate = cacheHitRate(display.measuredTotal);
  const cached = hitRate !== null && hitRate > 0 ? ` cached (${hitRate}%)` : "";
  return `${compact(used)} / ${contextWindow ? compact(contextWindow) : "—"} (${percentage})${cached}`;
}

export function StatusBar({ root, usageDisplay, contextWindow, model }: StatusBarProps) {
  const usageText = usageDisplay ? formatUsage(usageDisplay, contextWindow) : null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box width="100%" justifyContent="space-between">
        {usageText ? (
          <Box flexShrink={0}>
            <Text color={theme.text}>{usageText}</Text>
          </Box>
        ) : null}
        <Box flexGrow={1} minWidth={0} justifyContent="flex-end" marginLeft={usageText ? 1 : 0}>
          <Text color={theme.text} wrap="truncate-start">{model}</Text>
        </Box>
      </Box>
      <Text color={theme.muted} wrap="truncate-end">{root}</Text>
    </Box>
  );
}
