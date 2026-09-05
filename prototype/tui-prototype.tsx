// Three slash-command hint-bar variants above Susan's input, switchable with
// Ctrl+N / Ctrl+P or --variant=A|B|C. PROTOTYPE ONLY — do not ship.
import { useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";

type Variant = "A" | "B" | "C";

type Command = {
  readonly name: "/exit" | "/new" | "/model";
  readonly shortLabel: string;
  readonly description: string;
  readonly group: string;
};

const variants: readonly Variant[] = ["A", "B", "C"];
const variantNames: Record<Variant, string> = {
  A: "命令轨",
  B: "展开菜单",
  C: "操作台",
};

const commands: readonly Command[] = [
  { name: "/exit", shortLabel: "退出", description: "结束 Susan", group: "应用" },
  { name: "/new", shortLabel: "新对话", description: "开始空白 Session", group: "会话" },
  { name: "/model", shortLabel: "模型", description: "切换模型与推理强度", group: "配置" },
];

const session = {
  model: "gpt-5-codex",
  reasoning: "high",
  tokens: "18.4k",
  context: "14.4%",
};

export function PrototypeApp({ initialVariant = "A" }: { readonly initialVariant?: Variant }) {
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [input, setInput] = useState("");
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = Math.max(20, stdout?.rows ?? 24);
  const columns = Math.max(64, stdout?.columns ?? 80);

  const cycle = (direction: -1 | 1) => {
    setVariant((current) => {
      const index = variants.indexOf(current);
      return variants[(index + direction + variants.length) % variants.length];
    });
  };

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      exit();
      return;
    }
    if (key.ctrl && value === "n") {
      cycle(1);
      return;
    }
    if (key.ctrl && value === "p") {
      cycle(-1);
      return;
    }
    if (key.backspace) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (key.return) {
      setInput("");
      return;
    }
    if (value !== "") {
      setInput((current) => `${current}${value}`);
    }
  });

  const matchedCommand = commands.find((command) => command.name.startsWith(input));

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingLeft={1}>
        <Text color="cyan">你 ▸ 帮我整理今天的开发计划</Text>
        <Text>susan ▸ 我会先检查当前分支和未完成的 issue，再给出优先顺序。</Text>
        <Text color="green">✓ read_file · AGENTS.md</Text>
        <Text dimColor>  └ 已读取项目协作约定</Text>
      </Box>

      {variant === "A" ? <VariantA input={input} /> : null}
      {variant === "B" ? (
        <>
          <SessionState />
          <VariantB input={input} />
        </>
      ) : null}
      {variant === "C" ? (
        <>
          <SessionState />
          <VariantC input={input} />
        </>
      ) : null}

      <InputLine input={input} />
      <StatusLine />
      <PrototypeSwitcher current={variant} />

      <Box paddingLeft={1}>
        <Text dimColor>
          prototype state ▸ variant={variant} · input={input === "" ? "∅" : input} · match={matchedCommand?.name ?? "none"}
        </Text>
      </Box>
    </Box>
  );
}

function VariantA({ input }: { readonly input: string }) {
  return (
    <Box paddingLeft={1} paddingRight={1} flexShrink={0}>
      <Text dimColor>空闲  ·  命令 </Text>
      {commands.map((command, index) => {
        const active = command.name.startsWith(input) && input.startsWith("/");
        return (
          <Text key={command.name}>
            <Text color={active ? "cyanBright" : undefined} bold={active}>{command.name}</Text>
            <Text dimColor> {command.shortLabel}</Text>
            {index < commands.length - 1 ? <Text dimColor>  ·  </Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

function SessionState() {
  return (
    <Box paddingLeft={1}>
      <Text dimColor>空闲</Text>
    </Box>
  );
}

function VariantB({ input }: { readonly input: string }) {
  const active = commands.find((command) => command.name.startsWith(input));
  return (
    <Box borderStyle="single" borderColor="gray" flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <Text dimColor>斜杠命令</Text>
      {commands.map((command) => {
        const selected = input === "" ? command.name === "/new" : command.name === active?.name;
        return (
          <Text key={command.name}>
            <Text color={selected ? "cyanBright" : undefined}>{selected ? "›" : " "} {command.name.padEnd(8)}</Text>
            <Text bold={selected}>{command.shortLabel.padEnd(8)}</Text>
            <Text dimColor>{command.description}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function VariantC({ input }: { readonly input: string }) {
  return (
    <Box flexDirection="row" gap={1} flexShrink={0}>
      {commands.map((command) => {
        const active = command.name.startsWith(input) && input.startsWith("/");
        return (
          <Box key={command.name} borderStyle="round" borderColor={active ? "cyan" : "gray"} flexDirection="column" paddingLeft={1} paddingRight={1} flexGrow={1}>
            <Text dimColor>{command.group.toUpperCase()}</Text>
            <Text color={active ? "cyanBright" : undefined} bold>{command.name}  {command.shortLabel}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function InputLine({ input }: { readonly input: string }) {
  return (
    <Box borderStyle="round" flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <Text>❯ {input}<Text inverse> </Text></Text>
    </Box>
  );
}

function StatusLine() {
  return (
    <Box justifyContent="space-between" paddingLeft={1} paddingRight={1}>
      <Text dimColor>{session.tokens} / {session.context}</Text>
      <Text dimColor>{session.model} · {session.reasoning}</Text>
    </Box>
  );
}

function PrototypeSwitcher({ current }: { readonly current: Variant }) {
  return (
    <Box justifyContent="center" marginTop={1}>
      <Box backgroundColor="blue" paddingLeft={1} paddingRight={1}>
        <Text color="white" bold>Ctrl+P  ←  {current} · {variantNames[current]}  →  Ctrl+N</Text>
      </Box>
    </Box>
  );
}

function parseVariant(value: string): Variant {
  return value === "B" || value === "C" ? value : "A";
}

const arg = process.argv.find((item) => item.startsWith("--variant="));
const initialVariant = parseVariant(arg?.split("=")[1] ?? "A");

render(<PrototypeApp initialVariant={initialVariant} />);
