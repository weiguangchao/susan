// PROTOTYPE (throwaway): read 结果行的行号形态 —— 方案 A「逐行·条目行」的细化。
// Question: 方案 A 中 read 的嵌套结果行 `├ 1│ content` 里，树形 glyph、行号与竖线
//   三者叠加显得冗余——行号应以什么形态与内容搭配？
//   1 点号·分隔     —— 保留 glyph，`├ 1 · content`，沿用项目无处不在的 `·` 分隔惯例
//   2 槽位·右对齐   —— 保留 glyph，`├  1  content`，右对齐行号 + 双空格，无分隔符
//   3 行号·即脊柱   —— 去掉 glyph，右对齐行号成为左栏：`      1  content`
//   4 纯内容·无行号 —— 保留 glyph，只有内容行，范围信息由 summary（已读 12/91 行）承担
//   ls 卡片恒为 A 样式作对照。运行：pnpm preview:read-rows ；←/→ 切换变体。
//   所有状态留在内存，不请求模型、不执行 Tool、不写入 Session。
import { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import type { ProviderToolCall } from "../src/core/provider.js";
import type {
  ToolResult,
  ToolResultMeta,
} from "../src/core/tool-result.js";
import { isRecord, type JsonValue } from "../src/core/json.js";
import { createTuiState, reduceTuiState } from "../src/ui/state.js";
import type { TuiToolCard } from "../src/ui/tool-ledger.js";
import {
  InputLine,
  StatusBar,
  ToolLineView,
  useActivityPhase,
} from "../src/ui/tui.js";
import { createTuiOutput } from "../src/ui/terminal-output.js";

type Example = {
  readonly call: ProviderToolCall;
  readonly result: ToolResult;
};

const scenarios = ["标准", "长内容", "空结果", "分页中段"] as const;
const phases = ["requested", "running", "result"] as const;
const durations = [900, 4000, 2400];

type LsEntryView = {
  readonly name: string;
  readonly type: "file" | "directory" | "symlink";
};

const READ_PATH = "src/core/path.ts";

const readStandardLines: readonly string[] = [
  'import { posix } from "node:path";',
  'import { isRecord } from "./json.js";',
  "",
  "export function normalizeSourcePath(value: string): string {",
  "  if (!posix.isAbsolute(value)) {",
  "    return posix.normalize(value);",
  "  }",
  '  return posix.relative(".", value) || ".";',
  "}",
];

const readLongLines: readonly string[] = [
  'import { posix } from "node:path";',
  ...Array.from({ length: 15 }, (_, section) => [
    "",
    `// section ${section + 1}`,
    `export function step${section + 1}(value: number): number {`,
    `  const scaled = value * ${section + 1};`,
    "  return scaled;",
    "}",
  ]).flat(),
];

const lsStandardEntries: readonly LsEntryView[] = [
  { name: "AGENTS.md", type: "file" },
  { name: "CONTEXT.md", type: "file" },
  { name: "config.json", type: "file" },
  { name: "debug", type: "directory" },
  { name: "dist", type: "directory" },
  { name: "docs", type: "directory" },
  { name: "node_modules", type: "directory" },
  { name: "package.json", type: "file" },
  { name: "patches", type: "directory" },
  { name: "pnpm-lock.yaml", type: "file" },
  { name: "prototype", type: "directory" },
  { name: "scripts", type: "directory" },
  { name: "src", type: "directory" },
];

const lsLongEntries: readonly LsEntryView[] = [
  { name: "debug", type: "directory" },
  { name: "dist", type: "directory" },
  { name: "docs", type: "directory" },
  ...Array.from({ length: 34 }, (_, index) => ({
    name: `feature-${String(index + 1).padStart(2, "0")}.ts`,
    type: "file" as const,
  })),
  { name: "link.ts", type: "symlink" },
  { name: "scripts", type: "directory" },
  { name: "src", type: "directory" },
];

function readExample(scenario: number): Example {
  const path = scenario === 2 ? "docs/scratch.md" : READ_PATH;
  let lines: readonly string[] = [];
  let arguments_: Record<string, JsonValue> = { path };
  if (scenario === 0) {
    lines = readStandardLines;
  } else if (scenario === 1) {
    lines = readLongLines;
  } else if (scenario === 3) {
    const offset = 22;
    const limit = 12;
    lines = readLongLines.slice(offset - 1, offset - 1 + limit);
    arguments_ = { path, offset, limit };
  }
  const startLine =
    typeof arguments_.offset === "number" ? arguments_.offset : 1;
  const content = lines.join("\n");
  const fullText = scenario === 3 ? readLongLines.join("\n") : content;
  const sizeBytes = new TextEncoder().encode(fullText).length;
  return {
    call: { id: "preview-read", name: "read", arguments: arguments_ },
    result: {
      ok: true,
      result: {
        resolvedPath: `/workspace/${path}`,
        realTargetPath: `/workspace/${path}`,
        cwdRelation: "inside",
        content,
        ...(lines.length === 0
          ? {}
          : { range: { startLine, endLine: startLine + lines.length - 1 } }),
        totalLines: scenario === 3 ? readLongLines.length : lines.length,
        sizeBytes,
        bom: false,
        lineEnding: lines.length === 0 ? "none" : "lf",
      },
    },
  };
}

function lsExample(scenario: number): Example {
  const path = scenario === 2 ? "sandbox" : ".";
  let entries: readonly LsEntryView[] = lsStandardEntries;
  let arguments_: Record<string, JsonValue> = { path };
  let meta: ToolResultMeta | undefined;
  if (scenario === 1) {
    entries = lsLongEntries;
  } else if (scenario === 3) {
    entries = lsLongEntries.slice(24, 40);
    arguments_ = { path, offset: 24, limit: 16 };
    meta = {
      truncation: {
        reasons: ["items"],
        strategy: "head",
        fields: ["entries"],
        retained: { bytes: 640, items: 16 },
        total: { items: 40 },
        nextArguments: { path, offset: 40 },
      },
    };
  }
  const resolvedPath = path === "." ? "/workspace" : `/workspace/${path}`;
  return {
    call: { id: "preview-ls", name: "ls", arguments: arguments_ },
    result: {
      ok: true,
      result: {
        resolvedPath,
        realTargetPath: resolvedPath,
        cwdRelation: "inside",
        entries,
        diagnostics: [],
      },
      ...(meta === undefined ? {} : { meta }),
    },
  };
}

type PreviewRow = {
  readonly text: string;
  readonly kind: "content" | "meta" | "gap";
};

type ReadVariantKey = "A1" | "A2" | "A3" | "A4";

const readVariants = [
  { key: "A1" as const, name: "点号·分隔" },
  { key: "A2" as const, name: "槽位·右对齐" },
  { key: "A3" as const, name: "行号·即脊柱" },
  { key: "A4" as const, name: "纯内容·无行号" },
];

const GLYPH_ROW_BUDGET = 4;

type CardBlock = {
  readonly glyphed: boolean;
  readonly rows: readonly PreviewRow[];
};

type ReadContent = {
  readonly lines: readonly string[];
  readonly startLine: number;
};

function readContentOf(result: ToolResult): ReadContent {
  if (!result.ok || !isRecord(result.result)) {
    return { lines: [], startLine: 1 };
  }
  const content =
    typeof result.result.content === "string" ? result.result.content : "";
  const range = isRecord(result.result.range) ? result.result.range : undefined;
  const startLine = typeof range?.startLine === "number" ? range.startLine : 1;
  return {
    lines: content === "" ? [] : content.split("\n"),
    startLine,
  };
}

function lsEntriesOf(result: ToolResult): readonly LsEntryView[] {
  if (!result.ok || !isRecord(result.result)) {
    return [];
  }
  const entries = Array.isArray(result.result.entries)
    ? result.result.entries
    : [];
  return entries.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.name === "string" &&
    (entry.type === "file" ||
      entry.type === "directory" ||
      entry.type === "symlink")
      ? [{ name: entry.name, type: entry.type }]
      : [],
  );
}

function entryMark(entry: LsEntryView): string {
  return entry.type === "directory"
    ? `${entry.name}/`
    : entry.type === "symlink"
      ? `${entry.name}@`
      : entry.name;
}

function countText(count: {
  readonly lines?: number;
  readonly items?: number;
  readonly bytes?: number;
}): string {
  if (typeof count.items === "number") {
    return `${count.items} 项`;
  }
  if (typeof count.lines === "number") {
    return `${count.lines} 行`;
  }
  return `${count.bytes ?? 0} B`;
}

function truncationRows(result: ToolResult): readonly PreviewRow[] {
  const truncation = result.meta?.truncation;
  if (truncation === undefined) {
    return [];
  }
  const rows: PreviewRow[] = [
    {
      text: `truncation · ${truncation.strategy} · ${countText(truncation.retained)}${
        truncation.total === undefined ? "" : `/${countText(truncation.total)}`
      }`,
      kind: "meta",
    },
  ];
  if (truncation.nextArguments !== undefined) {
    const next = isRecord(truncation.nextArguments)
      ? Object.entries(truncation.nextArguments)
          .map(([key, value]) => `${key} ${String(value)}`)
          .join(" · ")
      : "…";
    rows.push({ text: `next · ${next}`, kind: "meta" });
  }
  return rows;
}

function clampRows(rows: readonly PreviewRow[]): readonly PreviewRow[] {
  if (rows.length <= GLYPH_ROW_BUDGET) {
    return rows;
  }
  return [
    ...rows.slice(0, GLYPH_ROW_BUDGET),
    { text: `…其余 ${rows.length - GLYPH_ROW_BUDGET} 行省略`, kind: "gap" },
  ];
}

function readRows(example: Example, variant: ReadVariantKey): CardBlock {
  const glyphed = variant !== "A3";
  const content = readContentOf(example.result);
  const rows: PreviewRow[] = [];
  if (content.lines.length === 0) {
    rows.push({ text: "空文件", kind: "meta" });
  } else if (variant === "A4") {
    rows.push(
      ...content.lines.map((line) => ({ text: line, kind: "content" as const })),
    );
  } else {
    const numberWidth = String(
      content.startLine + content.lines.length - 1,
    ).length;
    const separator = variant === "A1" ? " · " : "  ";
    rows.push(
      ...content.lines.map((line, index) => ({
        text:
          line === ""
            ? String(content.startLine + index).padStart(numberWidth)
            : `${String(content.startLine + index).padStart(numberWidth)}${separator}${line}`,
        kind: "content" as const,
      })),
    );
  }
  rows.push(...truncationRows(example.result));
  return { glyphed, rows: clampRows(rows) };
}

function lsRows(example: Example): CardBlock {
  const entries = lsEntriesOf(example.result);
  const rows: PreviewRow[] = [];
  if (entries.length === 0) {
    rows.push({ text: "空目录", kind: "meta" });
  } else {
    rows.push(
      ...entries.map((entry) => ({
        text: entryMark(entry),
        kind: "content" as const,
      })),
    );
  }
  rows.push(...truncationRows(example.result));
  return { glyphed: true, rows: clampRows(rows) };
}

function CardRowsView({ block }: { readonly block: CardBlock }) {
  return (
    <>
      {block.rows.map((row, index) => (
        <Text
          key={index}
          wrap="truncate-end"
          dimColor={row.kind !== "gap"}
          italic={row.kind === "gap"}
        >
          {block.glyphed
            ? `    ${index === block.rows.length - 1 ? "└ " : "├ "}${row.text}`
            : `      ${row.text}`}
        </Text>
      ))}
    </>
  );
}

function VariantCardView({
  card,
  block,
  phase,
}: {
  readonly card: TuiToolCard;
  readonly block: CardBlock;
  readonly phase: number;
}) {
  const running = card.status === "requested" || card.status === "running";
  return (
    <Box flexDirection="column" flexShrink={0}>
      <ToolLineView tool={card} phase={phase} />
      {running ? null : <CardRowsView block={block} />}
    </Box>
  );
}

function VariantLedgerView({
  cards,
  blocks,
}: {
  readonly cards: readonly TuiToolCard[];
  readonly blocks: readonly CardBlock[];
}) {
  const phase = useActivityPhase(
    cards.some(
      (card) => card.status === "requested" || card.status === "running",
    ),
  );
  return (
    <Box flexDirection="column" flexShrink={0}>
      {cards.map((card, index) => (
        <VariantCardView
          key={card.id}
          card={card}
          block={blocks[index]}
          phase={phase}
        />
      ))}
    </Box>
  );
}

function Preview() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout.columns || 80,
    rows: stdout.rows || 24,
  });
  const [scenario, setScenario] = useState(0);
  const [variant, setVariant] = useState(0);
  const [stage, setStage] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [full, setFull] = useState(true);
  const [scroll, setScroll] = useState(0);

  useEffect(() => {
    const resize = () =>
      setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", resize);
    return () => {
      stdout.off("resize", resize);
    };
  }, [stdout]);
  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => setElapsed((value) => value + 100), 100);
    return () => clearInterval(timer);
  }, [paused]);
  useEffect(() => {
    if (elapsed < durations[stage]) return;
    setElapsed(0);
    setStage((value) => (value + 1) % phases.length);
    setScroll(0);
  }, [elapsed, stage]);

  const restart = () => {
    setStage(0);
    setElapsed(0);
    setScroll(0);
  };
  const examples = [readExample(scenario), lsExample(scenario)];

  let state = createTuiState({
    status: "running",
    sessionId: "read-rows-preview",
    cwd: "/workspace",
    messages: [],
    pending: null,
    model: "preview",
    reasoningEffort: "high",
    contextWindow: 128_000,
    sessionTotalTokens: 0,
    sessionInputTokens: 0,
    sessionCachedInputTokens: 0,
  });
  for (const [index, example] of examples.entries()) {
    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "tool-call-delta",
        index,
        id: example.call.id,
        name: example.call.name,
        argumentsDelta: JSON.stringify(example.call.arguments),
      },
    });
  }
  if (stage >= 1) {
    for (const example of examples) {
      state = reduceTuiState(state, {
        type: "harness-event",
        event: { type: "tool-started", toolCall: example.call },
      });
    }
  }
  if (stage === 2) {
    for (const example of examples) {
      state = reduceTuiState(state, {
        type: "harness-event",
        event: {
          type: "tool-completed",
          toolCall: example.call,
          result: example.result,
        },
      });
    }
    state = { ...state, status: "idle" };
  }

  const cards = state.tools;
  const blocks = [
    readRows(examples[0], readVariants[variant].key),
    lsRows(examples[1]),
  ];
  const contentRows = Math.max(1, size.rows - (full ? 10 : 6));
  const totalRows = cards.reduce(
    (sum, card, index) =>
      sum +
      1 +
      (card.status === "requested" || card.status === "running"
        ? 0
        : blocks[index].rows.length),
    0,
  );
  const maxScroll = Math.max(0, totalRows - contentRows);
  const offset = Math.min(scroll, maxScroll);
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      setVariant(
        (value) =>
          (value + (key.rightArrow ? 1 : -1) + readVariants.length) %
          readVariants.length,
      );
    } else if (input === "s") {
      setScenario((value) => (value + 1) % scenarios.length);
      restart();
    } else if (input === " ") {
      setPaused((value) => !value);
    } else if (input === "r") {
      restart();
    } else if (input === "n") {
      setPaused(true);
      setStage((value) => (value + 1) % phases.length);
      setElapsed(0);
      setScroll(0);
    } else if (input === "v") {
      setFull((value) => !value);
    } else if (key.downArrow) {
      setScroll(Math.min(maxScroll, offset + 1));
    } else if (key.upArrow) {
      setScroll(Math.max(0, offset - 1));
    }
  });
  return (
    <Box flexDirection="column" width={size.columns}>
      <Text bold color="cyan">
        read 行号形态原型 · 方案 A 细化
      </Text>
      <Text wrap="truncate-end">
        变体 {variant + 1}/{readVariants.length} {readVariants[variant].name} ·
        ls 恒为 A 样式对照 · 场景 {scenarios[scenario]} · read{" "}
        {cards[0]?.status ?? "-"} · ls {cards[1]?.status ?? "-"} ·{" "}
        {paused ? "暂停" : "循环播放"} · {full ? "Susan 布局" : "工具区域"}
      </Text>
      <Text dimColor wrap="truncate-end">
        ←/→ 变体 · s 场景 · v 视图 · 空格 暂停 · n 单步 · r 重播 · ↑/↓ 滚动 ·
        q 退出
      </Text>
      {full && <Text>你 ▸ 看看 src/core/path.ts 的内容和根目录里有什么</Text>}
      <Box height={contentRows} overflow="hidden" flexDirection="column" flexShrink={0}>
        <Box flexDirection="column" flexShrink={0} marginTop={-offset}>
          <VariantLedgerView cards={cards} blocks={blocks} />
        </Box>
      </Box>
      <Text dimColor wrap="truncate-end">
        {maxScroll > 0
          ? `卡片 ${offset + 1}–${Math.min(totalRows, offset + contentRows)}/${totalRows} 行 · ↑/↓ 查看`
          : "请求 0.9s → 运行 4s → 结果 2.4s"}
      </Text>
      {full && (
        <>
          <InputLine input="" cursor={state.inputCursor} columns={size.columns} />
          <StatusBar state={state} />
        </>
      )}
      <Text wrap="truncate-end">
        <Text bold color="yellow">{"⟨ "}</Text>
        {readVariants.map((entry, index) => (
          <Text
            key={entry.key}
            bold={index === variant}
            color={index === variant ? "cyanBright" : "gray"}
          >
            {index === variant ? `[${entry.key}] ${entry.name}` : ` ${entry.key} · ${entry.name} `}
          </Text>
        ))}
        <Text bold color="yellow">{" ⟩"}</Text>
        <Text dimColor> ←/→ 切换变体</Text>
      </Text>
    </Box>
  );
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("请在交互式终端运行 pnpm preview:read-rows");
  process.exitCode = 1;
} else {
  await render(<Preview />, {
    stdout: createTuiOutput(process.stdout),
    incrementalRendering: true,
  }).waitUntilExit();
}
