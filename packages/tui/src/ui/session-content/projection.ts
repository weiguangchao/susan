import type { TuiToolCard } from "../tool-ledger";
import type { TuiState } from "../state";

export function resolveLiveContent(state: TuiState): {
  readonly activeTools: readonly TuiToolCard[];
  readonly gapAbove: number;
} {
  const completedToolIds = new Set(
    state.completedOutput.flatMap((item) =>
      item.kind === "tool-batch" ? item.tools.map((tool) => tool.id) : [],
    ),
  );
  const activeTools = state.tools.filter(
    (tool) => !completedToolIds.has(tool.id) && tool.status !== "requested" && tool.status !== "running",
  );
  const lastCompleted = state.completedOutput.at(-1);
  const gapAbove = (state.stream !== null || state.awaitingModelAfterTools) &&
    lastCompleted !== undefined &&
    (lastCompleted.kind === "tool-batch" ||
      lastCompleted.message.kind === "reasoning" ||
      lastCompleted.message.kind === "assistant") ? 1 : 0;
  return { activeTools, gapAbove };
}
