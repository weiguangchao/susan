import { Box, renderToString } from "ink";
import { describe, expect, it } from "vitest";
import type { JsonObject, ProviderToolCall } from "../src/index.js";
import { createTuiState, reduceTuiState } from "../src/index.js";
import { SessionContentView, ToolLineView } from "../src/ui/tui.js";
import { canonicalToolFixtures } from "./fixtures/tui-tool-results.js";

function initialState() {
  return createTuiState({
    status: "running",
    sessionId: "session-1",
    cwd: "/workspace",
    messages: [],
    pending: null,
    model: "gpt-5-codex",
    reasoningEffort: "high",
    contextWindow: 418_000,
    contextTokens: 0,
    sessionTotalTokens: 0,
    sessionInputTokens: 0,
    sessionCachedInputTokens: 0,
  });
}

describe("TUI Tool execution ledger", () => {
  it.each(canonicalToolFixtures)("hides active calls and colors terminal results for $call.name", ({ call, result }) => {
    let state = reduceTuiState(initialState(), { type: "harness-event", event: { type: "tool-started", toolCall: call } });
    for (const status of ["requested", "running"] as const) {
      expect(renderToString(<SessionContentView messages={[]} tools={[{ ...state.tools[0]!, status }]} />)).toBe("");
    }
    state = reduceTuiState(state, { type: "harness-event", event: { type: "tool-completed", toolCall: call, result } });
    const line = ToolLineView({ tool: state.tools[0]! });
    expect(line?.props.color).toBe(result.ok ? "green" : "red");
    expect(renderToString(line!)).toBe(`${call.name} · ${state.tools[0]!.invocationLabel} · ${state.tools[0]!.summary}`);
  });

  it("archives each result immediately and retains it when the next tool is interrupted", () => {
    const first = canonicalToolFixtures[0]!;
    const second = canonicalToolFixtures[1]!;
    let state = initialState();
    const emit = (event: import("../src/index.js").HarnessEvent) => {
      state = reduceTuiState(state, { type: "harness-event", event });
    };
    const history = () => renderToString(<SessionContentView messages={[]}
      tools={state.completedOutput.flatMap(item => item.kind === "tool-batch" ? item.tools : [])} />);
    emit({ type: "tool-started", toolCall: first.call });
    emit({ type: "tool-completed", toolCall: first.call, result: first.result });
    expect(history()).toContain("read · src/link.ts · 已读 1 行");
    emit({ type: "tool-started", toolCall: second.call });
    expect(history()).toContain("read · src/link.ts · 已读 1 行");
    expect(history()).not.toContain("write ·");
    emit({ type: "agent-loop-interrupted" });
    expect(history().split("read ·")).toHaveLength(2);
    expect(history()).toContain("write · /outside/report.txt · 已中断");
    expect(state.awaitingModelAfterTools).toBe(false);
  });

  it.each(["ETIMEDOUT", "ETOOL"])("archives %s without requiring tool-started", code => {
    const state = reduceTuiState(initialState(), { type: "harness-event", event: {
      type: "tool-completed", toolCall: { id: "failure", name: "bash", arguments: { command: "pwd" } },
      result: { ok: false, error: { code, message: "failed" } },
    } });
    const tools = state.completedOutput.flatMap(item => item.kind === "tool-batch" ? item.tools : []);
    expect(renderToString(<SessionContentView messages={[]} tools={tools} />)).toContain(`bash · pwd · ${code} · failed`);
    expect(state.awaitingModelAfterTools).toBe(true);
  });

  it("assembles streamed arguments for waiting tool instructions", () => {
    let state = initialState();
    for (const event of [
      { type: "tool-call-delta" as const, index: 0, id: "read-1", name: "read", argumentsDelta: '{"path":"src/' },
      { type: "tool-call-delta" as const, index: 0, argumentsDelta: 'main.ts"}' },
    ]) state = reduceTuiState(state, { type: "harness-event", event });
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({ status: "requested", name: "read", invocationLabel: "src/main.ts" });
  });

  it("normalizes running path labels against the Session cwd", () => {
    let state = initialState();
    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "tool-started",
        toolCall: { id: "inside", name: "read", arguments: { path: "/workspace/src/a.ts" } },
      },
    });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "tool-started",
        toolCall: { id: "outside", name: "ls", arguments: { path: "../outside" } },
      },
    });

    expect(state.tools.map(({ invocationLabel, summary }) => ({ invocationLabel, summary }))).toEqual([
      { invocationLabel: "src/a.ts", summary: "执行中" },
      { invocationLabel: "/outside", summary: "执行中 · outside cwd" },
    ]);
  });

  it("summarizes the returned Read window separately from the whole file", () => {
    const state = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall: {
          id: "read-window",
          name: "read",
          arguments: { path: "large.txt", offset: 4, limit: 3 },
        },
        result: {
          ok: true,
          result: {
            resolvedPath: "/workspace/large.txt",
            realTargetPath: "/workspace/large.txt",
            cwdRelation: "inside",
            content: "four\nfive\nsix",
            range: { startLine: 4, endLine: 6 },
            totalLines: 12,
            sizeBytes: 1_024,
            bom: false,
            lineEnding: "lf",
          },
        },
      },
    });

    expect(state.tools[0]?.summary).toBe("已读 3/12 行 · 13 B");
    expect(state.tools[0]?.supplementalLines).toEqual(["four", "five", "six"]);
  });

  it.each<{ readonly name: string; readonly payload: JsonObject; readonly rows: readonly string[] }>([
    { name: "read", payload: { content: "" }, rows: ["└ 空文件"] },
    { name: "ls", payload: { entries: [] }, rows: ["└ 空目录"] },
    {
      name: "read",
      payload: { content: "first\n\nthird\nfourth\nfifth\n" },
      rows: ["├ first", "├ third", "├ fourth", "└ fifth"],
    },
    {
      name: "ls",
      payload: { entries: [
        { name: "file.ts", type: "file" },
        { name: "src", type: "directory" },
        { name: "link", type: "symlink" },
      ] },
      rows: ["├ file.ts", "├ src/", "└ link@"],
    },
  ])("renders normal $name result rows without content prefixes", ({ name, payload, rows }) => {
    const state = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall: { id: "normal", name, arguments: { path: "." } },
        result: { ok: true, result: payload },
      },
    });
    const output = renderToString(<SessionContentView messages={[]} tools={state.tools} />, { columns: 80 });
    expect(output.split("\n").slice(1).map((line) => line.trim())).toEqual(rows);
  });

  it.each(["read", "ls"])("preserves %s failure details without empty-result labels", (name) => {
    const state = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall: { id: "failure", name, arguments: { path: "missing" } },
        result: { ok: false, error: { code: "ENOENT", message: "Missing path", details: { path: "missing" } } },
      },
    });
    expect(state.tools[0]?.supplementalLines).toEqual(['error details · {"path":"missing"}']);
  });

  it("shares the four-row budget between Ls entries and pagination metadata", () => {
    const state = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall: { id: "page", name: "ls", arguments: { path: ".", limit: 4 } },
        result: {
          ok: true,
          result: { entries: [
            { name: "a", type: "file" }, { name: "b", type: "file" },
            { name: "c", type: "file" }, { name: "d", type: "file" },
          ] },
          meta: { truncation: {
            reasons: ["items"], strategy: "head", fields: ["entries"],
            retained: { bytes: 100, items: 4 }, total: { items: 8 },
            nextArguments: { path: ".", offset: 4 },
          } },
        },
      },
    });
    expect(state.tools[0]?.supplementalLines.slice(4)).toEqual([
      "truncation · head · retained 100 B, 4 items / limit 51,200 B output, 4 items · fields entries · total 8 items",
      'next arguments · {"path":".","offset":4}',
    ]);
    const output = renderToString(<SessionContentView messages={[]} tools={state.tools} />, { columns: 80 });
    expect(output.split("\n").slice(1).map((line) => line.trim())).toEqual([
      "├ a", "├ b", "├ c", "├ d", "└ …其余 2 行省略",
    ]);
  });

  it("keeps Tool Call order when streaming placeholders receive their ids", () => {
    let state = initialState();
    for (const index of [0, 1]) {
      state = reduceTuiState(state, {
        type: "harness-event",
        event: { type: "tool-call-delta", index, argumentsDelta: "{" },
      });
    }
    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "tool-call-delta",
        index: 1,
        id: "second",
        name: "ls",
        argumentsDelta: "}",
      },
    });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "tool-call-delta",
        index: 0,
        id: "first",
        name: "read",
        argumentsDelta: "}",
      },
    });

    expect(state.tools.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "first", name: "read" },
      { id: "second", name: "ls" },
    ]);
  });

  it("does not leave nameless waiting cards after OpenAI-style argument follow-ups", () => {
    let state = initialState();
    const batch: ProviderToolCall[] = [
      { id: "call-ls", name: "ls", arguments: { path: "." } },
      { id: "call-read", name: "read", arguments: { path: "README.md" } },
      { id: "call-find", name: "find", arguments: { path: ".", pattern: "**/*" } },
    ];
    for (const [index, call] of batch.entries()) {
      state = reduceTuiState(state, {
        type: "harness-event",
        event: {
          type: "tool-call-delta",
          index,
          id: call.id,
          name: call.name,
          argumentsDelta: JSON.stringify(call.arguments).slice(0, 8),
        },
      });
      state = reduceTuiState(state, {
        type: "harness-event",
        event: {
          type: "tool-call-delta",
          index,
          argumentsDelta: JSON.stringify(call.arguments).slice(8),
        },
      });
    }

    expect(state.tools).toHaveLength(3);
    expect(state.tools.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "call-ls", name: "ls" },
      { id: "call-read", name: "read" },
      { id: "call-find", name: "find" },
    ]);

    for (const call of batch) {
      state = reduceTuiState(state, {
        type: "harness-event",
        event: { type: "tool-started", toolCall: call },
      });
      state = reduceTuiState(state, {
        type: "harness-event",
        event: {
          type: "tool-completed",
          toolCall: call,
          result: { ok: true, result: { entries: [], content: "ok" } },
        },
      });
    }
    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "tool-batch-completed", toolCalls: batch },
    });

    expect(
      state.tools.filter(
        (tool) => tool.name === "tool" && tool.summary.includes("等待执行"),
      ),
    ).toEqual([]);
    expect(state.tools.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "call-ls", status: "completed" },
      { id: "call-read", status: "completed" },
      { id: "call-find", status: "completed" },
    ]);
  });

  it("reduces the seven canonical Tool Results into ordered main records", () => {
    let state = initialState();
    for (const fixture of canonicalToolFixtures) {
      state = reduceTuiState(state, {
        type: "harness-event",
        event: {
          type: "tool-completed",
          toolCall: fixture.call,
          result: fixture.result,
        },
      });
    }

    expect(state.tools.map(({ name, invocationLabel, status, summary }) => ({
      name,
      invocationLabel,
      status,
      summary,
    }))).toEqual([
      { name: "read", invocationLabel: "src/link.ts", status: "completed", summary: "已读 1 行 · 19 B" },
      { name: "write", invocationLabel: "/outside/report.txt", status: "completed", summary: "overwritten · 12 B · outside cwd" },
      { name: "edit", invocationLabel: "src/real.ts", status: "completed", summary: "1 edit · 2 replacements · 24 B" },
      { name: "bash", invocationLabel: "pnpm test", status: "failed", summary: "exit 7 · EEXIT · Command exited with a non-zero status." },
      { name: "grep", invocationLabel: "src · /needle/", status: "completed", summary: "2 matches" },
      { name: "find", invocationLabel: ". · **/*.ts", status: "completed", summary: "0 entries" },
      { name: "ls", invocationLabel: "src", status: "completed", summary: "2 entries" },
    ]);
    expect(state.tools[0]?.supplementalLines).toEqual([
      "Resolved Path → Real Target Path · /workspace/src/link.ts → /workspace/src/index.ts",
      "export const x = 1;",
    ]);
    expect(state.tools[6]?.supplementalLines).toEqual(["index.ts", "ui/"]);
    expect(state.tools[2]?.supplementalLines).toContain("@@ -1 +1 @@");
    expect(state.tools[2]?.supplementalLines).toContain(
      "truncation · head · retained 24 B, 3 lines / limit 51,200 B output · fields diff · total 96 B, 12 lines",
    );
    expect(state.tools[3]?.supplementalLines).toContain("stdout (tail) · tests started");
    expect(state.tools[3]?.supplementalLines).toContain("stderr (tail) · one failure");
    expect(state.tools[3]?.supplementalLines).toContain(
      "termination · process-group · graceful · cleanup confirmed",
    );
    expect(state.tools[3]?.supplementalLines).toContain("next arguments · unavailable");
    expect(state.tools[4]?.supplementalLines).toContain(
      'next arguments · {"pattern":"needle","path":"src","offset":2}',
    );
    expect(state.tools[4]?.supplementalLines).toContain(
      "truncation · head · retained 128 B, 2 items / limit 51,200 B output, 100 items, 1,000 B per line · fields matches · total 6 items",
    );
  });

  it("nests bounded result rows under each tool invocation at 80 columns", () => {
    let state = initialState();
    const fixtures = [...canonicalToolFixtures, {
      ...canonicalToolFixtures[0],
      call: { ...canonicalToolFixtures[0].call, id: "read-2", arguments: { path: "README.md" } },
      result: {
        ...canonicalToolFixtures[0].result,
        result: {
          ...canonicalToolFixtures[0].result.result,
          resolvedPath: "/workspace/README.md",
          realTargetPath: "/workspace/README.md",
        },
      },
    }];
    for (const fixture of fixtures) {
      state = reduceTuiState(state, {
        type: "harness-event",
        event: { type: "tool-completed", toolCall: fixture.call, result: fixture.result },
      });
    }

    const messages = Array.from({ length: 20 }, (_, index) => ({
      kind: "user" as const,
      text: `message ${index}`,
    }));
    const output = renderToString(
      <Box height={28} width={80} overflow="hidden" flexDirection="column">
        <SessionContentView messages={messages} tools={state.tools} />
      </Box>,
      { columns: 80 },
    );
    const lines = output.split("\n");
    expect(lines[0]).toContain("read · src/link.ts · 已读 1 行 · 19 B");
    expect(lines[1]).toContain("├ Resolved Path → Real Target Path · /workspace/src/link.ts");
    expect(lines[2]).toContain("└ export const x = 1;");
    expect(lines[3]).toContain("write · /outside/report.txt");
    expect(lines[4]).toContain("edit · src/real.ts · 1 edit · 2 replacements · 24 B");
    expect(lines[5]).toContain("├ @@ -1 +1 @@");
    expect(lines[8]).toContain("truncation · head · retained 24 B, 3 lines");
    expect(lines[9]).toContain("└ …其余 1 行省略");
    expect(lines[10]).toContain("bash · pnpm test");
    expect(lines[11]).toContain("stdout (tail) · tests started");
    expect(lines[12]).toContain("stderr (tail) · one failure");
    expect(lines[13]).toContain("termination · process-group");
    expect(lines[14]).toContain("truncation · tail · retained 28 B");
    expect(lines[15]).toContain("└ …其余 1 行省略");
    expect(output).not.toContain("next arguments · unavailable");
    expect(lines[16]).toContain("grep · src · /needle/ · 2 matches");
    expect(lines[17]).toContain("├ truncation · head · retained 128 B, 2 items");
    expect(lines[18]).toContain('└ next arguments · {"pattern":"needle","path":"src","offset":2}');
    expect(lines[19]).toContain("find · . · **/*.ts · 0 entries");
    expect(lines[20]).toContain("ls · src · 2 entries");
    expect(lines[21]).toContain("├ index.ts");
    expect(lines[22]).toContain("└ ui/");
    expect(lines[23]).toContain("read · README.md · 已读 1 行 · 19 B");
    expect(lines[24]).toContain("└ export const x = 1;");
  });
});
