import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import {
  Box,
  Static,
  Text,
  useApp,
  useCursor,
  useInput,
  useStdout,
} from "ink";
import stringWidth from "string-width";
import type { AssemblyConfigView, ConfigUpdateResult, HarnessAssembly } from "@weiguangchao/susan-harness";
import { formatConfigError } from "../core/config-error";
import type {
  Harness,
  HarnessError,
} from "@weiguangchao/susan-harness";
import {
  createModelPickerState,
  modelPickerRowCount,
  reduceModelPickerState,
  resolveModelPickerIntent,
  type ModelPickerCatalog,
  type ModelPickerSelection,
  type ModelPickerState,
} from "../core/model-picker";
import {
  inputBoxWidth,
  inputContentWidth,
  inputImeCursorPosition,
  layoutInput,
} from "./input-layout";
import { pinLiveFrameRows } from "./terminal-output";
import { ModelPickerView } from "./model-picker";
import {
  formatToolCallDetail,
  toolResultRows,
  type TuiToolCard,
  type TuiToolResultRow,
} from "./tool-ledger";
import {
  resolveSlashCommandMenu,
  type SlashCommandMenu,
} from "./slash-command-menu";
import {
  createTuiState,
  formatProviderFailure,
  reduceTuiState,
  resolveInputIntent,
  type TuiCompletedOutput,
  type TuiInputIntent,
  type TuiMessage,
  type TuiState,
} from "./state";

export type TuiAppProps = {
  readonly harness: Harness;
  readonly inputHistory: readonly string[];
  readonly assembly: HarnessAssembly;
  readonly modelCatalog: ModelPickerCatalog;
  readonly onExit?: () => void;
};

export function modelPickerCatalog(config: AssemblyConfigView): ModelPickerCatalog {
  return {
    defaultProviderAlias: config.defaultProvider,
    preferredModel: config.defaultModel,
    preferredReasoningEffort: config.defaultReasoningEffort,
    providers: config.providers.map(({ host, ...provider }) => ({ ...provider, baseURL: host })),
  };
}

export function assemblyErrorMessage(result: Exclude<ConfigUpdateResult, { kind: "updated" }>): string {
  return result.kind === "config-error" ? formatConfigError(result.error).heading : result.error.message;
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
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { rows, columns } = useTerminalDimensions(stdout);
  const stateRef = useRef(state);
  const modelPickerStateRef = useRef(modelPickerState);
  const operationRef = useRef(false);
  const now = useNow(state.retry !== null);

  stateRef.current = state;
  modelPickerStateRef.current = modelPickerState;

  useEffect(() => {
    const unsubscribe = harness.subscribe((event) => {
      dispatch({ type: "harness-event", event });
      dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
    });
    dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
    return unsubscribe;
  }, [harness]);

  const quit = useCallback(() => {
    if (onExit === undefined) {
      exit();
      return;
    }
    onExit();
  }, [exit, onExit]);

  const replaceSession = useCallback(async () => {
    const result = await assembly.assemble({ session: { kind: "new" }, newSessionCwd: harness.getSnapshot().cwd });
    if (result.kind !== "ready") {
      if (result.kind !== "session-picker") dispatch({ type: "notice", message: assemblyErrorMessage(result) });
      return;
    }
    setHarness(result.harness);
    setModelPickerState(createModelPickerState(modelPickerCatalog(result.config)));
    dispatch({ type: "new-session", snapshot: result.harness.getSnapshot(), inputHistory: result.inputHistory });
  }, [harness, assembly]);

  const refreshConfig = useCallback(async () => {
    const result = await assembly.reload();
    if (result.kind !== "updated") {
      dispatch({ type: "notice", message: assemblyErrorMessage(result) });
      return;
    }
    setModelPickerState(createModelPickerState(modelPickerCatalog(result.config)));
    dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
    dispatch({ type: "notice", message: "配置已重新加载" });
  }, [assembly, harness]);

  const handleModelError = useCallback(
    (error: HarnessError) => {
      if (error.code === "HARNESS_MODEL_CONFIG_INCOMPLETE") {
        setModelPickerState((current) =>
          createModelPickerState(current.catalog),
        );
        dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
        dispatch({
          type: "input-intent",
          intent: { type: "model-picker" },
        });
        return;
      }
      dispatch({ type: "notice", message: error.message });
    },
    [dispatch, harness],
  );

  const executeIntent = useCallback(
    async (intent: TuiInputIntent) => {
      if (
        intent.type === "insert" ||
        intent.type === "newline" ||
        intent.type === "backspace" ||
        intent.type === "move-cursor-up" ||
        intent.type === "move-cursor-down" ||
        intent.type === "move-cursor-left" ||
        intent.type === "move-cursor-right" ||
        intent.type === "move-cursor-to-line-start" ||
        intent.type === "move-cursor-to-line-end" ||
        intent.type === "history-previous" ||
        intent.type === "history-next" ||
        intent.type === "move-slash-command-selection" ||
        intent.type === "notice" ||
        intent.type === "clear-input" ||
        intent.type === "dismiss-failure"
      ) {
        return;
      }
      if (intent.type === "exit") {
        quit();
        return;
      }
      if (intent.type === "clear" || intent.type === "new-session") {
        await replaceSession();
        return;
      }
      if (intent.type === "reload") {
        await refreshConfig();
        return;
      }
      if (intent.type === "model-picker") {
        setModelPickerState((current) =>
          createModelPickerState(current.catalog),
        );
        return;
      }
      if (intent.type === "compact") {
        const result = await harness.compact(intent.customInstructions);
        dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
        if (!result.ok) handleModelError(result.error);
        return;
      }
      if (intent.type === "submit") {
        const result = await harness.dispatch({
          type: "submit",
          content: intent.content,
        });
        if (!result.ok) {
          handleModelError(result.error);
        }
        return;
      }
      if (intent.type === "interrupt") {
        await harness.dispatch({ type: "interrupt" });
        return;
      }
      if (intent.type === "retry") {
        const result = await harness.dispatch({ type: "retry" });
        if (!result.ok) {
          handleModelError(result.error);
        }
      }
    },
    [dispatch, handleModelError, harness, quit, replaceSession, refreshConfig],
  );

  const applyPickerSelection = useCallback(
    async (selection: ModelPickerSelection) => {
      const result = await assembly.applyModelSelection(selection);
      if (result.kind !== "updated") {
        dispatch({ type: "notice", message: assemblyErrorMessage(result) });
        return;
      }
      dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
      setModelPickerState(createModelPickerState(modelPickerCatalog(result.config)));
      dispatch({ type: "close-model-picker" });
      dispatch({ type: "notice", message: "模型配置已更新" });
    },
    [assembly, dispatch, harness],
  );

  const inputWidth = inputContentWidth(columns);
  const transcriptWidth = Math.max(1, columns - 1);
  const maxInputRows = Math.max(
    1,
    Math.min(10, Math.floor(rows * 0.4) - 2),
  );

  useInput((input, key) => {
    if (isKeyboardProtocolResponse(input)) {
      return;
    }
    if (operationRef.current) return;
    const currentState = {
      ...stateRef.current,
      status: harness.getSnapshot().status,
    };
    if (currentState.modelPickerActive) {
      const pickerIntent = resolveModelPickerIntent(
        modelPickerStateRef.current,
        {
          input,
          upArrow: key.upArrow,
          downArrow: key.downArrow,
          leftArrow: key.leftArrow,
          rightArrow: key.rightArrow,
          tab: key.tab,
          return: key.return,
          escape: key.escape,
        },
      );
      if (pickerIntent.type === "cancel") {
        dispatch({ type: "close-model-picker" });
        return;
      }
      if (pickerIntent.type === "apply") {
        operationRef.current = true;
        void applyPickerSelection(pickerIntent.selection).finally(() => { operationRef.current = false; });
        return;
      }
      setModelPickerState((current) =>
        reduceModelPickerState(current, pickerIntent),
      );
      return;
    }

    const intent = resolveInputIntent(currentState, {
      input,
      ctrl: key.ctrl,
      shift: key.shift,
      return: key.return,
      escape: key.escape,
      backspace: key.backspace,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      leftArrow: key.leftArrow,
      rightArrow: key.rightArrow,
      inputWidth,
    });
    dispatch({
      type: "input-intent",
      intent,
    });
    if (intent.type === "clear" || intent.type === "new-session" || intent.type === "reload") {
      operationRef.current = true;
      void executeIntent(intent).finally(() => { operationRef.current = false; });
    } else {
      void executeIntent(intent);
    }
  });

  const completedToolIds = new Set(
    state.completedOutput.flatMap((item) =>
      item.kind === "tool-batch" ? item.tools.map((tool) => tool.id) : [],
    ),
  );
  const activeTools = state.tools.filter(
    (tool) => !completedToolIds.has(tool.id) && tool.status !== "requested" && tool.status !== "running",
  );
  const lastCompleted = state.completedOutput.at(-1);
  const liveGapAbove = (state.stream !== null || state.awaitingModelAfterTools) &&
    lastCompleted !== undefined &&
    (lastCompleted.kind === "tool-batch" ||
      lastCompleted.message.kind === "reasoning" ||
      lastCompleted.message.kind === "assistant") ? 1 : 0;

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
      footerRows + liveGapAbove + liveContentRows(state.stream, activeTools, transcriptWidth) +
        (state.awaitingModelAfterTools || (state.stream !== null && state.stream.reasoning === "" && state.stream.text === "") ? 1 : 0),
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

type TerminalDimensions = {
  readonly rows: number;
  readonly columns: number;
};

function readTerminalDimensions(stdout: NodeJS.WriteStream): TerminalDimensions {
  const output = stdout as NodeJS.WriteStream & { readonly terminalRows?: number };
  const rows =
    output.terminalRows ?? (stdout.rows > 0 ? stdout.rows : 24);
  return {
    rows: rows > 0 ? rows : 24,
    columns: stdout.columns > 0 ? stdout.columns : 80,
  };
}

function useTerminalDimensions(
  stdout: NodeJS.WriteStream,
): TerminalDimensions {
  const [dimensions, setDimensions] = useState(() =>
    readTerminalDimensions(stdout),
  );

  useEffect(() => {
    const updateDimensions = () => {
      const next = readTerminalDimensions(stdout);
      setDimensions((current) =>
        current.rows === next.rows && current.columns === next.columns
          ? current
          : next,
      );
    };

    updateDimensions();
    stdout.on("resize", updateDimensions);
    return () => {
      stdout.off("resize", updateDimensions);
    };
  }, [stdout]);

  return dimensions;
}

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

export function useActivityPhase(active: boolean): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setPhase((current) => current + 1), 180);
    return () => clearInterval(timer);
  }, [active]);
  return phase;
}

function isKeyboardProtocolResponse(input: string): boolean {
  return /^\x1b\[\?\d+u$/.test(input) || /^\[\?\d+u$/.test(input);
}

function PendingBanner({
  notice,
  allowRetry,
}: {
  readonly notice: string | null;
  readonly allowRetry: boolean;
}) {
  return (
    <Box paddingLeft={1}>
      <Text color="yellow">
        ⚠ {notice ?? "上次响应未完成（Pending Agent Loop）"} ·{" "}
        {allowRetry ? "r 重试 · n 新对话" : "n 新对话"}
      </Text>
    </Box>
  );
}

const USER_MESSAGE_BAR = "▌";
const USER_MESSAGE_BAR_COLUMNS = 2;

function wrapLines(text: string, width: number): readonly string[] {
  const usable = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const character of Array.from(paragraph)) {
      const characterWidth = stringWidth(character);
      if (currentWidth + characterWidth > usable && current !== "") {
        lines.push(current);
        current = character;
        currentWidth = characterWidth;
      } else {
        current += character;
        currentWidth += characterWidth;
      }
    }
    lines.push(current);
  }
  return lines;
}

// Compact output presentation without changing the stored message content.
// Rendering and height accounting must consume the same visible rows.
function outputLines(text: string, width: number): readonly string[] {
  return wrapLines(text, width).filter(line => line.trim() !== "");
}

function MessageView({
  message,
  width,
  gapAbove = 0,
}: {
  readonly message: TuiMessage;
  readonly width: number;
  readonly gapAbove?: number;
}) {
  if (message.kind === "user") {
    const lines = wrapLines(message.text, width - USER_MESSAGE_BAR_COLUMNS);
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {lines.map((line, index) => (
          <Text key={index} wrap="truncate-end">
            <Text color="cyan">{USER_MESSAGE_BAR} </Text>
            <Text bold>{line}</Text>
          </Text>
        ))}
      </Box>
    );
  }
  if (message.kind === "assistant") {
    const lines = outputLines(message.text, width);
    return (
      <Box flexDirection="column" marginTop={gapAbove}>
        {lines.map((line, index) => (
          <Text key={index} wrap="truncate-end">
            {line === "" ? " " : line}
          </Text>
        ))}
      </Box>
    );
  }
  if (message.kind === "reasoning") {
    const lines = outputLines(message.text, width);
    return (
      <Box flexDirection="column">
        {message.durationMs === undefined ? null : (
          <Text dimColor wrap="truncate-end">
            {thinkDurationLabel(message.durationMs)}
          </Text>
        )}
        {lines.map((line, index) => (
          <Text key={index} dimColor wrap="truncate-end">
            {line === "" ? " " : line}
          </Text>
        ))}
      </Box>
    );
  }
  if (message.kind === "interrupted") {
    const lines = wrapLines(message.text, width);
    return (
      <Box flexDirection="column">
        {lines.map((line, index) => (
          <Text key={index} color="red" wrap="truncate-end">
            {index === 0 ? <Text>[已中断] </Text> : null}
            {line === "" ? " " : line}
          </Text>
        ))}
        <Text dimColor>└ 未写入 Session Transcript · Enter 显式重试</Text>
      </Box>
    );
  }
  return <Text color="red">⚠ {message.text}</Text>;
}

function CompletedOutputView({
  item,
  width,
  gapAbove = 0,
}: {
  readonly item: TuiCompletedOutput;
  readonly width: number;
  readonly gapAbove?: number;
}) {
  return (
    <Box flexDirection="column" flexShrink={0} paddingLeft={1} marginTop={gapAbove}>
      {item.kind === "message" ? (
        <MessageView message={item.message} width={width} />
      ) : (
        <ToolLedgerView tools={item.tools} />
      )}
    </Box>
  );
}

export function SessionContentView({
  messages,
  tools,
  width = 80,
}: {
  readonly messages: readonly TuiMessage[];
  readonly tools: readonly TuiToolCard[];
  readonly width?: number;
}) {
  return (
    <>
      <ToolLedgerView tools={tools} />
      {messages.map((message, index) => (
        <MessageView
          key={`message-${index}`}
          message={message}
          width={width}
          gapAbove={messageGapAbove(messages, index)}
        />
      ))}
    </>
  );
}

function messageGapAbove(
  messages: readonly TuiMessage[],
  index: number,
): number {
  if (index === 0) {
    return 0;
  }
  return messages[index - 1]?.kind === "reasoning" &&
    messages[index]?.kind === "assistant"
    ? 1
    : 0;
}

function completedItemGapAbove(
  items: readonly TuiCompletedOutput[],
  index: number,
): number {
  if (index === 0) {
    return 0;
  }
  const previous = items[index - 1]!;
  const item = items[index]!;
  const previousKind = previous.kind === "message" ? previous.message.kind : previous.kind;
  const currentKind = item.kind === "message" ? item.message.kind : item.kind;
  const outputKinds = ["reasoning", "assistant", "tool-batch"];
  return previousKind !== currentKind &&
    outputKinds.includes(previousKind) && outputKinds.includes(currentKind) ? 1 : 0;
}

export function ToolLineView({ tool }: { readonly tool: TuiToolCard }) {
  if (tool.status === "requested" || tool.status === "running") return null;
  const color = tool.status === "completed" ? "green" : "red";
  return (
    <Box justifyContent="space-between" width="100%" flexShrink={0}>
      <Box flexShrink={1} marginRight={1}>
        <Text wrap="truncate-end">
          <Text bold color={color}>{tool.name}</Text>
          <Text dimColor> {tool.invocationLabel}</Text>
        </Text>
      </Box>
      {tool.summary === "" ? null : (
        <Box flexShrink={0}>
          <Text dimColor wrap="truncate-end">
            {tool.summary}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function ToolLedgerView({
  tools,
}: {
  readonly tools: readonly TuiToolCard[];
}) {
  const results = tools.filter(tool => tool.status !== "requested" && tool.status !== "running");
  return (
    <Box flexDirection="column" flexShrink={0} width="100%">
      {results.map((tool) => (
        <Box key={tool.id} flexDirection="column" flexShrink={0} width="100%">
          <ToolLineView tool={tool} />
          <ToolResultRows tool={tool} />
        </Box>
      ))}
    </Box>
  );
}

function ToolResultRows({ tool }: { readonly tool: TuiToolCard }) {
  const rows = toolResultRows(tool);
  const gutterWidth = toolGutterWidth(rows);
  return (
    <>
      {rows.map((row, index) => (
        <ToolResultRowView
          key={`${tool.id}-result-${index}`}
          row={row}
          gutterWidth={gutterWidth}
          failed={tool.status === "failed" && tool.name !== "bash"}
        />
      ))}
    </>
  );
}

function ToolResultRowView({
  row,
  gutterWidth,
  failed,
}: {
  readonly row: TuiToolResultRow;
  readonly gutterWidth: number;
  readonly failed: boolean;
}) {
  if (row.gap) {
    return (
      <Text dimColor italic wrap="truncate-end">
        {"⋮".padStart(gutterWidth, " ")}  {row.text}
      </Text>
    );
  }
  if (row.lineNumber === undefined) {
    const empty = row.text === "(empty)" || row.text === "无匹配" || row.text === "空目录";
    return (
      <Text
        color={failed ? "red" : undefined}
        dimColor={empty}
        italic={empty}
        wrap="truncate-end"
      >
        {" ".repeat(gutterWidth + 2)}{row.text}
      </Text>
    );
  }
  const signColor = row.sign === "+" ? "green" : row.sign === "-" ? "red" : undefined;
  const dimBody = row.sign === " ";
  return (
    <Text wrap="truncate-end">
      <Text
        color={signColor}
        dimColor={signColor === undefined}
      >
        {formatGutter(row, gutterWidth)}  </Text>
      <Text
        color={signColor}
        dimColor={dimBody}
      >
        {row.text}
      </Text>
    </Text>
  );
}

function formatGutter(row: TuiToolResultRow, gutterWidth: number): string {
  const digits = String(row.lineNumber ?? "").padStart(gutterWidth, " ");
  if ((row.sign !== "+" && row.sign !== "-") || !digits.startsWith(" ")) {
    return digits;
  }
  return `${row.sign}${digits.slice(1)}`;
}

function toolGutterWidth(rows: readonly TuiToolResultRow[]): number {
  const numbers = rows.flatMap((row) =>
    row.lineNumber === undefined ? [] : [row.lineNumber],
  );
  if (numbers.length === 0) {
    return 4;
  }
  return Math.max(4, String(Math.max(...numbers)).length);
}

const THINK_LABEL = "Thinking";
const WORKING_LABEL = "Working";
export const WORKING_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;

function workingSpinnerFrame(phase: number): string {
  return WORKING_SPINNER_FRAMES[phase % WORKING_SPINNER_FRAMES.length]!;
}

function thinkDurationLabel(durationMs: number): string {
  return `Think · ${(durationMs / 1000).toFixed(1)} 秒`;
}

function WorkingActivityLabel({
  label,
  phase,
  durationText,
}: {
  readonly label: string;
  readonly phase: number;
  readonly durationText?: string;
}) {
  return (
    <Text bold wrap="truncate-end">
      <Text color="cyan">{workingSpinnerFrame(phase)} </Text>
      {label}
      {durationText ? <Text dimColor bold={false}> · {durationText}</Text> : null}
    </Text>
  );
}

function StreamView({
  state,
  width,
}: {
  readonly state: TuiState;
  readonly width: number;
}) {
  const stream = state.stream;
  const reasoning = stream?.reasoning ?? "";
  const text = stream?.text ?? "";
  const thinking = stream !== null && text === "" && state.status === "running" &&
    state.retry === null && state.failure === null && !state.awaitingModelAfterTools;
  const active = thinking || state.awaitingModelAfterTools;
  const phase = useActivityPhase(active);
  const activityLabel = state.awaitingModelAfterTools ? WORKING_LABEL : THINK_LABEL;
  const thinkingStartedAt = thinking && stream !== null ? stream.reasoningStartedAt : null;
  const now = useNow(thinkingStartedAt !== null);
  const durationText =
    thinkingStartedAt === null
      ? undefined
      : `${(Math.max(0, now - thinkingStartedAt) / 1000).toFixed(1)}s`;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {active ? (
        <WorkingActivityLabel
          label={activityLabel}
          phase={phase}
          durationText={durationText}
        />
      ) : reasoning === "" ? null : (
        <Text dimColor wrap="truncate-end">
          {thinkDurationLabel(
            Math.max(
              0,
              (stream?.reasoningEndedAt ?? 0) -
                (stream?.reasoningStartedAt ?? 0),
            ),
          )}
        </Text>
      )}
      {reasoning === ""
        ? null
        : outputLines(thinking && text === "" ? `${reasoning}▍` : reasoning, width).map(
            (line, index) => (
              <Text key={index} dimColor wrap="truncate-end">
                {line === "" ? " " : line}
              </Text>
            ),
          )}
      {text === "" ? null : (
        <Box flexDirection="column" marginTop={reasoning === "" ? 0 : 1}>
          {outputLines(`${text}▍`, width).map((line, index) => (
            <Text key={index} wrap="truncate-end">
              {line === "" ? " " : line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

export function ActivityLine({
  state,
  now,
}: {
  readonly state: TuiState;
  readonly now: number;
}) {
  if (state.retry !== null) {
    const remainingMs = Math.max(
      0,
      state.retry.startedAt + state.retry.delayMs - now,
    );
    return (
      <Box paddingLeft={1}>
        <Text color="yellow">
          ⏳ {state.retry.reason} · {(remainingMs / 1000).toFixed(1)} 秒后重试（
          {state.retry.retry}/{state.retry.maxRetries}）
        </Text>
      </Box>
    );
  }
  if (state.failure !== null) {
    return (
      <Box paddingLeft={1}>
        <Text color="red">
          ⚠ Provider 请求失败 · {formatProviderFailure(state.failure)}
        </Text>
      </Box>
    );
  }
  if (state.status === "running") {
    return null;
  }
  const slashCommandMenu = resolveSlashCommandMenu(state);
  if (slashCommandMenu.visible) {
    return <SlashCommandMenuView menu={slashCommandMenu} />;
  }
  if (state.notice !== null) {
    return (
      <Box paddingLeft={1}>
        <Text color="yellow">ⓘ {state.notice}</Text>
      </Box>
    );
  }
  return null;
}

export function SlashCommandMenuView({
  menu,
}: {
  readonly menu: SlashCommandMenu;
}) {
  if (menu.candidates.length === 0) {
    return (
      <Box paddingLeft={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">无匹配</Text>
      </Box>
    );
  }

  const query = menu.query ?? "/";
  const matchLength = query === "/" ? 0 : query.length;
  return (
    <Box flexDirection="column" flexShrink={0}>
      {menu.candidates.map((command, index) => (
        <Box key={command.name} paddingLeft={1} paddingRight={1}>
          <Text wrap="truncate-end">
            <Text color={index === menu.selectedIndex ? "cyanBright" : undefined}>
              {index === menu.selectedIndex ? "›" : " "}
            </Text>{" "}
            {matchLength === 0 ? (
              command.name
            ) : (
              <>
                <Text color="cyanBright" bold>
                  {command.name.slice(0, matchLength)}
                </Text>
                {command.name.slice(matchLength)}
              </>
            )}{" "}
            <Text dimColor>{command.label}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  );
}

const STEADY_UNDERLINE_CURSOR = "\u001B[4 q";
const RESET_CURSOR_SHAPE = "\u001B[0 q";

const STATUS_ROWS = 1;
const INPUT_BORDER_ROWS = 2;
const PENDING_BANNER_ROWS = 1;
// The shared output container owns the footer gap for text, reasoning and tools.
// Use the same value in the rendered layout and its height budget.
const LIVE_GUTTER_ROWS = 1;

function wrappedRowCount(text: string, width: number): number {
  const usableWidth = Math.max(1, width);
  return text.split("\n").reduce((sum, line) => {
    const lineWidth = stringWidth(line);
    return sum + Math.max(1, Math.ceil(lineWidth / usableWidth) || 1);
  }, 0);
}

function completedItemRows(
  item: TuiCompletedOutput,
  width: number,
): number {
  if (item.kind === "tool-batch") {
    return item.tools.reduce(
      (sum, tool) => sum + 1 + toolResultRows(tool).length,
      0,
    );
  }
  if (item.message.kind === "interrupted") {
    return 2;
  }
  if (item.message.kind === "user") {
    return (
      wrapLines(item.message.text, width - USER_MESSAGE_BAR_COLUMNS).length + 2
    );
  }
  if (item.message.kind === "assistant") {
    return outputLines(item.message.text, width).length;
  }
  if (item.message.kind === "reasoning") {
    return (
      (item.message.durationMs === undefined ? 0 : 1) +
      outputLines(item.message.text, width).length
    );
  }
  return wrappedRowCount(`⚠ ${item.message.text}`, width);
}

// Let growing live output reclaim terminal rows from completed Static output.
// The previous frame height is a floor, not a fixed viewport for later streams.
function liveContentRows(
  stream: TuiState["stream"],
  tools: readonly TuiToolCard[],
  width: number,
): number {
  const reasoning = stream?.reasoning ?? "";
  const text = stream?.text ?? "";
  const reasoningRows = reasoning === "" ? 0 : 1 +
    outputLines(text === "" ? `${reasoning}▍` : reasoning, width).length;
  const textRows = text === "" ? 0 :
    (reasoning === "" ? 0 : 1) + outputLines(`${text}▍`, width).length;
  return reasoningRows + textRows + tools.reduce(
    (sum, tool) => sum + 1 + toolResultRows(tool).length, 0,
  );
}

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
  let activityRows = 0;
  if (state.retry !== null || state.failure !== null) {
    activityRows = 1;
  } else if (state.status !== "running") {
    const menu = resolveSlashCommandMenu(state);
    if (menu.visible) {
      activityRows = Math.max(1, menu.candidates.length);
    } else if (state.notice !== null) {
      activityRows = 1;
    }
  }
  return (
    pendingRows +
    activityRows +
    LIVE_GUTTER_ROWS +
    chromeRows +
    STATUS_ROWS
  );
}

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

export function StatusBar({ state }: { readonly state: TuiState }) {
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
