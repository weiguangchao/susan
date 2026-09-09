// PROTOTYPE (throwaway): read / ls 正常成功结果的展示形态。
// Question: read 与 ls 在正常成功返回时，结果信息应该以什么结构展示在调用行下方？
//   现状：只有 bash stdout/stderr、edit diff、symlink、失败详情、truncation 才有嵌套行，
//   read / ls 正常成功只显示一行 summary（"已读 9 行 · 297 B" / "13 entries"）。
//   A 逐行·条目行 —— read 内容逐行带行号槽、ls 每条目一行（directory 加 /、symlink 加 @），
//                    沿用既有嵌套 glyph 行 + 4 行 FIFO 上限（TOOL_RESULT_ROW_BUDGET）
//   B 紧凑·目录流   —— 不逐条占行；read 首行内容 digest，ls 条目横向流式排列（2 行上限）
//   C 窗口·带框预览 —— 调用行下方嵌入带边框的迷你预览窗（呼应 InputLine 的 ╭─╮ 风格）
// 运行：pnpm preview:read-ls ；←/→ 切换变体。所有状态留在内存，
// 不请求模型、不执行 Tool、不写入 Session。
import { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import stringWidth from "string-width";
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
        totalLines:
          scenario === 3 ? readLongLines.length : lines.length,
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
  readonly gutter?: string;
  readonly right?: string;
};

type VariantBlock = {
  readonly shape: "glyph" | "window";
  readonly rows: readonly PreviewRow[];
  readonly tail: readonly PreviewRow[];
  readonly title: string;
  readonly windowWidth: number;
};

type VariantKey = "A" | "B" | "C";

const variants = [
  { key: "A" as const, name: "逐行·条目行" },
  { key: "B" as const, name: "紧凑·目录流" },
  { key: "C" as const, name: "窗口·带框预览" },
];

const GLYPH_ROW_BUDGET = 4;
const FLOW_ROW_BUDGET = 2;
const WINDOW_ROW_BUDGET = 6;

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
  const startLine =
    typeof range?.startLine === "number" ? range.startLine : 1;
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

function variantARows(example: Example): readonly PreviewRow[] {
  const rows: PreviewRow[] = [];
  const content = readContentOf(example.result);
  const entries = lsEntriesOf(example.result);
  if (example.call.name === "read") {
    if (content.lines.length === 0) {
      rows.push({ text: "空文件", kind: "meta" });
    } else {
      const numberWidth = String(
        content.startLine + content.lines.length - 1,
      ).length;
      rows.push(
        ...content.lines.map((line, index) => ({
          text: `${String(content.startLine + index).padStart(numberWidth)}│ ${line}`,
          kind: "content" as const,
        })),
      );
    }
  } else if (entries.length === 0) {
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
  if (rows.length <= GLYPH_ROW_BUDGET) {
    return rows;
  }
  return [
    ...rows.slice(0, GLYPH_ROW_BUDGET),
    { text: `…其余 ${rows.length - GLYPH_ROW_BUDGET} 行省略`, kind: "gap" },
  ];
}

function truncateText(text: string, maxWidth: number): string {
  const width = Math.max(1, maxWidth);
  if (stringWidth(text) <= width) {
    return text;
  }
  let out = "";
  for (const character of text) {
    if (stringWidth(out + character) >= width) {
      break;
    }
    out += character;
  }
  return `${out}…`;
}

function flowLines(
  items: readonly string[],
  width: number,
  maxLines: number,
): { readonly lines: string[]; readonly placed: number } {
  const lines: string[] = [];
  let current = "";
  let placed = 0;
  for (const item of items) {
    const candidate = current === "" ? item : `${current}  ${item}`;
    if (stringWidth(candidate) <= width) {
      current = candidate;
      placed += 1;
      continue;
    }
    if (current === "") {
      current = truncateText(item, width);
      placed += 1;
      continue;
    }
    if (lines.length + 1 >= maxLines) {
      break;
    }
    lines.push(current);
    current = item;
    placed += 1;
  }
  if (current !== "") {
    lines.push(current);
  }
  return { lines: lines.slice(0, maxLines), placed };
}

function variantBRows(
  example: Example,
  columns: number,
): readonly PreviewRow[] {
  const width = Math.max(24, columns - 6);
  const rows: PreviewRow[] = [];
  const content = readContentOf(example.result);
  const entries = lsEntriesOf(example.result);
  if (example.call.name === "read") {
    if (content.lines.length === 0) {
      rows.push({ text: "空文件", kind: "meta" });
    } else {
      const suffix =
        content.lines.length > 1 ? ` · ${content.lines.length} 行` : "";
      const head = truncateText(
        content.lines[0] ?? "",
        width - suffix.length - 2,
      );
      rows.push({ text: `▸ ${head}${suffix}`, kind: "content" });
    }
  } else if (entries.length === 0) {
    rows.push({ text: "空目录", kind: "meta" });
  } else {
    const flow = flowLines(
      entries.map(entryMark),
      width,
      FLOW_ROW_BUDGET,
    );
    rows.push(
      ...flow.lines.map((text) => ({ text, kind: "content" as const })),
    );
    const hidden = entries.length - flow.placed;
    if (hidden > 0) {
      rows.push({ text: `…其余 ${hidden} 项省略`, kind: "gap" });
    }
  }
  rows.push(...truncationRows(example.result));
  return rows;
}

function variantCBlock(
  example: Example,
  columns: number,
  title: string,
): VariantBlock {
  const tail = [...truncationRows(example.result)];
  const content = readContentOf(example.result);
  const entries = lsEntriesOf(example.result);
  if (example.call.name === "read") {
    const windowWidth = Math.min(64, Math.max(30, columns - 6));
    if (content.lines.length === 0) {
      return {
        shape: "window",
        rows: [{ text: "空文件", kind: "meta" }],
        tail,
        title,
        windowWidth,
      };
    }
    const shown = content.lines.slice(0, WINDOW_ROW_BUDGET);
    const numberWidth = String(content.startLine + shown.length - 1).length;
    const rows: PreviewRow[] = shown.map((line, index) => ({
      text: line,
      kind: "content" as const,
      gutter: `${String(content.startLine + index).padStart(numberWidth)} │ `,
    }));
    if (content.lines.length > shown.length) {
      rows.push({
        text: `…其余 ${content.lines.length - shown.length} 行省略`,
        kind: "gap",
      });
    }
    return { shape: "window", rows, tail, title, windowWidth };
  }
  const windowWidth = Math.max(30, columns - 6);
  if (entries.length === 0) {
    return {
      shape: "window",
      rows: [{ text: "空目录", kind: "meta" }],
      tail,
      title,
      windowWidth,
    };
  }
  const shown = entries.slice(0, WINDOW_ROW_BUDGET);
  const rows: PreviewRow[] = shown.map((entry) => ({
    text: entryMark(entry),
    kind: "content" as const,
    right: entry.type,
  }));
  if (entries.length > shown.length) {
    rows.push({
      text: `…其余 ${entries.length - shown.length} 项省略`,
      kind: "gap",
    });
  }
  return { shape: "window", rows, tail, title, windowWidth };
}

function buildBlock(
  example: Example,
  variant: VariantKey,
  columns: number,
  title: string,
): VariantBlock {
  if (variant === "A") {
    return { shape: "glyph", rows: variantARows(example), tail: [], title, windowWidth: 0 };
  }
  if (variant === "B") {
    return {
      shape: "glyph",
      rows: variantBRows(example, columns),
      tail: [],
      title,
      windowWidth: 0,
    };
  }
  return variantCBlock(example, columns, title);
}

function blockHeight(block: VariantBlock): number {
  return block.shape === "window"
    ? block.rows.length + 2 + block.tail.length
    : block.rows.length;
}

function GlyphRowsView({
  rows,
}: {
  readonly rows: readonly PreviewRow[];
}) {
  return (
    <>
      {rows.map((row, index) => (
        <Text
          key={index}
          wrap="truncate-end"
          dimColor={row.kind !== "gap"}
          italic={row.kind === "gap"}
        >
          {"    "}{index === rows.length - 1 ? "└ " : "├ "}{row.text}
        </Text>
      ))}
    </>
  );
}

function WindowView({
  block,
}: {
  readonly block: VariantBlock;
}) {
  const width = block.windowWidth;
  const titleText = `─ ${block.title} `;
  const fill = Math.max(1, width - stringWidth(`╭${titleText}`) - 1);
  return (
    <Box flexDirection="column" paddingLeft={4} flexShrink={0}>
      <Text wrap="truncate-end">╭{titleText}{"─".repeat(fill)}╮</Text>
      <Box
        borderStyle="round"
        borderTop={false}
        width={width}
        flexDirection="column"
        flexShrink={0}
      >
        <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
          {block.rows.map((row, index) =>
            row.right === undefined ? (
              <Text
                key={index}
                wrap="truncate-end"
                dimColor={row.kind !== "content"}
                italic={row.kind === "gap"}
              >
                {row.gutter ?? ""}{row.text}
              </Text>
            ) : (
              <Box key={index} justifyContent="space-between">
                <Text wrap="truncate-end">{row.text}</Text>
                <Text dimColor>{row.right}</Text>
              </Box>
            ),
          )}
        </Box>
      </Box>
    </Box>
  );
}

function VariantCardView({
  card,
  block,
  phase,
}: {
  readonly card: TuiToolCard;
  readonly block: VariantBlock;
  readonly phase: number;
}) {
  const running = card.status === "requested" || card.status === "running";
  return (
    <Box flexDirection="column" flexShrink={0}>
      <ToolLineView tool={card} phase={phase} />
      {running ? null : block.shape === "glyph" ? (
        <GlyphRowsView rows={block.rows} />
      ) : (
        <>
          <WindowView block={block} />
          <GlyphRowsView rows={block.tail} />
        </>
      )}
    </Box>
  );
}

function VariantLedgerView({
  cards,
  blocks,
}: {
  readonly cards: readonly TuiToolCard[];
  readonly blocks: readonly VariantBlock[];
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
    sessionId: "read-ls-preview",
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
  const blocks = examples.map((example, index) =>
    buildBlock(
      example,
      variants[variant].key,
      size.columns,
      cards[index]?.invocationLabel ?? example.call.name,
    ),
  );
  const contentRows = Math.max(1, size.rows - (full ? 10 : 6));
  const totalRows = cards.reduce(
    (sum, card, index) =>
      sum +
      1 +
      (card.status === "requested" || card.status === "running"
        ? 0
        : blockHeight(blocks[index])),
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
          (value + (key.rightArrow ? 1 : -1) + variants.length) %
          variants.length,
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
        read / ls 正常结果展示原型 · 调用行下方展示结果
      </Text>
      <Text wrap="truncate-end">
        场景 {scenarios[scenario]} · read {cards[0]?.status ?? "-"} · ls{" "}
        {cards[1]?.status ?? "-"} · {paused ? "暂停" : "循环播放"} ·{" "}
        {full ? "Susan 布局" : "工具区域"}
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
        {variants.map((entry, index) => (
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
  console.error("请在交互式终端运行 pnpm preview:read-ls");
  process.exitCode = 1;
} else {
  await render(<Preview />, {
    stdout: createTuiOutput(process.stdout),
    incrementalRendering: true,
  }).waitUntilExit();
}
