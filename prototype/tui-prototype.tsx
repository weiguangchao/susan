import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";

type VariantKey = "A" | "B" | "C";

type Variant = {
  readonly key: VariantKey;
  readonly name: string;
  readonly purpose: string;
};

type PrototypeMessage = {
  readonly kind: "user" | "assistant" | "reasoning";
  readonly text: string;
};

type PrototypeTool = {
  readonly name: string;
  readonly status: "running" | "waiting-approval" | "completed" | "failed";
  readonly detail: string;
};

type PrototypeMode =
  | "idle"
  | "running"
  | "awaiting-approval"
  | "pending"
  | "failure";

type PrototypeState = {
  readonly variant: VariantKey;
  readonly mode: PrototypeMode;
  readonly input: string;
  readonly messages: readonly PrototypeMessage[];
  readonly tools: readonly PrototypeTool[];
  readonly notice: string | null;
  readonly lastAction: string;
  readonly actionCount: number;
};

const variants: readonly Variant[] = [
  { key: "A", name: "Linear", purpose: "阅读优先的线性消息流" },
  { key: "B", name: "Console", purpose: "左侧内容 + 右侧活动栏" },
  { key: "C", name: "Deck", purpose: "顶部状态舱 + 结构化消息区" },
];

const initialMessages: readonly PrototypeMessage[] = [
  {
    kind: "user",
    text: "帮我读取 src/ui/state.ts，并总结输入状态机。",
  },
  {
    kind: "assistant",
    text: "输入状态机覆盖插入、换行、删除、提交、审批、中断与恢复。临时状态只留在 TUI，Transcript 仍由 Harness 稳定边界驱动。",
  },
];

const initialTools: readonly PrototypeTool[] = [
  {
    name: "read_file",
    status: "completed",
    detail: "src/ui/state.ts",
  },
];

function createInitialState(variant: VariantKey): PrototypeState {
  return {
    variant,
    mode: "idle",
    input: "",
    messages: initialMessages,
    tools: initialTools,
    notice: null,
    lastAction: "prototype started",
    actionCount: 0,
  };
}

function TuiPrototype() {
  const [state, setState] = useState(() => createInitialState("A"));
  const stateRef = useRef(state);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 30;
  const columns = stdout?.columns ?? 100;

  stateRef.current = state;

  const update = useCallback((next: Omit<PrototypeState, "actionCount">, action: string) => {
    setState({
      ...next,
      actionCount: stateRef.current.actionCount + 1,
      lastAction: action,
    });
  }, []);

  const switchVariant = useCallback(
    (direction: 1 | -1) => {
      const currentIndex = variants.findIndex((variant) => variant.key === stateRef.current.variant);
      const nextIndex = (currentIndex + direction + variants.length) % variants.length;
      const variant = variants[nextIndex]?.key ?? "A";
      setState((current) => ({
        ...current,
        variant,
        notice: null,
        actionCount: current.actionCount + 1,
        lastAction: `switch to variant ${variant}`,
      }));
    },
    [],
  );

  const submit = useCallback(() => {
    const current = stateRef.current;
    const content = current.input.trim();
    if (content === "") {
      update(
        { ...current, notice: "输入为空，未提交" },
        "submit rejected: empty input",
      );
      return;
    }
    if (content === "/clear") {
      update(
        { ...current, input: "", messages: [], tools: [], mode: "idle", notice: "已清空原型状态" },
        "command /clear",
      );
      return;
    }
    if (content === "/tool") {
      update(
        {
          ...current,
          input: "",
          mode: "awaiting-approval",
          messages: [
            ...current.messages,
            { kind: "user", text: content },
          ],
          tools: [
            ...current.tools,
            {
              name: "read_file",
              status: "waiting-approval",
              detail: "package.json",
            },
          ],
          notice: "Tool 需要审批",
        },
        "command /tool",
      );
      return;
    }
    if (content === "/fail") {
      update(
        {
          ...current,
          input: "",
          mode: "failure",
          notice: "Provider 请求失败",
        },
        "command /fail",
      );
      return;
    }
    if (content === "/retry") {
      update(
        {
          ...current,
          input: "",
          mode: "idle",
          notice: null,
          messages: [
            ...current.messages,
            { kind: "assistant", text: "已从稳定边界重试，并继续当前 Agent Loop。" },
          ],
        },
        "command /retry",
      );
      return;
    }

    update(
      {
        ...current,
        input: "",
        mode: "idle",
        notice: null,
        messages: [
          ...current.messages,
          { kind: "user", text: content },
          {
            kind: "assistant",
            text: "这是原型中的模拟回复，用来评估布局与交互，不请求真实 Provider。",
          },
        ],
      },
      "submit message",
    );
  }, [update]);

  const resolveApproval = useCallback(
    (approved: boolean) => {
      const current = stateRef.current;
      const tools = current.tools.map((tool, index) =>
        index === current.tools.length - 1
          ? {
              ...tool,
              status: approved ? ("completed" as const) : ("failed" as const),
            }
          : tool,
      );
      update(
        {
          ...current,
          mode: "idle",
          tools,
          notice: approved ? "已允许 Tool 调用" : "已拒绝 Tool 调用",
          messages: [
            ...current.messages,
            {
              kind: "assistant",
              text: approved
                ? "Tool 调用完成，结果已回填到当前 Agent Loop。"
                : "Tool 调用被拒绝，错误结果已回填给模型。",
            },
          ],
        },
        approved ? "approve tool" : "deny tool",
      );
    },
    [update],
  );

  useInput((input, key) => {
    const current = stateRef.current;

    if (key.ctrl && input === "c") {
      exit();
      return;
    }
    if (key.leftArrow) {
      switchVariant(-1);
      return;
    }
    if (key.rightArrow) {
      switchVariant(1);
      return;
    }
    if (key.tab) {
      switchVariant(key.shift ? -1 : 1);
      return;
    }
    if (key.escape && current.mode === "awaiting-approval") {
      resolveApproval(false);
      return;
    }
    if (key.return) {
      if (current.mode === "awaiting-approval") {
        resolveApproval(true);
      } else if (current.mode === "failure") {
        update(
          { ...current, mode: "idle", notice: null },
          "retry from failure",
        );
      } else {
        submit();
      }
      return;
    }
    if (key.ctrl && input === "j") {
      update(
        { ...current, input: `${current.input}\n` },
        "newline",
      );
      return;
    }
    if (key.shift && input === " ") {
      update(
        { ...current, input: `${current.input}\n` },
        "newline",
      );
      return;
    }
    if (key.backspace) {
      update(
        { ...current, input: current.input.slice(0, -1), notice: null },
        "backspace",
      );
      return;
    }
    if (input === "") {
      return;
    }

    update(
      { ...current, input: current.input + input, notice: null },
      `insert ${JSON.stringify(input)}`,
    );
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      if (stateRef.current.mode === "running") {
        setState((current) => ({
          ...current,
          mode: "idle",
          actionCount: current.actionCount + 1,
          lastAction: "simulated running state ended",
        }));
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [state.actionCount, state.mode]);

  const currentVariant = useMemo(
    () => variants.find((variant) => variant.key === state.variant) ?? variants[0],
    [state.variant],
  );
  const bodyHeight = Math.max(14, rows - 7);

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      {state.variant === "A" ? (
        <LinearVariant state={state} height={bodyHeight} />
      ) : null}
      {state.variant === "B" ? (
        <ConsoleVariant state={state} height={bodyHeight} columns={columns} />
      ) : null}
      {state.variant === "C" ? (
        <DeckVariant state={state} height={bodyHeight} />
      ) : null}
      <PrototypeSwitcher variant={currentVariant} />
      <StateStrip state={state} />
    </Box>
  );
}

function LinearVariant({
  state,
  height,
}: {
  readonly state: PrototypeState;
  readonly height: number;
}) {
  const transcript = [...state.messages, ...toolMessages(state.tools)].slice(-10);
  return (
    <Box flexDirection="column" flexGrow={1} height={height} paddingTop={1}>
      <Text dimColor>PROTOTYPE · 不接真实 Provider · ←/→ 或 Tab 切换</Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {transcript.map((message, index) => (
          <Text
            key={`${message.kind}-${index}`}
            color={message.kind === "user" ? "cyan" : message.kind === "reasoning" ? "gray" : undefined}
            dimColor={message.kind === "reasoning"}
          >
            {message.kind === "user" ? "你 ▸ " : message.kind === "reasoning" ? "… ▸ " : "susan ▸ "}
            {message.text}
          </Text>
        ))}
        {state.mode === "awaiting-approval" ? (
          <Text color="magenta">审批 ▸ read_file package.json · Enter 允许 / Esc 拒绝</Text>
        ) : null}
      </Box>
      <Text color={statusColor(state.mode)}>{statusText(state.mode)} · {state.notice ?? "Enter 提交 · Ctrl+J 换行"}</Text>
      <Box flexDirection="column" marginTop={1}>
        <InputLines input={state.input} prefix="❯ " />
      </Box>
    </Box>
  );
}

function ConsoleVariant({
  state,
  height,
  columns,
}: {
  readonly state: PrototypeState;
  readonly height: number;
  readonly columns: number;
}) {
  const transcript = [...state.messages, ...toolMessages(state.tools)].slice(-8);
  const railWidth = Math.max(24, Math.floor(columns * 0.3));
  return (
    <Box flexDirection="column" flexGrow={1} height={height} paddingTop={1}>
      <Text>PROTOTYPE · Console · 左侧 Transcript / 右侧 Activity</Text>
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {transcript.map((message, index) => (
            <Text
              key={`${message.kind}-${index}`}
              color={message.kind === "user" ? "cyan" : undefined}
              dimColor={message.kind === "reasoning"}
            >
              {message.kind === "user" ? "user · " : message.kind === "reasoning" ? "think · " : "agent · "}
              {message.text}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" width={railWidth} borderStyle="single" paddingLeft={1} paddingRight={1}>
          <Text color={statusColor(state.mode)}>STATUS {state.mode}</Text>
          <Text>NOTICE {state.notice ?? "-"}</Text>
          <Text>TOOLS {state.tools.length}</Text>
          {state.tools.slice(-4).map((tool, index) => (
            <Text key={`${tool.name}-${index}`} color={toolColor(tool.status)}>
              {tool.status === "completed" ? "OK" : tool.status === "failed" ? "NO" : "WAIT"} {tool.name}
            </Text>
          ))}
          <Text dimColor>Enter 提交</Text>
          <Text dimColor>Ctrl+J 换行</Text>
          {state.mode === "awaiting-approval" ? (
            <Text color="magenta">审批 read_file · Enter/Esc</Text>
          ) : null}
        </Box>
      </Box>
      <Box borderStyle="round" paddingLeft={1} marginTop={1}>
        <InputLines input={state.input} prefix="input ▸ " />
      </Box>
    </Box>
  );
}

function DeckVariant({
  state,
  height,
}: {
  readonly state: PrototypeState;
  readonly height: number;
}) {
  const transcript = [...state.messages, ...toolMessages(state.tools)].slice(-8);
  return (
    <Box flexDirection="column" flexGrow={1} height={height} paddingTop={1}>
      <Box flexDirection="row" marginBottom={1} flexShrink={0}>
        <DeckCell label="MODE" value={state.mode} color={statusColor(state.mode)} width={16} />
        <DeckCell label="TOOLS" value={`${state.tools.length}`} width={14} />
        <DeckCell label="NOTICE" value={state.notice ?? "none"} width={26} />
      </Box>
      <Box flexDirection="column" borderStyle="single" flexGrow={1} paddingLeft={1} overflow="hidden">
        <Text dimColor>TRANSCRIPT</Text>
        {transcript.map((message, index) => (
          <Box key={`${message.kind}-${index}`} flexDirection="row">
            <Box width={10}>
              <Text color={message.kind === "user" ? "cyan" : "gray"}>
                {message.kind === "user" ? "USER" : message.kind === "reasoning" ? "THINK" : "AGENT"}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text dimColor={message.kind === "reasoning"}>{message.text}</Text>
            </Box>
          </Box>
        ))}
        {state.mode === "awaiting-approval" ? (
          <Box borderStyle="round" borderColor="magenta" paddingLeft={1}>
            <Text color="magenta">TOOL APPROVAL · read_file package.json</Text>
            <Text dimColor>Enter 允许 · Esc 拒绝</Text>
          </Box>
        ) : null}
      </Box>
      <Box borderStyle="round" paddingLeft={1} marginTop={1} flexShrink={0}>
        <InputLines input={state.input} prefix="compose ▸ " />
      </Box>
    </Box>
  );
}

function DeckCell({
  label,
  value,
  color,
  width,
}: {
  readonly label: string;
  readonly value: string;
  readonly color?: string;
  readonly width: number;
}) {
  return (
    <Box flexDirection="column" width={width} paddingLeft={1}>
      <Text dimColor>{label}</Text>
      <Text color={color}>{value}</Text>
    </Box>
  );
}

function InputLines({
  input,
  prefix,
}: {
  readonly input: string;
  readonly prefix: string;
}) {
  const lines = input.split("\n");
  if (input === "") {
    return <Text dimColor>{prefix}输入消息，或 /tool /fail /retry /clear</Text>;
  }
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={`line-${index}`}>
          {index === 0 ? prefix : " ".repeat(prefix.length)}
          {line}
          {index === lines.length - 1 ? "▍" : null}
        </Text>
      ))}
    </Box>
  );
}

function PrototypeSwitcher({ variant }: { readonly variant: Variant }) {
  return (
    <Box justifyContent="center" marginTop={1}>
      <Box borderStyle="round" paddingLeft={1} paddingRight={1}>
        <Text>← {variant.key} · {variant.name} · {variant.purpose} →</Text>
      </Box>
    </Box>
  );
}

function StateStrip({ state }: { readonly state: PrototypeState }) {
  const visibleInput = state.input.replace(/\n/g, "\\n");
  return (
    <Box justifyContent="center">
      <Text dimColor>
        STATE {state.actionCount} · variant={state.variant} · mode={state.mode} · input="{visibleInput}" · messages={state.messages.length} · tools={state.tools.length} · notice={state.notice ?? "null"} · last={state.lastAction}
      </Text>
    </Box>
  );
}

function toolMessages(tools: readonly PrototypeTool[]): readonly PrototypeMessage[] {
  return tools.map((tool) => ({
    kind: "reasoning",
    text: `${tool.name} · ${tool.status} · ${tool.detail}`,
  }));
}

function statusColor(mode: PrototypeMode): string {
  if (mode === "failure" || mode === "pending") {
    return "red";
  }
  if (mode === "running" || mode === "awaiting-approval") {
    return "yellow";
  }
  return "green";
}

function toolColor(status: PrototypeTool["status"]): string {
  if (status === "completed") {
    return "green";
  }
  if (status === "failed") {
    return "red";
  }
  return "yellow";
}

function statusText(mode: PrototypeMode): string {
  if (mode === "awaiting-approval") {
    return "等待审批";
  }
  if (mode === "failure") {
    return "Provider 失败";
  }
  if (mode === "pending") {
    return "Pending Agent Loop";
  }
  if (mode === "running") {
    return "生成中";
  }
  return "空闲";
}

render(<TuiPrototype />);
