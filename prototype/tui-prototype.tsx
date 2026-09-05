// Three Tool Result card directions for Susan, switchable with Left/Right.
// Four shared snapshots switch with Up/Down. PROTOTYPE ONLY — do not ship.
import { useMemo, useState, type ReactNode } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";

type Variant = "A" | "B" | "C";
type Scene = "running" | "created" | "outside" | "failed";
type Status = "running" | "completed" | "failed";
type ToolName = "read" | "write" | "edit" | "bash" | "grep" | "find" | "ls";

type ToolFact = {
  readonly name: ToolName;
  readonly target: string;
  readonly summary: string;
  readonly detail: readonly string[];
  readonly status: Status;
  readonly outside?: boolean;
  readonly truncated?: "head" | "tail";
};

const variants: readonly Variant[] = ["A", "B", "C"];
const scenes: readonly Scene[] = ["running", "created", "outside", "failed"];
const variantNames: Record<Variant, string> = {
  A: "执行账本",
  B: "列表 + 检查器",
  C: "Tool Round 泳道",
};
const sceneNames: Record<Scene, string> = {
  running: "全运行",
  created: "成功 · 创建",
  outside: "成功 · 覆盖 / 越界",
  failed: "失败 · exit / 截断",
};

const insideTargets: Record<ToolName, string> = {
  read: "src/core/harness.ts",
  write: "src/generated/tool-contract.ts",
  edit: "src/ui/state.ts",
  bash: "pnpm test -- --runInBand",
  grep: "ToolResult · src/",
  find: "**/*.test.ts · test/",
  ls: "docs/adr/",
};

function factsFor(scene: Scene): readonly ToolFact[] {
  if (scene === "running") {
    return (Object.keys(insideTargets) as ToolName[]).map((name) => ({
      name,
      target: insideTargets[name],
      status: "running",
      summary: name === "bash" ? "Bash 正在运行 · 00:08" : "执行中",
      detail: ["Yolo 已放行", name === "bash" ? "cwd  ." : "cwd 内"],
    }));
  }

  if (scene === "created") {
    return [
      fact("read", "已读 180 行 · 12.4 KiB", ["offset 1 → 180", "可继续：offset=181"], "head"),
      fact("write", "已创建 · 1.8 KiB", ["created  src/generated/tool-contract.ts", "已创建父目录 src/generated/"]),
      fact("edit", "2 项 edit · 3 处替换", ["@@ -42,2 +42,2 @@", "- read_file", "+ read"]),
      fact("bash", "exit 0 · stdout 24 行", ["✓ 62 tests passed", "stderr 空"]),
      fact("grep", "38 matches · 11 files", ["前 38 / 共 38", "diagnostics 0"]),
      fact("find", "27 entries", ["file  test/harness.test.ts", "file  test/tui-state.test.ts"]),
      fact("ls", "12 entries", ["9 files · 3 directories", "ordinal 排序"]),
    ];
  }

  if (scene === "outside") {
    return [
      outsideFact("read", "/tmp/shared/contract.md", "已读 2,000 行 · 49.6 KiB", ["outside cwd", "截断：lines · 可继续 offset=2001"], "head"),
      outsideFact("write", "/tmp/shared/contract.md", "已覆盖 · 8.1 KiB", ["overwritten  /tmp/shared/contract.md", "原文件 mode 已保留"]),
      fact("edit", "1 项 edit · 6 处替换", ["@@ -88,3 +88,3 @@", "- cwdRelation: unknown", "+ cwdRelation: outside"]),
      outsideFact("bash", "/tmp/shared", "exit 0 · stdout 49.8 KiB", ["outside cwd", "保留输出末尾 · 无法继续读取"], "tail"),
      fact("grep", "100 matches · 31 files", ["截断：items / bytes", "可继续：offset=100"], "head"),
      fact("find", "1,000 entries", ["截断：items", "可继续：offset=1000"], "head"),
      fact("ls", "0 entries", ["空目录（成功）", "diagnostics 0"]),
    ];
  }

  return [
    failedFact("read", "EACCES", ["无法读取 Real Target Path", "path  /private/root/notes.md"], true),
    failedFact("write", "ECONFLICT", ["提交前目标已变化", "目标保持未修改"]),
    failedFact("edit", "ENONUNIQUE", ["第 1 项匹配 4 处", "改用 replaceAll 或收窄 oldText"]),
    failedFact("bash", "EEXIT · exit 2", ["stderr 49.8 KiB · 保留末尾", "termination  process-group · cleanup confirmed"], false, "tail"),
    failedFact("grep", "EINVAL_PATTERN", ["无效 ECMAScript regex", "field  pattern"]),
    failedFact("find", "EQUERY_TOO_LARGE", ["已遍历 100,000 entries", "未返回伪完整的部分结果"]),
    failedFact("ls", "ENOTDIR", ["目标不是目录", "path  README.md"]),
  ];
}

function fact(name: ToolName, summary: string, detail: readonly string[], truncated?: "head" | "tail"): ToolFact {
  return { name, target: insideTargets[name], status: "completed", summary, detail, truncated };
}

function outsideFact(name: ToolName, target: string, summary: string, detail: readonly string[], truncated?: "head" | "tail"): ToolFact {
  return { name, target, status: "completed", summary, detail, outside: true, truncated };
}

function failedFact(name: ToolName, summary: string, detail: readonly string[], outside = false, truncated?: "head" | "tail"): ToolFact {
  return { name, target: outside ? "/private/root/notes.md" : insideTargets[name], status: "failed", summary, detail, outside, truncated };
}

export function PrototypeApp({ initialVariant = "A" }: { readonly initialVariant?: Variant }) {
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [scene, setScene] = useState<Scene>("outside");
  const [selected, setSelected] = useState(2);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = Math.max(22, stdout?.rows ?? 24);
  const columns = Math.max(72, stdout?.columns ?? 100);
  const facts = useMemo(() => factsFor(scene), [scene]);

  const cycleVariant = (delta: -1 | 1) => setVariant((current) => cycle(variants, current, delta));
  const cycleScene = (delta: -1 | 1) => setScene((current) => cycle(scenes, current, delta));

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) return exit();
    if (key.leftArrow) return cycleVariant(-1);
    if (key.rightArrow) return cycleVariant(1);
    if (key.upArrow) return cycleScene(-1);
    if (key.downArrow) return cycleScene(1);
    if (input === "j") return setSelected((current) => (current + 1) % facts.length);
    if (input === "k") return setSelected((current) => (current - 1 + facts.length) % facts.length);
  });

  const view = variant === "A"
    ? <Ledger facts={facts} />
    : variant === "B"
      ? <Inspector facts={facts} selected={selected} />
      : <RoundLanes facts={facts} />;

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box paddingLeft={1} paddingRight={1} justifyContent="space-between">
        <Text bold>SUSAN / BUILT-IN TOOL SET</Text>
        <Text dimColor>Tool Round 07 · 7 calls · Yolo</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingLeft={1} paddingRight={1} marginTop={1}>
        {view}
      </Box>
      <Box paddingLeft={1}><Text dimColor>prototype state ▸ variant={variant} · scene={scene} · selected={facts[selected]?.name}</Text></Box>
      <Switcher variant={variant} scene={scene} />
    </Box>
  );
}

function Ledger({ facts }: { readonly facts: readonly ToolFact[] }) {
  return (
    <Box flexDirection="column">
      <Text dimColor>A · 每个 Tool 保持一条主记录；只有异常事实占用后续行。</Text>
      {facts.map((item) => (
        <Box key={item.name} flexDirection="column">
          <Text color={statusColor(item.status)} wrap="truncate-end">
            <Text bold>{statusMark(item.status)} {item.name.padEnd(6)}</Text>
            <Text color={item.outside ? "yellow" : undefined}>{item.target}</Text>
            <Text dimColor>  ·  {item.summary}{item.outside ? "  ·  outside cwd" : ""}</Text>
          </Text>
          {(item.name === "edit" || item.name === "bash" || item.status === "failed") && item.detail.slice(0, 1).map((line, index) => (
            <Detail key={index}>{item.outside && item.detail[0] === "outside cwd" ? item.detail[1] : line}</Detail>
          ))}
          {item.truncated && <Budget direction={item.truncated} />}
        </Box>
      ))}
    </Box>
  );
}

function Inspector({ facts, selected }: { readonly facts: readonly ToolFact[]; readonly selected: number }) {
  const active = facts[selected] ?? facts[0]!;
  return (
    <Box flexDirection="column">
      <Text dimColor>B · 扫描列表保持极简，j / k 选择后在右侧检查 canonical record。</Text>
      <Box marginTop={1} flexDirection="row" gap={2}>
        <Box width="38%" flexDirection="column" borderStyle="single" borderColor="gray" paddingLeft={1} paddingRight={1}>
          <Text bold>TOOLS</Text>
          {facts.map((item, index) => (
            <Text key={item.name} color={index === selected ? "cyanBright" : statusColor(item.status)} wrap="truncate-end">
              {index === selected ? "›" : " "} {statusMark(item.status)} {item.name.padEnd(6)} {item.summary}
            </Text>
          ))}
        </Box>
        <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor={active.status === "failed" ? "red" : "cyan"} paddingLeft={1} paddingRight={1}>
          <ToolHeadline fact={active} />
          <Label label="目标">{active.target}</Label>
          <Label label="结果">{active.summary}</Label>
          <Label label="边界">{active.outside ? "outside cwd · 仍按 Yolo 执行" : "inside cwd"}</Label>
          {active.detail.map((line, index) => <Detail key={index}>{line}</Detail>)}
          {active.truncated && <Budget direction={active.truncated} />}
        </Box>
      </Box>
    </Box>
  );
}

function RoundLanes({ facts }: { readonly facts: readonly ToolFact[] }) {
  const groups: readonly { title: string; status: Status }[] = [
    { title: "RUNNING", status: "running" },
    { title: "COMPLETED", status: "completed" },
    { title: "FAILED", status: "failed" },
  ];
  return (
    <Box flexDirection="column">
      <Text dimColor>C · 先读 Tool Round 的状态，再按需扫每条结果；特殊事实紧贴所属 Tool。</Text>
      <Box marginTop={1} gap={1}>
        {groups.map((group) => {
          const items = facts.filter((item) => item.status === group.status);
          return (
            <Box key={group.status} width="33%" flexDirection="column" borderStyle="single" borderColor={items.length === 0 ? "gray" : statusColor(group.status)} paddingLeft={1} paddingRight={1}>
              <Text bold color={items.length === 0 ? "gray" : statusColor(group.status)}>{group.title}  {items.length}</Text>
              {items.length === 0 ? <Text dimColor>—</Text> : items.map((item) => (
                <Box key={item.name} flexDirection="column" flexShrink={0}>
                  <Text color={statusColor(item.status)} wrap="truncate-end"><Text bold>{statusMark(item.status)} {item.name}</Text>  {item.summary}</Text>
                  {(item.outside || item.name === "edit" || item.name === "bash") && (
                    <Text dimColor wrap="truncate-end">└ {item.outside ? `outside cwd · ${item.target}` : item.detail[0]}</Text>
                  )}
                </Box>
              ))}
            </Box>
          );
        })}
      </Box>
      {facts.some((item) => item.truncated) && (
        <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingLeft={1} paddingRight={1}>
          <Text color="yellow">OUTPUT BUDGET </Text>
          <Text>head 用于文件/查询/diff · tail 用于 bash · canonical record 不藏未截断副本</Text>
        </Box>
      )}
    </Box>
  );
}

function ToolHeadline({ fact }: { readonly fact: ToolFact }) {
  return (
    <Text color={statusColor(fact.status)} bold wrap="truncate-end">
      {statusMark(fact.status)} {fact.name}  <Text color={fact.outside ? "yellow" : undefined}>{fact.target}</Text>
    </Text>
  );
}

function Detail({ children }: { readonly children: ReactNode }) {
  const content = String(children);
  const color = content.startsWith("-") ? "red" : content.startsWith("+") ? "green" : undefined;
  return <Text dimColor={color === undefined} color={color}>   └ {children}</Text>;
}

function Label({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <Text wrap="truncate-end"><Text dimColor>{label.padEnd(6)}</Text>{children}</Text>;
}

function Budget({ direction }: { readonly direction: "head" | "tail" }) {
  return (
    <Text color="yellow" wrap="truncate-end">
      {direction === "head" ? "   ▰▰▰▰▰▰▰▰▱▱ 49.6 / 50 KiB · 保留头部" : "   ▱▱▰▰▰▰▰▰▰▰ 49.8 / 50 KiB · 保留末尾"}
    </Text>
  );
}

function Switcher({ variant, scene }: { readonly variant: Variant; readonly scene: Scene }) {
  return (
    <Box justifyContent="center" marginTop={1}>
      <Box backgroundColor="blue" paddingLeft={1} paddingRight={1}>
        <Text color="white" bold>← →  {variant} · {variantNames[variant]}   ↑ ↓  {sceneNames[scene]}   j k 选择   q 退出</Text>
      </Box>
    </Box>
  );
}

function statusMark(status: Status): string {
  return status === "running" ? "◌" : status === "completed" ? "✓" : "✗";
}

function statusColor(status: Status): "yellow" | "green" | "red" {
  return status === "running" ? "yellow" : status === "completed" ? "green" : "red";
}

function cycle<T>(values: readonly T[], current: T, delta: -1 | 1): T {
  const index = values.indexOf(current);
  return values[(index + delta + values.length) % values.length]!;
}

function parseVariant(value: string | undefined): Variant {
  return value === "B" || value === "C" ? value : "A";
}

const arg = process.argv.find((item) => item.startsWith("--variant="));
render(<PrototypeApp initialVariant={parseVariant(arg?.split("=")[1])} />);
