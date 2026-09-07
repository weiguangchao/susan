// Three match-segment treatments for Slash Command Menu (Q6), switchable via
// --variant=A|B|C, ←/→, or Ctrl+N / Ctrl+P. Mounted in fake Susan idle chrome.
// PROTOTYPE ONLY — do not ship.
//
// Question: with prefix-on-规范名 already locked, how should the match
// segment paint, and how should the never-matching 短标签 look?
import { useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";

type Variant = "A" | "B" | "C";

type Command = {
  readonly name: "/exit" | "/model" | "/new";
  readonly label: string;
};

const variants: readonly Variant[] = ["A", "B", "C"];
const variantNames: Record<Variant, string> = {
  A: "着色加粗",
  B: "只加粗",
  C: "反色块",
};
const variantTheses: Record<Variant, string> = {
  A: "匹配段 cyanBright+bold；规范名剩余默认；短标签始终 dim",
  B: "匹配段只 bold、不用颜色；规范名剩余默认；短标签始终 dim",
  C: "匹配段 inverse；规范名剩余默认；短标签始终 dim",
};

const commands: readonly Command[] = [
  { name: "/exit", label: "退出" },
  { name: "/model", label: "模型" },
  { name: "/new", label: "新对话" },
];

const scenarios = [
  { key: "1", input: "/", note: "Q5：仅 /，不画匹配段" },
  { key: "2", input: "/e", note: "一项：/e | xit" },
  { key: "3", input: "/ex", note: "一项：/ex | it" },
  { key: "4", input: "/m", note: "一项：/m | odel" },
  { key: "5", input: "/n", note: "一项：/n | ew" },
  { key: "6", input: "/x", note: "空列表（#70 范围，仅占位）" },
] as const;

export function PrototypeApp({ initialVariant = "A" }: { readonly initialVariant?: Variant }) {
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [input, setInput] = useState("/");
  const [selected, setSelected] = useState(0);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = Math.max(20, stdout?.rows ?? 24);
  const columns = Math.max(64, stdout?.columns ?? 80);
  const menuOpen = input.startsWith("/");
  const candidates = menuOpen
    ? commands.filter((command) => command.name.startsWith(input))
    : [];
  const selectedIndex =
    candidates.length === 0 ? 0 : Math.min(selected, candidates.length - 1);

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
    if ((key.ctrl && value === "n") || key.rightArrow) {
      cycle(1);
      return;
    }
    if ((key.ctrl && value === "p") || key.leftArrow) {
      cycle(-1);
      return;
    }
    if (key.upArrow) {
      if (candidates.length > 0) {
        setSelected(
          (current) => (current - 1 + candidates.length) % candidates.length,
        );
      }
      return;
    }
    if (key.downArrow) {
      if (candidates.length > 0) {
        setSelected((current) => (current + 1) % candidates.length);
      }
      return;
    }
    const scenario = scenarios.find((item) => item.key === value);
    if (scenario !== undefined) {
      setInput(scenario.input);
      setSelected(0);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      setSelected(0);
      return;
    }
    if (key.return || key.escape || key.ctrl) {
      return;
    }
    if (value !== "") {
      setInput((current) => `${current}${value}`);
      setSelected(0);
    }
  });

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box paddingLeft={1} paddingRight={1} flexShrink={0}>
        <Text bold>Q6 匹配段怎么画</Text>
        <Text dimColor>  前缀匹配规范名；仅 / 时不画匹配段</Text>
      </Box>
      <Box paddingLeft={1} paddingRight={1} marginBottom={1} flexShrink={0}>
        <Text dimColor>{variantTheses[variant]}</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingLeft={1}>
        <Text color="cyan">你 ▸ 帮我整理今天的开发计划</Text>
        <Text>susan ▸ 我会先检查当前分支和未完成的 issue，再给出优先顺序。</Text>
        <Text color="green">✓ read · AGENTS.md</Text>
        <Text dimColor>  └ 已读取项目协作约定</Text>
      </Box>

      {menuOpen ? (
        <Menu
          variant={variant}
          input={input}
          candidates={candidates}
          selectedIndex={selectedIndex}
        />
      ) : (
        <IdleHint />
      )}

      <InputLine input={input} />
      <StatusLine />
      <PrototypeSwitcher current={variant} />
      <StateLine
        variant={variant}
        input={input}
        candidates={candidates}
        selectedIndex={selectedIndex}
      />
    </Box>
  );
}

function Menu({
  variant,
  input,
  candidates,
  selectedIndex,
}: {
  readonly variant: Variant;
  readonly input: string;
  readonly candidates: readonly Command[];
  readonly selectedIndex: number;
}) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <Text dimColor>
        {variant} · {variantNames[variant]}
      </Text>
      {candidates.length === 0 ? (
        <Text dimColor>无匹配</Text>
      ) : (
        candidates.map((command, index) => (
          <MenuRow
            key={command.name}
            variant={variant}
            command={command}
            input={input}
            selected={index === selectedIndex}
          />
        ))
      )}
    </Box>
  );
}

function MenuRow({
  variant,
  command,
  input,
  selected,
}: {
  readonly variant: Variant;
  readonly command: Command;
  readonly input: string;
  readonly selected: boolean;
}) {
  const parts = matchParts(command.name, input);
  return (
    <Text wrap="truncate-end">
      <Text color={selected ? "cyanBright" : undefined}>
        {selected ? "›" : " "}{" "}
      </Text>
      {variant === "A" ? (
        <VariantAName name={command.name} parts={parts} />
      ) : null}
      {variant === "B" ? (
        <VariantBName name={command.name} parts={parts} />
      ) : null}
      {variant === "C" ? (
        <VariantCName name={command.name} parts={parts} />
      ) : null}
      <Text dimColor>  {command.label}</Text>
    </Text>
  );
}

function VariantAName({
  name,
  parts,
}: {
  readonly name: string;
  readonly parts: MatchParts | undefined;
}) {
  if (parts === undefined) {
    return <Text>{name}</Text>;
  }
  return (
    <>
      <Text color="cyanBright" bold>
        {parts.match}
      </Text>
      <Text>{parts.rest}</Text>
    </>
  );
}

function VariantBName({
  name,
  parts,
}: {
  readonly name: string;
  readonly parts: MatchParts | undefined;
}) {
  if (parts === undefined) {
    return <Text>{name}</Text>;
  }
  return (
    <>
      <Text bold>{parts.match}</Text>
      <Text>{parts.rest}</Text>
    </>
  );
}

function VariantCName({
  name,
  parts,
}: {
  readonly name: string;
  readonly parts: MatchParts | undefined;
}) {
  if (parts === undefined) {
    return <Text>{name}</Text>;
  }
  return (
    <>
      <Text inverse>{parts.match}</Text>
      <Text>{parts.rest}</Text>
    </>
  );
}

function IdleHint() {
  return (
    <Box paddingLeft={1} paddingRight={1} flexShrink={0}>
      <Text dimColor>空闲  ·  命令 </Text>
      {commands.map((command, index) => (
        <Text key={command.name}>
          <Text>{command.name}</Text>
          <Text dimColor> {command.label}</Text>
          {index < commands.length - 1 ? <Text dimColor>  ·  </Text> : null}
        </Text>
      ))}
    </Box>
  );
}

function InputLine({ input }: { readonly input: string }) {
  return (
    <Box borderStyle="round" flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <Text>
        ❯ {input}
        <Text inverse> </Text>
      </Text>
    </Box>
  );
}

function StatusLine() {
  return (
    <Box justifyContent="space-between" paddingLeft={1} paddingRight={1}>
      <Text dimColor>18.4k / 14.4%</Text>
      <Text dimColor>gpt-5-codex · high</Text>
    </Box>
  );
}

function PrototypeSwitcher({ current }: { readonly current: Variant }) {
  return (
    <Box justifyContent="center" marginTop={1}>
      <Box backgroundColor="blue" paddingLeft={1} paddingRight={1}>
        <Text color="white" bold>
          ←  {current} · {variantNames[current]}  →
        </Text>
      </Box>
    </Box>
  );
}

function StateLine({
  variant,
  input,
  candidates,
  selectedIndex,
}: {
  readonly variant: Variant;
  readonly input: string;
  readonly candidates: readonly Command[];
  readonly selectedIndex: number;
}) {
  const selected = candidates[selectedIndex];
  const parts = selected === undefined ? undefined : matchParts(selected.name, input);
  const scenario = scenarios.find((item) => item.input === input);
  return (
    <Box paddingLeft={1} flexDirection="column">
      <Text dimColor>
        prototype state ▸ variant={variant} · input={input === "" ? "∅" : input} ·
        rows={candidates.length} · selected={selected?.name ?? "none"} ·
        match={parts === undefined ? "none" : `${parts.match}|${parts.rest}`}
      </Text>
      <Text dimColor>
        1–6 场景 · ←/→ 或 Ctrl+P/N 换画法 · ↑/↓ 选中 · 可直接键入过滤
        {scenario !== undefined ? ` · 场景${scenario.key} ${scenario.note}` : ""}
      </Text>
    </Box>
  );
}

type MatchParts = { readonly match: string; readonly rest: string };

function matchParts(name: string, input: string): MatchParts | undefined {
  if (input === "/" || !name.startsWith(input)) {
    return undefined;
  }
  return { match: input, rest: name.slice(input.length) };
}

function parseVariant(value: string): Variant {
  return value === "B" || value === "C" ? value : "A";
}

const arg = process.argv.find((item) => item.startsWith("--variant="));
const initialVariant = parseVariant(arg?.split("=")[1] ?? "A");

render(<PrototypeApp initialVariant={initialVariant} />);
