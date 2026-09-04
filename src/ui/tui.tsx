import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Harness } from "../core/harness.js";
import {
  createTuiState,
  formatProviderFailure,
  formatToolCallDetail,
  isEmptySession,
  reduceTuiState,
  resolveInputIntent,
  type TuiInputIntent,
  type TuiMessage,
  type TuiState,
  type TuiToolCard,
} from "./state.js";

export type TuiAppProps = {
  readonly harness: Harness;
  readonly inputHistory: readonly string[];
  readonly startNewSession: () => Harness | Promise<Harness>;
  readonly onExit?: () => void;
};

export function TuiApp({
  harness: initialHarness,
  inputHistory,
  startNewSession,
  onExit,
}: TuiAppProps) {
  const [harness, setHarness] = useState(initialHarness);
  const [state, dispatch] = useReducer(
    reduceTuiState,
    harness,
    (currentHarness) => createHarnessState(currentHarness, inputHistory),
  );
  const { exit } = useApp();
  const { stdout } = useStdout();
  const stateRef = useRef(state);
  const now = useNow(state.retry !== null);

  stateRef.current = state;

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
      if (intent.type === "submit") {
        const result = await harness.dispatch({
          type: "submit",
          content: intent.content,
        });
        if (!result.ok) {
          dispatch({ type: "notice", message: result.error.message });
        }
        return;
      }
      if (intent.type === "interrupt") {
        await harness.dispatch({ type: "interrupt" });
        return;
      }
      if (
        intent.type === "approve-approval" ||
        intent.type === "deny-approval"
      ) {
        const result = await harness.dispatch({
          type: "resolve-approval",
          approvalId: intent.approvalId,
          approved: intent.type === "approve-approval",
        });
        if (!result.ok) {
          dispatch({ type: "notice", message: result.error.message });
        }
        return;
      }
      if (intent.type === "retry") {
        const result = await harness.dispatch({ type: "retry" });
        if (!result.ok) {
          dispatch({ type: "notice", message: result.error.message });
        }
      }
    },
    [dispatch, harness, quit, replaceSession],
  );

  useInput((input, key) => {
    if (isKeyboardProtocolResponse(input)) {
      return;
    }
    const currentState = {
      ...stateRef.current,
      status: harness.getSnapshot().status,
    };
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
    });
    dispatch({
      type: "input-intent",
      intent,
    });
    void executeIntent(intent);
  });

  const rows = stdout?.rows ?? 24;
  const columns = Math.max(60, stdout?.columns ?? 80);
  const visibleMessages = state.messages.slice(-20);
  const visibleTools = state.tools.slice(-8);

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      {state.pending !== null && <PendingBanner notice={state.notice} />}
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingLeft={1}>
        {visibleMessages.map((message, index) => (
          <MessageView key={`message-${index}`} message={message} />
        ))}
        {visibleTools.map((tool) => (
          <ToolLineView key={tool.id} tool={tool} />
        ))}
        {state.stream !== null && <StreamView state={state} />}
      </Box>
      {state.approval !== null && (
        <ApprovalLine
          name={state.approval.toolCall.name}
          detail={formatToolCallDetail(state.approval.toolCall)}
        />
      )}
      <ActivityLine state={state} now={now} />
      <InputLine input={state.input} cursor={state.inputCursor} />
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

function isKeyboardProtocolResponse(input: string): boolean {
  return /^\x1b\[\?\d+u$/.test(input) || /^\[\?\d+u$/.test(input);
}

function PendingBanner({ notice }: { readonly notice: string | null }) {
  return (
    <Box paddingLeft={1}>
      <Text color="yellow">
        ⚠ {notice ?? "上次响应未完成（Pending Agent Loop）"} · r 重试 · n 新对话
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

function ToolLineView({ tool }: { readonly tool: TuiToolCard }) {
  const color =
    tool.status === "completed"
      ? "green"
      : tool.status === "denied" ||
          tool.status === "failed" ||
          tool.status === "interrupted"
        ? "red"
        : "yellow";
  const marker =
    tool.status === "completed"
      ? "✓"
      : tool.status === "denied" ||
          tool.status === "failed" ||
          tool.status === "interrupted"
        ? "✗"
        : "⏳";
  return (
    <Box flexDirection="column">
      <Text color={color}>
        {marker} {tool.name} · {tool.detail}
      </Text>
      {tool.summary === "" ? null : (
        <Text dimColor>  └ {tool.summary}</Text>
      )}
      {tool.preview?.map((line, index) => (
        <Text key={`preview-${index}`} dimColor>
            {line}
        </Text>
      ))}
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

function ApprovalLine({
  name,
  detail,
}: {
  readonly name: string;
  readonly detail: string;
}) {
  return (
    <Box flexDirection="column" paddingLeft={1} flexShrink={0}>
      <Text color="magenta">
        审批 ▸ {name} · {detail}
      </Text>
      <Text dimColor>      Enter 允许 · Esc / Ctrl+C 拒绝</Text>
    </Box>
  );
}

function ActivityLine({
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
  if (state.status === "running" || state.status === "awaiting-approval") {
    return (
      <Box paddingLeft={1}>
        <Text color="yellow">▍ 生成中</Text>
      </Box>
    );
  }
  if (state.notice !== null) {
    return (
      <Box paddingLeft={1}>
        <Text color="yellow">ⓘ {state.notice}</Text>
      </Box>
    );
  }
  return (
    <Box paddingLeft={1}>
      <Text dimColor>空闲</Text>
    </Box>
  );
}

function InputLine({
  input,
  cursor,
}: {
  readonly input: string;
  readonly cursor: TuiState["inputCursor"];
}) {
  const lines = input.split("\n");
  return (
    <Box
      borderStyle="round"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      {lines.map((line, index) => (
        <Text key={`input-${index}`}>
          {index === 0 ? "❯ " : "  "}
          {cursor.row === index
            ? `${line.slice(0, cursor.column)}▍${line.slice(cursor.column)}`
            : line}
        </Text>
      ))}
    </Box>
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
        {formatTokenCount(state.sessionTotalTokens)} /{" "}
        {percentage.toFixed(1)}%
      </Text>
      <Text dimColor>
        {state.model} · {state.reasoningLevel}
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
