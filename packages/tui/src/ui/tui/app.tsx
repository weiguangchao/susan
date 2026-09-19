import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Static, Text, useCursor, useStdout } from "ink";
import type { Harness, HarnessAssembly } from "@weiguangchao/susan-harness";
import {
  createModelPickerState,
  ModelPickerView,
  type ModelPickerCatalog,
} from "../model-picker";
import {
  inputBoxWidth,
  inputContentWidth,
  inputImeCursorPosition,
  layoutInput,
} from "../input-layout";
import {
  CompletedOutputView,
  StreamView,
  ToolLedgerView,
  completedItemGapAbove,
} from "../session-content";
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

const STEADY_UNDERLINE_CURSOR = "\u001B[4 q";
const RESET_CURSOR_SHAPE = "\u001B[0 q";

function ImeInputLine({
  input,
  cursor,
  columns,
  screenRows,
  maxRows,
}: {
  readonly input: string;
  readonly cursor: TuiState["inputCursor"];
  readonly columns: number;
  readonly screenRows: number;
  readonly maxRows: number;
}) {
  const { stdout } = useStdout();
  const { setCursorPosition } = useCursor();
  const visualRows = layoutInput(
    input,
    cursor,
    inputContentWidth(columns),
    maxRows,
  );
  setCursorPosition(
    inputImeCursorPosition({
      visualRows,
      screenRows,
    }),
  );
  useEffect(() => {
    stdout.write(STEADY_UNDERLINE_CURSOR);
    return () => {
      stdout.write(RESET_CURSOR_SHAPE);
    };
  }, [stdout]);
  return (
    <InputLine
      input={input}
      cursor={cursor}
      columns={columns}
      maxRows={maxRows}
    />
  );
}

export function InputLine({
  input,
  cursor,
  columns = 80,
  maxRows = 10,
}: {
  readonly input: string;
  readonly cursor: TuiState["inputCursor"];
  readonly columns?: number;
  readonly maxRows?: number;
}) {
  const boxWidth = inputBoxWidth(columns);
  const contentWidth = inputContentWidth(columns);
  const rows = layoutInput(input, cursor, contentWidth, maxRows);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text>╭{"─".repeat(Math.max(0, boxWidth - 2))}╮</Text>
      <Box
        borderStyle="round"
        borderTop={false}
        width={boxWidth}
        height={rows.length + 1}
        overflow="hidden"
        flexDirection="column"
        flexShrink={0}
      >
        <Box
          flexDirection="column"
          width={Math.max(1, boxWidth - 2)}
          height={rows.length}
          overflow="hidden"
          paddingLeft={1}
          paddingRight={1}
        >
          {rows.map((row, index) => (
            <Text key={`input-${index}`} wrap="truncate-end">
              {index === 0 ? "❯ " : "  "}
              {row.text}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
