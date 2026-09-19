import { Box, Text } from "ink";
import type { TuiState } from "../state";

export const STATUS_BAR_ROWS = 1;

type StatusBarState = Pick<
  TuiState,
  | "contextTokens"
  | "contextWindow"
  | "sessionCachedInputTokens"
  | "sessionInputTokens"
  | "model"
  | "reasoningEffort"
>;

export function StatusBar({ state }: { readonly state: StatusBarState }) {
  const percentage = (state.contextTokens / state.contextWindow) * 100;
  const cacheVisible =
    state.sessionCachedInputTokens > 0 && state.sessionInputTokens > 0;
  const cacheHitRate = cacheVisible
    ? (state.sessionCachedInputTokens / state.sessionInputTokens) * 100
    : null;

  return (
    <Box
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <Text dimColor>
        {cacheHitRate === null ? "" : `CH ${cacheHitRate.toFixed(1)}% `}
        {percentage.toFixed(1)}%/{formatTokenCount(state.contextTokens)}
      </Text>
      <Text dimColor>
        {state.model ?? "未设置"} · {state.reasoningEffort ?? "未设置"}
      </Text>
    </Box>
  );
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) {
    return String(tokens);
  }
  const thousands = tokens / 1_000;
  return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
}
