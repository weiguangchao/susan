import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Static, useStdout } from "ink";
import type { Harness, HarnessAssembly } from "@weiguangchao/susan-harness";
import { ImeInputLine, inputContentWidth } from "../input";
import {
  createModelPickerState,
  ModelPickerView,
  type ModelPickerCatalog,
} from "../model-picker";
import {
  CompletedOutputView,
  StreamView,
  completedItemGapAbove,
} from "../session-content";
import { ToolLedgerView } from "../tool-ledger";
import { StatusBar } from "../status-bar";
import {
  createTuiState,
  reduceTuiState,
  type TuiState,
} from "../state";
import { ActivityLine, PendingBanner } from "./activity";
import { useHarness } from "./use-harness";
import { useIntents } from "./use-intents";
import { useTuiInput } from "./use-input";
import { LIVE_GUTTER_ROWS, useLiveFrame } from "./use-live-frame";
import { useTerminalDimensions } from "./use-terminal-dimensions";

export type TuiAppProps = {
  readonly harness: Harness;
  readonly inputHistory: readonly string[];
  readonly assembly: HarnessAssembly;
  readonly modelCatalog: ModelPickerCatalog;
  readonly onExit?: () => void;
};

function createHarnessState(
  harness: Harness,
  inputHistory: readonly string[],
): TuiState {
  return createTuiState(harness.getSnapshot(), inputHistory);
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function TuiApp({
  harness: initialHarness,
  inputHistory,
  assembly,
  modelCatalog,
  onExit,
}: TuiAppProps) {
  const [harness, setHarness] = useState(initialHarness);
  const [modelPickerState, setModelPickerState] = useState(() =>
    createModelPickerState(modelCatalog),
  );
  const [state, dispatch] = useReducer(
    reduceTuiState,
    harness,
    (currentHarness) => createHarnessState(currentHarness, inputHistory),
  );
  const { stdout } = useStdout();
  const { rows, columns } = useTerminalDimensions(stdout);
  const stateRef = useRef(state);
  const modelPickerStateRef = useRef(modelPickerState);
  const operationRef = useRef(false);
  const now = useNow(state.retry !== null);

  stateRef.current = state;
  modelPickerStateRef.current = modelPickerState;

  useHarness(harness, dispatch);

  const { executeIntent, applyPickerSelection } = useIntents({
    harness,
    assembly,
    dispatch,
    setHarness,
    setModelPickerState,
    onExit,
  });

  const inputWidth = inputContentWidth(columns);
  const transcriptWidth = Math.max(1, columns - 1);
  const maxInputRows = Math.max(
    1,
    Math.min(10, Math.floor(rows * 0.4) - 2),
  );

  useTuiInput({
    harness,
    stateRef,
    modelPickerStateRef,
    operationRef,
    dispatch,
    setModelPickerState,
    executeIntent,
    applyPickerSelection,
    inputWidth,
  });

  const { frameRows, liveGapAbove, activeTools } = useLiveFrame({
    state,
    modelPickerState,
    stdout,
    rows,
    inputWidth,
    maxInputRows,
    transcriptWidth,
  });

  return (
    <>
      <Static items={[...state.completedOutput]}>
        {(item, index) => (
          <CompletedOutputView
            key={item.id}
            item={item}
            width={transcriptWidth}
            gapAbove={completedItemGapAbove(state.completedOutput, index)}
          />
        )}
      </Static>
      <Box
        flexDirection="column"
        height={frameRows}
        width={columns}
      >
        {state.pending !== null && (
          <PendingBanner notice={state.notice} allowRetry={true} />
        )}
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          overflow="hidden"
          justifyContent="flex-end"
          paddingLeft={1}
          marginBottom={LIVE_GUTTER_ROWS}
        >
          {/* Keep natural content height: shrinking multiline text can overlap
              reasoning and answers. Fill short frames from the top; clip only
              the beginning of overflowing live content to show its latest rows. */}
          <Box flexDirection="column" flexGrow={1} flexShrink={0} paddingTop={liveGapAbove}>
            {(state.stream !== null || state.awaitingModelAfterTools) && (
              <StreamView state={state} width={transcriptWidth} />
            )}
            <ToolLedgerView tools={activeTools} />
          </Box>
        </Box>
        <ActivityLine state={state} now={now} />
        {state.modelPickerActive ? (
          <ModelPickerView state={modelPickerState} />
        ) : (
          <ImeInputLine
            input={state.input}
            cursor={state.inputCursor}
            columns={columns}
            screenRows={frameRows}
            maxRows={maxInputRows}
          />
        )}
        <StatusBar state={state} />
      </Box>
    </>
  );
}
