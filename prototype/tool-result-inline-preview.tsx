// PROTOTYPE (throwaway): 工具调用卡片重构 —— 调用结果直接展示在调用命令下方。
// Question: 超长工具结果嵌在调用行下方时，兜底策略选哪种？
//   A 嵌套·行数上限 —— 结果行 FIFO 截断到 4 行，其余计数省略
//   B 首尾·窗口     —— 每段结果保留首 2 行 + 尾 2 行，中间计数省略
//   C 单行摘要      —— 每个工具只显示一行结果摘要
// 运行：pnpm preview:tool-results ；←/→ 切换变体。所有状态留在内存，
// 不请求模型、不执行 Tool、不写入 Session。
import { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import type { ProviderToolCall } from "../src/core/provider.js";
import type {
  ToolResult,
  ToolResultMeta,
} from "../src/core/tool-result.js";
import { isRecord, type JsonObject, type JsonValue } from "../src/core/json.js";
import { createTuiState, reduceTuiState } from "../src/ui/state.js";
import type { TuiToolCard } from "../src/ui/tool-ledger.js";
import {
  InputLine,
  StatusBar,
  ToolLineView,
} from "../src/ui/tui.js";
import { createTuiOutput } from "../src/ui/terminal-output.js";
import { canonicalToolFixtures } from "../test/fixtures/tui-tool-results.js";

const scenarios = ["成功", "失败", "批量"] as const;
const phases = ["requested", "running", "result"] as const;
const durations = [900, 4000, 2400];

const longPath =
  "src/features/tool-preview/components/very-long-directory-name/example-with-a-long-file-name.ts";

type Example = {
  readonly call: ProviderToolCall;
  readonly result: ToolResult;
};

function withLongPath(call: ProviderToolCall): ProviderToolCall {
  return {
    ...call,
    arguments: {
      ...(isRecord(call.arguments) ? call.arguments : {}),
      path: longPath,
    },
  };
}

function successExample(index: number, long: boolean): Example {
  const fixture = canonicalToolFixtures[index];
  if (!long) {
    return { call: fixture.call, result: fixture.result };
  }
  const call = fixture.call;
  if (call.name === "bash") {
    return {
      call: {
        ...call,
        arguments: {
          command:
            "pnpm exec vitest run test/tui-tool-ledger.test.tsx test/tui-render.test.tsx --reporter=verbose",
          cwd: ".",
        },
      },
      result: {
        ok: true,
        result: {
          resolvedPath: "/workspace",
          realTargetPath: "/workspace",
          cwdRelation: "inside",
          exitCode: 0,
          stdout: Array.from(
            { length: 20 },
            (_, i) => `✓ example-${i + 1}.test.ts passed (${(i + 1) * 3} ms)`,
          ).join("\n"),
          stderr: "",
          termination: {
            scope: "process-group",
            forced: false,
            cleanupConfirmed: true,
          },
        },
        meta: {
          truncation: {
            reasons: ["bytes"],
            strategy: "tail",
            fields: ["stdout"],
            retained: { bytes: 16_384, lines: 20 },
            total: { bytes: 98_304, lines: 120 },
          },
        },
      },
    };
  }
  const base = fixture.result;
  if (!base.ok) {
    return { call: withLongPath(call), result: base };
  }
  const payload: Record<string, JsonValue> = { ...base.result };
  payload.resolvedPath = `/workspace/${longPath}`;
  payload.realTargetPath = `/workspace/${longPath}`;
  payload.cwdRelation = "inside";
  let meta: ToolResultMeta | undefined;
  if (call.name === "edit") {
    payload.diff = Array.from(
      { length: 8 },
      (_, i) => `@@ -${i + 1} +${i + 1} @@\n-old value ${i}\n+new value ${i}`,
    ).join("\n");
    meta = {
      truncation: {
        reasons: ["bytes"],
        strategy: "head",
        fields: ["diff"],
        retained: { bytes: 96, lines: 24 },
        total: { bytes: 384, lines: 96 },
      },
    };
  }
  if (call.name === "grep") {
    payload.matches = Array.from({ length: 100 }, (_, i) => ({
      path: longPath,
      line: i + 1,
      text: "needle",
      before: [],
      after: [],
    }));
    meta = {
      truncation: {
        reasons: ["items"],
        strategy: "head",
        fields: ["matches"],
        retained: { bytes: 12_800, items: 100 },
        total: { items: 620 },
        nextArguments: { pattern: "needle", path: longPath, offset: 100 },
      },
    };
  }
  if (call.name === "find" || call.name === "ls") {
    payload.entries = Array.from({ length: 100 }, (_, i) => ({
      name: `example-${i}.ts`,
      path: `example-${i}.ts`,
      type: "file",
    }));
    meta = {
      truncation: {
        reasons: ["items"],
        strategy: "head",
        fields: ["entries"],
        retained: { bytes: 6_400, items: 100 },
        total: { items: 1_240 },
      },
    };
  }
  return {
    call: withLongPath(call),
    result: { ok: true, result: payload, ...(meta === undefined ? {} : { meta }) },
  };
}

function failureExample(index: number, long: boolean): Example {
  const fixture = canonicalToolFixtures[index];
  const call = long ? withLongPath(fixture.call) : fixture.call;
  if (call.name === "bash") {
    return {
      call,
      result: {
        ok: false,
        error: {
          code: "EEXIT",
          message: "Command exited with a non-zero status.",
          details: {
            resolvedPath: "/workspace",
            realTargetPath: "/workspace",
            cwdRelation: "inside",
            exitCode: 7,
            signal: null,
            stdout: "tests started\n1 passed\n2 passed\n",
            stderr: "one failure\nexample-3.test.ts → expected 3 to be 5",
            termination: {
              scope: "process-group",
              forced: false,
              cleanupConfirmed: true,
            },
          },
        },
        meta: {
          truncation: {
            reasons: ["bytes"],
            strategy: "tail",
            fields: ["stdout", "stderr"],
            retained: { bytes: 28 },
          },
        },
      },
    };
  }
  return {
    call,
    result: {
      ok: false,
      error: { code: "EACCES", message: "Permission denied (simulated)." },
    },
  };
}

function batchExamples(long: boolean): readonly Example[] {
  const bashLines = long ? 20 : 6;
  const hunks = long ? 8 : 2;
  const matchCount = long ? 100 : 8;
  const bash: Example = {
    call: {
      id: "batch-bash",
      name: "bash",
      arguments: {
        command: long
          ? "pnpm exec vitest run --reporter=verbose"
          : "pnpm test",
        cwd: ".",
      },
    },
    result: {
      ok: true,
      result: {
        resolvedPath: "/workspace",
        realTargetPath: "/workspace",
        cwdRelation: "inside",
        exitCode: 0,
        stdout: Array.from(
          { length: bashLines },
          (_, i) => `✓ example-${i + 1}.test.ts passed (${(i + 1) * 3} ms)`,
        ).join("\n"),
        stderr: "",
        termination: {
          scope: "process-group",
          forced: false,
          cleanupConfirmed: true,
        },
      },
      ...(long
        ? {
            meta: {
              truncation: {
                reasons: ["bytes"],
                strategy: "tail",
                fields: ["stdout"],
                retained: { bytes: 16_384, lines: bashLines },
                total: { bytes: 98_304, lines: 120 },
              },
            },
          }
        : {}),
    },
  };
  const edit: Example = {
    call: {
      id: "batch-edit",
      name: "edit",
      arguments: {
        path: long ? longPath : "src/example.ts",
        edits: [{ oldText: "old", newText: "new", replaceAll: true }],
      },
    },
    result: {
      ok: true,
      result: {
        resolvedPath: long ? `/workspace/${longPath}` : "/workspace/src/example.ts",
        realTargetPath: long ? `/workspace/${longPath}` : "/workspace/src/example.ts",
        cwdRelation: "inside",
        editsApplied: 3,
        replacementsApplied: 5,
        bytesWritten: 128,
        diff: Array.from(
          { length: hunks },
          (_, i) => `@@ -${i + 1} +${i + 1} @@\n-old value ${i}\n+new value ${i}`,
        ).join("\n"),
      },
      ...(long
        ? {
            meta: {
              truncation: {
                reasons: ["bytes"],
                strategy: "head",
                fields: ["diff"],
                retained: { bytes: 96, lines: hunks * 3 },
                total: { bytes: 384, lines: 96 },
              },
            },
          }
        : {}),
    },
  };
  const grep: Example = {
    call: {
      id: "batch-grep",
      name: "grep",
      arguments: { pattern: "TODO", path: "src" },
    },
    result: {
      ok: true,
      result: {
        resolvedPath: "/workspace/src",
        realTargetPath: "/workspace/src",
        cwdRelation: "inside",
        matches: Array.from({ length: matchCount }, (_, i) => ({
          path: `src/example-${(i % 8) + 1}.ts`,
          line: i + 1,
          text: "TODO: refactor this module",
          before: [],
          after: [],
        })),
        diagnostics: [],
      },
      ...(long
        ? {
            meta: {
              truncation: {
                reasons: ["items"],
                strategy: "head",
                fields: ["matches"],
                retained: { bytes: 12_800, items: matchCount },
                total: { items: 620 },
                nextArguments: { pattern: "TODO", path: "src", offset: matchCount },
              },
            },
          }
        : {}),
    },
  };
  return [bash, edit, grep];
}

type ResultSegment = {
  readonly label: string;
  readonly lines: readonly string[];
  readonly kind: "output" | "meta";
  readonly unit: "行" | "项";
  readonly digest?: string;
};

function extractSegments(result: ToolResult): readonly ResultSegment[] {
  const payload = result.ok ? result.result : result.error.details;
  const record = isRecord(payload) ? payload : undefined;
  if (record === undefined) {
    return [];
  }
  const segments: ResultSegment[] = [];
  const resolvedPath = str(record, "resolvedPath");
  const realTargetPath = str(record, "realTargetPath");
  if (
    resolvedPath !== undefined &&
    realTargetPath !== undefined &&
    resolvedPath !== realTargetPath
  ) {
    segments.push({
      label: "symlink",
      lines: [`${resolvedPath} → ${realTargetPath}`],
      kind: "meta",
      unit: "行",
    });
  }
  for (const field of ["stdout", "stderr"] as const) {
    const output = str(record, field);
    if (output !== undefined && output.trim() !== "") {
      segments.push({
        label: field,
        lines: output.trimEnd().split("\n"),
        kind: "output",
        unit: "行",
      });
    }
  }
  const diff = str(record, "diff");
  if (diff !== undefined && diff !== "") {
    segments.push({ label: "diff", lines: diff.split("\n"), kind: "output", unit: "行" });
  }
  const matches = arr(record, "matches");
  if (matches.length > 0) {
    segments.push({
      label: "matches",
      lines: matches.map(matchLine),
      kind: "output",
      unit: "项",
    });
  }
  const entries = arr(record, "entries");
  if (entries.length > 0) {
    segments.push({
      label: "entries",
      lines: entries.map(entryLine),
      kind: "output",
      unit: "项",
    });
  }
  const termination = isRecord(record.termination) ? record.termination : undefined;
  if (termination !== undefined) {
    segments.push({
      label: "termination",
      lines: [
        `${str(termination, "scope") ?? "process"} · ${termination.forced === true ? "forced" : "graceful"}`,
      ],
      kind: "meta",
      unit: "行",
    });
  }
  const truncation = result.meta?.truncation;
  if (truncation !== undefined) {
    const total =
      truncation.total === undefined
        ? undefined
        : formatCount(
            truncation.total.lines,
            truncation.total.items,
            truncation.total.bytes,
          );
    segments.push({
      label: "truncation",
      lines: [truncationLine(truncation)],
      kind: "meta",
      unit: "行",
      digest: `截断 ${truncation.strategy}${total === undefined ? "" : ` · 全部 ${total}`}`,
    });
    if (truncation.nextArguments !== undefined) {
      segments.push({
        label: "next",
        lines: [nextArgumentsLine(truncation.nextArguments)],
        kind: "meta",
        unit: "行",
        digest: `续读 ${
          typeof truncation.nextArguments.offset === "number"
            ? `offset ${truncation.nextArguments.offset}`
            : "后续参数"
        }`,
      });
    }
  }
  return segments;
}

function matchLine(match: unknown): string {
  const record = isRecord(match) ? match : undefined;
  if (record === undefined) {
    return "";
  }
  return `${str(record, "path") ?? ""}:${typeof record.line === "number" ? record.line : 0} · ${str(record, "text") ?? ""}`;
}

function entryLine(entry: unknown): string {
  const record = isRecord(entry) ? entry : undefined;
  if (record === undefined) {
    return "";
  }
  return `${str(record, "name") ?? ""} · ${str(record, "type") ?? ""}`;
}

function truncationLine(
  truncation: NonNullable<ToolResultMeta["truncation"]>,
): string {
  const retained = formatCount(
    truncation.retained.lines,
    truncation.retained.items,
    truncation.retained.bytes,
  );
  const total = truncation.total === undefined
    ? undefined
    : formatCount(
        truncation.total.lines,
        truncation.total.items,
        truncation.total.bytes,
      );
  return `${truncation.strategy} · 保留 ${retained}${total === undefined ? "" : `/${total}`}`;
}

function formatCount(
  lines: number | undefined,
  items: number | undefined,
  bytes: number | undefined,
): string {
  if (lines !== undefined) {
    return `${lines} 行`;
  }
  if (items !== undefined) {
    return `${items} 项`;
  }
  return `${bytes ?? 0} B`;
}

function nextArgumentsLine(next: JsonObject): string {
  return Object.entries(next)
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(" · ");
}

function str(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function arr(record: Record<string, unknown>, field: string): readonly unknown[] {
  const value = record[field];
  return Array.isArray(value) ? value : [];
}

type CardRow = {
  readonly text: string;
  readonly kind: "content" | "meta" | "gap" | "digest";
};

type VariantKey = "A" | "B" | "C";

const variants = [
  { key: "A" as const, name: "嵌套·行数上限" },
  { key: "B" as const, name: "首尾·窗口" },
  { key: "C" as const, name: "单行摘要" },
];

const CLAMP_BUDGET = 4;
const WINDOW_EDGE = 2;

function variantRows(
  segments: readonly ResultSegment[],
  variant: VariantKey,
): readonly CardRow[] {
  const outputSegments = segments.filter((segment) => segment.kind === "output");
  const metaRows: CardRow[] = segments
    .filter((segment) => segment.kind === "meta")
    .map((segment) => ({
      text: `${segment.label} · ${segment.lines[0] ?? ""}`,
      kind: "meta" as const,
    }));
  if (variant === "C") {
    const parts = outputSegments.map(
      (segment) => `${segment.label} ${segment.lines.length} ${segment.unit}`,
    );
    for (const segment of segments) {
      if (segment.kind === "meta" && segment.digest !== undefined) {
        parts.push(segment.digest);
      }
    }
    return parts.length === 0 ? [] : [{ text: parts.join(" · "), kind: "digest" }];
  }
  if (variant === "A") {
    const contentRows: CardRow[] = outputSegments.flatMap((segment) =>
      segment.lines.map((line) => ({
        text: `${segment.label} · ${line}`,
        kind: "content" as const,
      })),
    );
    const all = [...contentRows, ...metaRows];
    const shown = all.slice(0, CLAMP_BUDGET);
    if (all.length > shown.length) {
      return [
        ...shown,
        { text: `…其余 ${all.length - shown.length} 行省略`, kind: "gap" },
      ];
    }
    return shown;
  }
  const rows: CardRow[] = [];
  for (const segment of segments) {
    if (segment.kind === "meta") {
      rows.push({
        text: `${segment.label} · ${segment.lines[0] ?? ""}`,
        kind: "meta",
      });
      continue;
    }
    if (segment.lines.length <= WINDOW_EDGE * 2 + 1) {
      rows.push(
        ...segment.lines.map((line) => ({
          text: `${segment.label} · ${line}`,
          kind: "content" as const,
        })),
      );
      continue;
    }
    rows.push(
      ...segment.lines.slice(0, WINDOW_EDGE).map((line) => ({
        text: `${segment.label} · ${line}`,
        kind: "content" as const,
      })),
      {
        text: `…${segment.label} 中间省略 ${segment.lines.length - WINDOW_EDGE * 2} ${segment.unit}…`,
        kind: "gap" as const,
      },
      ...segment.lines.slice(-WINDOW_EDGE).map((line) => ({
        text: `${segment.label} · ${line}`,
        kind: "content" as const,
      })),
    );
  }
  return rows;
}

function VariantCardView({
  card,
  segments,
  variant,
}: {
  readonly card: TuiToolCard;
  readonly segments: readonly ResultSegment[];
  readonly variant: VariantKey;
}) {
  const running = card.status === "requested" || card.status === "running";
  const rows = running ? [] : variantRows(segments, variant);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <ToolLineView tool={card} />
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
    </Box>
  );
}

function VariantLedgerView({
  cards,
  segmentSets,
  variant,
}: {
  readonly cards: readonly TuiToolCard[];
  readonly segmentSets: ReadonlyArray<readonly ResultSegment[]>;
  readonly variant: VariantKey;
}) {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {cards.map((card, index) => (
        <VariantCardView
          key={card.id}
          card={card}
          segments={segmentSets[index] ?? []}
          variant={variant}
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
  const [tool, setTool] = useState(0);
  const [scenario, setScenario] = useState(0);
  const [variant, setVariant] = useState(0);
  const [stage, setStage] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [full, setFull] = useState(true);
  const [long, setLong] = useState(false);
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
  const examples =
    scenario === 0
      ? [successExample(tool, long)]
      : scenario === 1
        ? [failureExample(tool, long)]
        : batchExamples(long);

  let state = createTuiState({
    status: "running",
    sessionId: "tool-result-preview",
    cwd: "/workspace",
    messages: [],
    pending: null,
    model: "preview",
    reasoningEffort: "high",
    contextWindow: 128_000,
    contextTokens: 0,
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
        event: { type: "tool-completed", toolCall: example.call, result: example.result },
      });
    }
    state = { ...state, status: "idle" };
  }

  const cards = state.tools;
  const segmentSets = examples.map((example) => extractSegments(example.result));
  const contentRows = Math.max(1, size.rows - (full ? 11 : 6));
  const totalRows = cards.reduce(
    (sum, card, index) =>
      sum +
      1 +
      (card.status === "requested" || card.status === "running"
        ? 0
        : variantRows(segmentSets[index] ?? [], variants[variant].key).length),
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
        (value) => (value + (key.rightArrow ? 1 : -1) + variants.length) % variants.length,
      );
    } else if (input === "t") {
      setTool((value) => (value + 1) % canonicalToolFixtures.length);
      restart();
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
    } else if (input === "l") {
      setLong((value) => !value);
      restart();
    } else if (key.downArrow) {
      setScroll(Math.min(maxScroll, offset + 1));
    } else if (key.upArrow) {
      setScroll(Math.max(0, offset - 1));
    }
  });
  return (
    <Box flexDirection="column" width={size.columns}>
      <Text bold color="cyan">
        工具结果卡片原型 · 调用行下方展示结果
      </Text>
      <Text wrap="truncate-end">
        {canonicalToolFixtures
          .map((entry, i) => (i === tool ? `[${entry.call.name}]` : entry.call.name))
          .join("  ")}
      </Text>
      <Text wrap="truncate-end">
        变体 {variants[variant].key} {variants[variant].name} · {scenarios[scenario]} ·{" "}
        {cards.length > 1 ? `${cards.length} 个工具` : cards[0]?.name} ·{" "}
        {cards[0]?.status} · {paused ? "暂停" : "循环播放"} ·{" "}
        {full ? "Susan 布局" : "工具区域"} · {long ? "长内容" : "标准内容"}
      </Text>
      <Text dimColor wrap="truncate-end">
        ←/→ 变体 · t 工具 · s 场景 · l 内容 · v 视图 · 空格 暂停 · n 单步 · r 重播 ·
        ↑/↓ 滚动 · q 退出
      </Text>
      {full && <Text>你 ▸ 跑一遍测试并修复失败的用例</Text>}
      <Box height={contentRows} overflow="hidden" flexDirection="column" flexShrink={0}>
        <Box flexDirection="column" flexShrink={0} marginTop={-offset}>
          <VariantLedgerView
            cards={cards}
            segmentSets={segmentSets}
            variant={variants[variant].key}
          />
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
  console.error("请在交互式终端运行 pnpm preview:tool-results");
  process.exitCode = 1;
} else {
  await render(<Preview />, {
    stdout: createTuiOutput(process.stdout),
    incrementalRendering: true,
  }).waitUntilExit();
}
