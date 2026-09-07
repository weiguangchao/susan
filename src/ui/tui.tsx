import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useCursor, useInput, useStdout } from "ink";
import type {
  Harness,
  HarnessCommand,
  HarnessError,
} from "../core/harness.js";
import {
  createModelPickerState,
  reduceModelPickerState,
  resolveModelPickerIntent,
  type ModelPickerCatalog,
  type ModelPickerSelection,
} from "../core/model-picker.js";
import {
  inputBoxWidth,
  inputContentWidth,
  inputImeCursorPosition,
  layoutInput,
} from "./input-layout.js";
import { ModelPickerView } from "./model-picker.js";
import {
  createTuiState,
  formatProviderFailure,
  formatToolCallDetail,
  isEmptySession,
  reduceTuiState,
  resolveInputIntent,
  resolveSlashCommandMenu,
  type SlashCommandMenu,
  type TuiInputIntent,
  type TuiMessage,
  type TuiState,
  type TuiToolCard,
} from "./state.js";

export type TuiAppProps = {
  readonly harness: Harness;
  readonly inputHistory: readonly string[];
  readonly startNewSession: () => Harness | Promise<Harness>;
  readonly modelCatalog: ModelPickerCatalog;
  readonly applyModelSelection: (
    selection: ModelPickerSelection,
  ) => Promise<ModelSelectionApplyResult>;
  readonly onExit?: () => void;
};

export type ConfigureModelCommand = Extract<
  HarnessCommand,
  { type: "configure-model" }
>;

export type ModelSelectionApplyResult =
  | { readonly ok: true; readonly command: ConfigureModelCommand }
  | { readonly ok: false; readonly message: string };

export function TuiApp({
  harness: initialHarness,
  inputHistory,
  startNewSession,
  modelCatalog,
  applyModelSelection,
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
  const stateRef = useRef(state);
  const modelPickerStateRef = useRef(modelPickerState);
  const now = useNow(state.retry !== null);
  const inputWorking =
    state.status === "running" && state.retry === null && state.failure === null;
  const activityPhase = useActivityPhase(inputWorking);

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
    const snapshot = harness.getSnapshot();
    if (isEmptySession(snapshot)) {
      dispatch({ type: "new-session", snapshot });
      return;
    }
    const nextHarness = await startNewSession();
    setHarness(nextHarness);
    dispatch({ type: "new-session", snapshot: nextHarness.getSnapshot() });
  }, [harness, startNewSession]);

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
      if (intent.type === "model-picker") {
        setModelPickerState((current) =>
          createModelPickerState(current.catalog),
        );
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
    [dispatch, handleModelError, harness, quit, replaceSession],
  );

  const applyPickerSelection = useCallback(
    async (selection: ModelPickerSelection) => {
      const result = await applyModelSelection(selection);
      if (!result.ok) {
        dispatch({ type: "notice", message: result.message });
        return;
      }
      const configured = await harness.dispatch(result.command);
      if (!configured.ok) {
        dispatch({ type: "notice", message: configured.error.message });
        return;
      }
      dispatch({ type: "snapshot", snapshot: harness.getSnapshot() });
      setModelPickerState((current) =>
        createModelPickerState({
          ...current.catalog,
          defaultProviderAlias: selection.providerAlias,
          preferredModel: selection.model,
          preferredReasoningEffort: selection.reasoningEffort,
        }),
      );
      dispatch({ type: "close-model-picker" });
      dispatch({ type: "notice", message: "模型配置已更新" });
    },
    [applyModelSelection, dispatch, harness],
  );

  const rows = stdout?.rows && stdout.rows > 0 ? stdout.rows : 24;
  const columns =
    stdout?.columns && stdout.columns > 0 ? stdout.columns : 80;
  const inputWidth = inputContentWidth(columns);
  const maxInputRows = Math.max(
    1,
    Math.min(10, Math.floor(rows * 0.4) - 2),
  );

  useInput((input, key) => {
    if (isKeyboardProtocolResponse(input)) {
      return;
    }
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
        void applyPickerSelection(pickerIntent.selection);
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
    void executeIntent(intent);
  });

  const visibleMessages = state.messages.slice(-20);
  const visibleTools = state.tools.slice(-8);

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      {state.pending !== null && (
        <PendingBanner
          notice={state.notice}
          allowRetry={state.pending.reason !== "compatibility"}
        />
      )}
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingLeft={1}>
        <SessionContentView messages={visibleMessages} tools={visibleTools} />
        {state.stream !== null && <StreamView state={state} />}
      </Box>
      <ActivityLine state={state} now={now} />
      {state.modelPickerActive ? (
        <ModelPickerView state={modelPickerState} />
      ) : (
        <ImeInputLine
          input={state.input}
          cursor={state.inputCursor}
          columns={columns}
          screenRows={rows}
          maxRows={maxInputRows}
          working={inputWorking}
          activityPhase={activityPhase}
        />
      )}
      <StatusBar state={state} />
    </Box>
  );
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

function useActivityPhase(active: boolean): number {
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

function MessageView({ message }: { readonly message: TuiMessage }) {
  if (message.kind === "user") {
    return (
      <Text color="cyan">
        你 ▸ {message.text}
      </Text>
    );
  }
  if (message.kind === "assistant") {
    return (
      <Text>
        susan ▸ {message.text}
      </Text>
    );
  }
  if (message.kind === "reasoning") {
    return (
      <Text dimColor>
        reasoning ▸ {message.text}
      </Text>
    );
  }
  if (message.kind === "interrupted") {
    return (
      <Box flexDirection="column">
        <Text color="red">susan ▸ [已中断] {message.text}</Text>
        <Text dimColor>└ 未写入 Session Transcript · Enter 显式重试</Text>
      </Box>
    );
  }
  return <Text color="red">⚠ {message.text}</Text>;
}

export function SessionContentView({
  messages,
  tools,
}: {
  readonly messages: readonly TuiMessage[];
  readonly tools: readonly TuiToolCard[];
}) {
  return (
    <>
      <ToolLedgerView tools={tools} />
      {messages.map((message, index) => (
        <MessageView key={`message-${index}`} message={message} />
      ))}
    </>
  );
}

export function ToolLineView({ tool }: { readonly tool: TuiToolCard }) {
  const color =
    tool.status === "completed"
      ? "green"
      : tool.status === "failed" ||
          tool.status === "interrupted"
        ? "red"
        : "yellow";
  const marker =
    tool.status === "completed"
      ? "✓"
      : tool.status === "failed" ||
          tool.status === "interrupted"
        ? "✗"
        : tool.status === "running"
          ? "●"
          : "⏳";
  return (
    <Text color={color} wrap="truncate-end">
      {marker} {tool.name} · {tool.invocationLabel}{tool.summary === "" ? "" : ` · ${tool.summary}`}
    </Text>
  );
}

export function ToolLedgerView({
  tools,
}: {
  readonly tools: readonly TuiToolCard[];
}) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {tools.map((tool) => (
        <ToolLineView key={tool.id} tool={tool} />
      ))}
      {tools.flatMap((tool) =>
        tool.supplementalLines.map((line, index) => (
          <Text key={`${tool.id}-detail-${index}`} dimColor wrap="truncate-end">
            {"  └ "}{tool.name} · {line}
          </Text>
        )),
      )}
    </Box>
  );
}

function StreamView({ state }: { readonly state: TuiState }) {
  return (
    <Box flexDirection="column">
      {state.stream?.reasoning === "" ? null : (
        <Text dimColor>reasoning ▸ {state.stream?.reasoning}▍</Text>
      )}
      {state.stream?.text === "" ? null : (
        <Text>
          susan ▸ {state.stream?.text}▍
        </Text>
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

function ImeInputLine({
  input,
  cursor,
  columns,
  screenRows,
  maxRows,
  working,
  activityPhase,
}: {
  readonly input: string;
  readonly cursor: TuiState["inputCursor"];
  readonly columns: number;
  readonly screenRows: number;
  readonly maxRows: number;
  readonly working: boolean;
  readonly activityPhase: number;
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
      working={working}
      activityPhase={activityPhase}
    />
  );
}

export function InputLine({
  input,
  cursor,
  columns = 80,
  maxRows = 10,
  working = false,
  activityPhase = 0,
}: {
  readonly input: string;
  readonly cursor: TuiState["inputCursor"];
  readonly columns?: number;
  readonly maxRows?: number;
  readonly working?: boolean;
  readonly activityPhase?: number;
}) {
  const boxWidth = inputBoxWidth(columns);
  const contentWidth = inputContentWidth(columns);
  const rows = layoutInput(input, cursor, contentWidth, maxRows);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <InputTopBorder
        width={boxWidth}
        working={working}
        phase={activityPhase}
      />
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

const WORKING_LABEL = "Working...";
const WORKING_OFFSET = 4;
const WORKING_PALETTE = [
  "#42646c",
  "#568894",
  "#73b9ca",
  "#bdf5ff",
  "#73b9ca",
  "#568894",
] as const;

export function workingColorAt(index: number, phase: number): string {
  const colorIndex =
    ((index - phase) % WORKING_PALETTE.length + WORKING_PALETTE.length) %
    WORKING_PALETTE.length;
  return WORKING_PALETTE[colorIndex]!;
}

function InputTopBorder({
  width,
  working,
  phase,
}: {
  readonly width: number;
  readonly working: boolean;
  readonly phase: number;
}) {
  const innerWidth = Math.max(0, width - 2);
  if (!working) {
    return <Text>╭{"─".repeat(innerWidth)}╮</Text>;
  }
  const occupiedWidth = WORKING_OFFSET + WORKING_LABEL.length + 2;
  return (
    <Text>
      ╭{"─".repeat(WORKING_OFFSET)}{" "}
      <Text bold>
        {[...WORKING_LABEL].map((character, index) => {
          return (
            <Text
              key={`${index}-${character}`}
              color={workingColorAt(index, phase)}
            >
              {character}
            </Text>
          );
        })}
      </Text>{" "}
      {"─".repeat(Math.max(0, innerWidth - occupiedWidth))}╮
    </Text>
  );
}

function StatusBar({ state }: { readonly state: TuiState }) {
  const percentage = (state.sessionTotalTokens / state.contextWindow) * 100;

  return (
    <Box
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <Text dimColor>
        {formatTokenCount(state.sessionTotalTokens)}/{percentage.toFixed(1)}%
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
