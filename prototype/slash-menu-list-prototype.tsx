// Three Slash Command Menu list treatments, switchable via --variant=A|B|C,
// ←/→, or Ctrl+N / Ctrl+P. Mounted in fake Susan idle chrome.
// PROTOTYPE ONLY — do not ship.
//
// Question: in a real TUI, do list density, selected state, and the locked
// match-segment paint (cyanBright+bold prefix on 规范名; Label always dim)
// actually read?
import { useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";

type Variant = "A" | "B" | "C";

type Command = {
  readonly name: "/exit" | "/model" | "/new";
  readonly label: string;
};

const variants: readonly Variant[] = ["A", "B", "C"];
const variantNames: Record<Variant, string> = {
  A: "紧凑 › 列表",
  B: "整行反色",
  C: "带框选择器",
};
const variantTheses: Record<Variant, string> = {
  A: "无框、› 标记、一行一项；选中只加 cyan ›。密度最低，像 Session picker。",
  B: "无 ›；选中整行 inverse。看匹配段 cyanBright+bold 在反色上还能否读。",
  C: "圆角框 + 标题，像 model picker。多吃约 3 行，看 80×24 会不会挤。",
};

const commands: readonly Command[] = [
  { name: "/exit", label: "退出" },
  { name: "/model", label: "模型" },
  { name: "/new", label: "新对话" },
];

const scenarios = [
  { key: "1", input: "/", note: "仅 /，三项，不画匹配段，默认选 /exit" },
  { key: "2", input: "/e", note: "一项：/e | xit" },
  { key: "3", input: "/m", note: "一项：/m | odel" },
  { key: "4", input: "/n", note: "一项：/n | ew" },
  { key: "5", input: "/x", note: "空列表，菜单仍开" },
  { key: "6", input: "", note: "非 Slash Query，回到空闲 CommandHintLine" },
  { key: "7", input: "/ex", note: "一项：/ex | it" },
  { key: "8", input: "/exit", note: "整词打满，规范名全是匹配段" },
] as const;

export function PrototypeApp({
  initialVariant = "A",
}: {
  readonly initialVariant?: Variant;
}) {
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [input, setInput] = useState("/");
  const [selected, setSelected] = useState(0);
  const [lastAction, setLastAction] = useState("∅");
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows && stdout.rows > 0 ? stdout.rows : 24;
  const columns = stdout?.columns && stdout.columns > 0 ? stdout.columns : 80;
  const menuOpen = isSlashQuery(input);
  const candidates = menuOpen
    ? commands.filter((command) => command.name.startsWith(input))
    : [];
  const selectedIndex =
    candidates.length === 0 ? 0 : Math.min(selected, candidates.length - 1);
  const menuLines = menuLineCount(variant, menuOpen, candidates.length);

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
        setSelected((current) =>
          Math.max(0, Math.min(current, candidates.length - 1) - 1),
        );
      }
      return;
    }
    if (key.downArrow) {
      if (candidates.length > 0) {
        setSelected((current) =>
          Math.min(candidates.length - 1, current + 1),
        );
      }
      return;
    }
    if (key.escape) {
      setInput("");
      setSelected(0);
      setLastAction("esc → 清空");
      return;
    }
    if (key.return) {
      const selectedCommand = candidates[selectedIndex];
      if (selectedCommand === undefined) {
        setLastAction("enter · 无 Selected Slash Command");
        return;
      }
      setLastAction(`enter → ${selectedCommand.name}`);
      setInput("");
      setSelected(0);
      return;
    }
    const scenario = scenarios.find((item) => item.key === value);
    if (scenario !== undefined) {
      setInput(scenario.input);
      setSelected(0);
      setLastAction(`场景${scenario.key}`);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      setSelected(0);
      setLastAction("backspace");
      return;
    }
    if (key.ctrl || value === "") {
      return;
    }
    setInput((current) => `${current}${value}`);
    setSelected(0);
    setLastAction("type");
  });

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box paddingLeft={1} paddingRight={1} flexShrink={0}>
        <Text bold>Slash Command Menu 列表读不读得懂</Text>
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
        menuOpen={menuOpen}
        candidates={candidates}
        selectedIndex={selectedIndex}
        lastAction={lastAction}
        menuLines={menuLines}
        screenRows={rows}
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
  if (variant === "C") {
    return (
      <Box
        borderStyle="round"
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        flexShrink={0}
      >
        <Text>命令</Text>
        <MenuBody
          variant={variant}
          input={input}
          candidates={candidates}
          selectedIndex={selectedIndex}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <MenuBody
        variant={variant}
        input={input}
        candidates={candidates}
        selectedIndex={selectedIndex}
      />
    </Box>
  );
}

function MenuBody({
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
  if (candidates.length === 0) {
    return <Text dimColor>无匹配</Text>;
  }
  return (
    <>
      {candidates.map((command, index) => (
        <MenuRow
          key={command.name}
          variant={variant}
          command={command}
          input={input}
          selected={index === selectedIndex}
        />
      ))}
    </>
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

  if (variant === "B") {
    return (
      <Text inverse={selected} wrap="truncate-end">
        <CommandName parts={parts} name={command.name} />
        <Text dimColor={selected ? false : true}> {command.label}</Text>
      </Text>
    );
  }

  return (
    <Text wrap="truncate-end">
      <Text color={selected ? "cyanBright" : undefined}>
        {selected ? "›" : " "}{" "}
      </Text>
      <CommandName parts={parts} name={command.name} />
      <Text dimColor> {command.label}</Text>
    </Text>
  );
}

function CommandName({
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
    <Box
      borderStyle="round"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
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
  menuOpen,
  candidates,
  selectedIndex,
  lastAction,
  menuLines,
  screenRows,
}: {
  readonly variant: Variant;
  readonly input: string;
  readonly menuOpen: boolean;
  readonly candidates: readonly Command[];
  readonly selectedIndex: number;
  readonly lastAction: string;
  readonly menuLines: number;
  readonly screenRows: number;
}) {
  const selected = candidates[selectedIndex];
  const parts =
    selected === undefined ? undefined : matchParts(selected.name, input);
  const scenario = scenarios.find((item) => item.input === input);
  return (
    <Box paddingLeft={1} flexDirection="column">
      <Text dimColor>
        prototype state ▸ variant={variant} · query={menuOpen ? "yes" : "no"} ·
        input={input === "" ? "∅" : input} · selected={selected?.name ?? "none"} ·
        match={parts === undefined ? "none" : `${parts.match}|${parts.rest}`} ·
        menuLines={menuLines} · screen={screenRows} · last={lastAction}
      </Text>
      <Text dimColor>
        1–8 场景 · ←/→ 或 Ctrl+P/N 换画法 · ↑/↓ 夹住选中 · Enter 执行 · Esc 清空 ·
        可直接键入
        {scenario !== undefined ? ` · 场景${scenario.key} ${scenario.note}` : ""}
      </Text>
    </Box>
  );
}

function menuLineCount(
  variant: Variant,
  menuOpen: boolean,
  candidateCount: number,
): number {
  if (!menuOpen) {
    return 1;
  }
  const body = Math.max(1, candidateCount);
  return variant === "C" ? body + 3 : body;
}

function isSlashQuery(input: string): boolean {
  return input.startsWith("/") && !/\s/.test(input);
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
