import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { Harness } from "../core/harness.js";
import {
  createTuiState,
  formatProviderFailure,
  formatToolCallDetail,
  reduceTuiState,
  resolveInputIntent,
  type TuiInputIntent,
  type TuiMessage,
  type TuiState,
  type TuiToolCard,
} from "./state.js";

export type TuiAppProps = {
  readonly harness: Harness;
  readonly startNewSession: () => Harness | Promise<Harness>;
  readonly onExit?: () => void;
};

export function TuiApp({
  harness: initialHarness,
  startNewSession,
  onExit,
}: TuiAppProps) {
  const [harness, setHarness] = useState(initialHarness);
  const [state, dispatch] = useReducer(
    reduceTuiState,
    harness,
    createHarnessState,
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
    const nextHarness = await startNewSession();
    setHarness(nextHarness);
    dispatch({ type: "new-session", snapshot: nextHarness.getSnapshot() });
  }, [startNewSession]);

  const executeIntent = useCallback(
    async (intent: TuiInputIntent) => {
      if (
        intent.type === "insert" ||
        intent.type === "newline" ||
        intent.type === "backspace" ||
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
          <ToolCardView key={tool.id} tool={tool} />
        ))}
        {state.stream !== null && <StreamView state={state} />}
      </Box>
      {state.approval !== null && (
        <ApprovalDialog
          name={state.approval.toolCall.name}
          detail={formatToolCallDetail(state.approval.toolCall)}
        />
      )}
      <StatusLine state={state} now={now} />
      <InputBox input={state.input} />
      <Text dimColor>
        Enter 发送 · Ctrl+J/Shift+Space 换行 · Ctrl+C 分级中断 · /exit /clear
      </Text>
    </Box>
  );
}

function createHarnessState(harness: Harness): TuiState {
  return createTuiState(harness.getSnapshot());
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

function ToolCardView({ tool }: { readonly tool: TuiToolCard }) {
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
    <Box flexDirection="column" borderStyle="round" paddingLeft={1} paddingRight={1}>
      <Text color={color}>
        {marker} {tool.name} · {tool.detail}
      </Text>
      {tool.summary === "" ? null : <Text>{tool.summary}</Text>}
      {tool.preview?.map((line, index) => (
        <Text key={`preview-${index}`} dimColor>
          {index === 0 ? "  " : "  "} {line}
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

function ApprovalDialog({
  name,
  detail,
}: {
  readonly name: string;
  readonly detail: string;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor="magenta"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      marginTop={1}
    >
      <Text color="magenta">Tool 审批 · {name}</Text>
      <Text>{detail}</Text>
      <Text dimColor>Enter 允许 · Esc / Ctrl+C 拒绝</Text>
    </Box>
  );
}

function StatusLine({
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
      <Text color="yellow">
        ⏳ {state.retry.reason} · {(remainingMs / 1000).toFixed(1)} 秒后重试（
        {state.retry.retry}/{state.retry.maxRetries}）
      </Text>
    );
  }
  if (state.failure !== null) {
    return (
      <Text color="red">
        ⚠ Provider 请求失败 · {formatProviderFailure(state.failure)} · Enter
        重试 · Esc 放弃
      </Text>
    );
  }
  if (state.status === "running" || state.status === "awaiting-approval") {
    return <Text color="yellow">▍ 生成中 · Ctrl+C 中断</Text>;
  }
  if (state.notice !== null) {
    return <Text color="yellow">ⓘ {state.notice}</Text>;
  }
  return <Text dimColor>空闲</Text>;
}

function InputBox({ input }: { readonly input: string }) {
  const lines = input.split("\n");
  return (
    <Box borderStyle="round" flexDirection="column" paddingLeft={1}>
      {lines.length === 1 && lines[0] === "" ? (
        <Text dimColor>输入消息…</Text>
      ) : (
        lines.map((line, index) => (
          <Text key={`input-${index}`}>
            {index === 0 ? "输入 ▸ " : "      "}
            {line}
            {index === lines.length - 1 ? "▍" : null}
          </Text>
        ))
      )}
    </Box>
  );
}
