import { useLayoutEffect, useRef } from "react";
import { layoutInput } from "../input";
import { modelPickerRowCount, type ModelPickerState } from "../model-picker";
import {
  completedItemGapAbove,
  completedItemRows,
  liveContentRows,
  resolveLiveContent,
} from "../session-content";
import { STATUS_BAR_ROWS } from "../status-bar";
import { pinLiveFrameRows } from "../terminal-output";
import type { TuiState } from "../state";
import type { TuiToolCard } from "../tool-ledger";
import { activitySlotRowCount } from "./activity";

const INPUT_BORDER_ROWS = 2;
const PENDING_BANNER_ROWS = 1;
// The shared output container owns the footer gap for text, reasoning and tools.
// Use the same value in the rendered layout and its height budget.
export const LIVE_GUTTER_ROWS = 1;

export type LiveFrame = {
  readonly frameRows: number;
  readonly liveGapAbove: number;
  readonly activeTools: readonly TuiToolCard[];
};

function liveFooterRows({
  state,
  inputRows,
  modelPickerState,
}: {
  readonly state: TuiState;
  readonly inputRows: number;
  readonly modelPickerState: ModelPickerState;
}): number {
  const pendingRows = state.pending === null ? 0 : PENDING_BANNER_ROWS;
  const chromeRows = state.modelPickerActive
    ? modelPickerRowCount(modelPickerState)
    : inputRows + INPUT_BORDER_ROWS;
  return (
    pendingRows +
    activitySlotRowCount(state) +
    LIVE_GUTTER_ROWS +
    chromeRows +
    STATUS_BAR_ROWS
  );
}

export function useLiveFrame({
  state,
  modelPickerState,
  stdout,
  rows,
  inputWidth,
  maxInputRows,
  transcriptWidth,
}: {
  readonly state: TuiState;
  readonly modelPickerState: ModelPickerState;
  readonly stdout: NodeJS.WriteStream;
  readonly rows: number;
  readonly inputWidth: number;
  readonly maxInputRows: number;
  readonly transcriptWidth: number;
}): LiveFrame {
  const { activeTools, gapAbove: liveGapAbove } = resolveLiveContent(state);
  const liveHeightRef = useRef<number | undefined>(undefined);
  const emittedStaticCountRef = useRef(0);
  const freshSession = state.completedOutput.length === 0;
  const inputRows = layoutInput(
    state.input,
    state.inputCursor,
    inputWidth,
    maxInputRows,
  ).length;
  const footerRows = liveFooterRows({
    state,
    inputRows,
    modelPickerState,
  });
  const newStaticRows = freshSession
    ? 0
    : state.completedOutput
        .slice(emittedStaticCountRef.current)
        .reduce(
          (sum, item, index) =>
            sum +
            completedItemRows(item, transcriptWidth) +
            completedItemGapAbove(
              state.completedOutput,
              emittedStaticCountRef.current + index,
            ),
          0,
        );
  // Static output consumes the remaining live area; resetting to terminal
  // height here would push earlier results upward while blank rows remain.
  const frameRows = Math.min(
    rows,
    Math.max(
      footerRows + liveGapAbove + liveContentRows(state, activeTools, transcriptWidth),
      freshSession
        ? rows
        : newStaticRows > 0
          ? (liveHeightRef.current ?? rows) - newStaticRows
          : (liveHeightRef.current ?? rows),
    ),
  );
  pinLiveFrameRows(stdout, frameRows);
  useLayoutEffect(() => {
    emittedStaticCountRef.current = state.completedOutput.length;
    liveHeightRef.current = freshSession ? undefined : frameRows;
  }, [frameRows, freshSession, state.completedOutput.length]);

  return {
    frameRows,
    liveGapAbove,
    activeTools,
  };
}
