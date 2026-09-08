// Development preview: inspect existing Tool UI in isolation or a Susan layout.
// In-memory simulated events only; never creates a Harness or executes a Tool.
import { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import type { ProviderToolCall } from "../src/core/provider.js";
import type { ToolResult } from "../src/core/tool-result.js";
import { isRecord, type JsonValue } from "../src/core/json.js";
import { createTuiState, reduceTuiState } from "../src/ui/state.js";
import { InputLine, StatusBar, ToolLedgerView } from "../src/ui/tui.js";
import { createTuiOutput } from "../src/ui/terminal-output.js";
import { canonicalToolFixtures } from "../test/fixtures/tui-tool-results.js";

const scenarios = ["成功", "失败", "中断", "原始样例"] as const;
const phases = ["requested", "running", "result"] as const;
const durations = [900, 4000, 2400];

function makeExample(index: number, scenario: number, long: boolean) {
  const fixture = canonicalToolFixtures[index];
  const call: ProviderToolCall = structuredClone(fixture.call);
  let result: ToolResult = structuredClone(fixture.result);
  const path = long
    ? "src/features/tool-preview/components/very-long-directory-name/example-with-a-long-file-name.ts"
    : "src/example.ts";
  if (long && scenario !== 3) {
    call.arguments = { ...(isRecord(call.arguments) ? call.arguments : {}), ...(call.name === "bash"
      ? { command: "pnpm exec vitest run test/tui-tool-ledger.test.tsx test/tui-render.test.tsx --reporter=verbose" }
      : { path }) };
  }
  if (scenario === 1) {
    result = { ok: false, error: call.name === "bash"
      ? { code: "EEXIT", message: "Command exited with a non-zero status.", details: { exitCode: 1, stdout: "Running checks…", stderr: "Example failure (simulated)" } }
      : { code: "EACCES", message: "Permission denied (simulated)." } };
  } else if (scenario !== 3) {
    if (call.name === "bash") {
      result = { ok: true, result: { exitCode: 0, stdout: long
        ? Array.from({ length: 20 }, (_, i) => `✓ example-${i + 1}.test.ts passed`).join("\n")
        : "All checks passed.\n", stderr: "" } };
    } else if (result.ok) {
      const payload: Record<string, JsonValue> = { ...result.result };
      result = { ok: true, result: payload };
      if (long) {
        payload.resolvedPath = `/workspace/${path}`;
        payload.realTargetPath = `/workspace/${path}`;
        payload.cwdRelation = "inside";
        if (call.name === "edit") payload.diff = Array.from({ length: 8 }, (_, i) => `@@ -${i + 1} +${i + 1} @@\n-old value ${i}\n+new value ${i}`).join("\n");
        if (call.name === "grep") payload.matches = Array.from({ length: 100 }, (_, i) => ({ path, line: i + 1, text: "needle", before: [], after: [] }));
        if (call.name === "find" || call.name === "ls") payload.entries = Array.from({ length: 100 }, (_, i) => ({ name: `example-${i}.ts`, path: `example-${i}.ts`, type: "file" }));
      }
    }
  }
  return { call, result };
}

function Preview() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
  const [tool, setTool] = useState(0);
  const [scenario, setScenario] = useState(0);
  const [stage, setStage] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [full, setFull] = useState(true);
  const [long, setLong] = useState(false);
  const [scroll, setScroll] = useState(0);

  useEffect(() => {
    const resize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);
  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => setElapsed(value => value + 100), 100);
    return () => clearInterval(timer);
  }, [paused]);
  useEffect(() => {
    if (elapsed < durations[stage]) return;
    setElapsed(0);
    setStage(value => (value + 1) % phases.length);
    setScroll(0);
  }, [elapsed, stage]);

  const restart = () => { setStage(0); setElapsed(0); setScroll(0); };
  const { call, result } = makeExample(tool, scenario, long);
  let state = createTuiState({
    status: "running", sessionId: "tool-preview", cwd: "/workspace", messages: [],
    pending: null, model: "preview", reasoningEffort: "high", contextWindow: 128000,
    sessionTotalTokens: 0, sessionInputTokens: 0, sessionCachedInputTokens: 0,
  });
  state = reduceTuiState(state, { type: "harness-event", event: {
    type: "tool-call-delta", index: 0, id: call.id, name: call.name,
    argumentsDelta: JSON.stringify(call.arguments),
  } });
  if (stage >= 1) state = reduceTuiState(state, { type: "harness-event", event: { type: "tool-started", toolCall: call } });
  if (stage === 2) {
    state = reduceTuiState(state, { type: "harness-event", event: scenario === 2
      ? { type: "agent-loop-interrupted" }
      : { type: "tool-completed", toolCall: call, result } });
    state = { ...state, status: scenario === 2 ? "pending" : "idle" };
  }
  const contentRows = Math.max(1, size.rows - (full ? 12 : 7));
  const totalRows = state.tools.reduce((n, card) => n + 1 + card.supplementalLines.length, 0);
  const maxScroll = Math.max(0, totalRows - contentRows);
  const offset = Math.min(scroll, maxScroll);
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) { exit(); return; }
    if (key.leftArrow || key.rightArrow) {
      setTool(value => (value + (key.rightArrow ? 1 : -1) + canonicalToolFixtures.length) % canonicalToolFixtures.length);
      restart();
    } else if (input === " ") setPaused(value => !value);
    else if (input === "r") restart();
    else if (input === "s") { setScenario(value => (value + 1) % scenarios.length); restart(); }
    else if (input === "v") setFull(value => !value);
    else if (input === "l") { setLong(value => !value); restart(); }
    else if (input === "n") { setPaused(true); setStage(value => (value + 1) % phases.length); setElapsed(0); setScroll(0); }
    else if (key.downArrow) setScroll(Math.min(maxScroll, offset + 1));
    else if (key.upArrow) setScroll(Math.max(0, offset - 1));
  });
  return (
    <Box flexDirection="column" width={size.columns}>
      <Text bold color="cyan">Tool UI 预览 · 模拟调用</Text>
      <Text wrap="truncate-end">{canonicalToolFixtures.map((entry, i) => i === tool ? `[${entry.call.name}]` : entry.call.name).join("  ")}</Text>
      <Text wrap="truncate-end">{scenarios[scenario]} · {state.tools[0]?.status} · {paused ? "暂停" : "循环播放"} · {full ? "Susan 布局" : "工具区域"} · {scenario === 3 ? "fixture 内容" : long ? "长内容" : "标准内容"}</Text>
      <Text dimColor wrap="truncate-end">←/→ 工具 · 空格 暂停 · r 重播 · s 场景 · n 单步</Text>
      <Text dimColor wrap="truncate-end">v 视图 · l 内容 · ↑/↓ 滚动 · q 退出</Text>
      {full && <Text>you ▸ 请演示 {call.name} 工具的调用过程</Text>}
      <Box height={contentRows} overflow="hidden" flexDirection="column" flexShrink={0}>
        <Box flexDirection="column" flexShrink={0} marginTop={-offset}>
          <ToolLedgerView tools={state.tools} />
        </Box>
      </Box>
      <Text dimColor wrap="truncate-end">{maxScroll > 0 ? `详情 ${offset + 1}–${Math.min(totalRows, offset + contentRows)}/${totalRows} 行 · ↑/↓ 查看` : "请求 0.9s → 运行 4s → 结果 2.4s"}</Text>
      {full && <>
        <InputLine input="" cursor={state.inputCursor} columns={size.columns} />
        <StatusBar state={state} />
      </>}
    </Box>
  );
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("请在交互式终端运行 pnpm preview:tools");
  process.exitCode = 1;
} else {
  await render(<Preview />, { stdout: createTuiOutput(process.stdout), incrementalRendering: true }).waitUntilExit();
}
