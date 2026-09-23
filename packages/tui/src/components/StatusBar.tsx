import { Box, Text } from "ink";
import { cacheHitRate, type Usage } from "@susan/harness";
import { theme } from "../theme.js";

export interface StatusBarProps {
  root: string;
  contextUsage: Usage | null;
  contextWindow?: number;
  model: string;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function StatusBar({ root, contextUsage, contextWindow, model }: StatusBarProps) {
  // Input usage is the provider-measured prompt context of the last request.
  // Output usage can contain reasoning tokens that are not replayed next time.
  const used = contextUsage?.inputTokens ?? null;
  const percentage = used !== null && contextWindow
    ? `${((used / contextWindow) * 100).toFixed(1)}%`
    : "—%";
  const cached = contextUsage ? cacheHitRate(contextUsage) : null;
  const usageText = `${used === null ? "—" : compact(used)} / ${contextWindow ? compact(contextWindow) : "—"} (${percentage}) cached (${cached === null ? "—" : cached}%)`;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box width="100%" justifyContent="space-between">
        <Box flexShrink={0}>
          <Text color={theme.text}>{usageText}</Text>
        </Box>
        <Box flexGrow={1} minWidth={0} justifyContent="flex-end" marginLeft={1}>
          <Text color={theme.text} wrap="truncate-start">{model}</Text>
        </Box>
      </Box>
      <Text color={theme.muted} wrap="truncate-end">{root}</Text>
    </Box>
  );
}
