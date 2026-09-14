import { Box, renderToString } from "ink";
import { describe, expect, it } from "vitest";
import type { ProviderToolCall, ToolResult } from "../src/index";
import { createTuiState, reduceTuiState } from "../src/index";
import { SessionContentView, ToolLineView } from "../src/ui/tui";
import { canonicalToolFixtures } from "./fixtures/tui-tool-results";

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
  it.each(canonicalToolFixtures)("hides active calls and colors terminal results for $call.name", ({ call, result, isError }) => {
    let state = reduceTuiState(initialState(), { type: "harness-event", event: { type: "tool-started", toolCall: call } });
    for (const status of ["requested", "running"] as const) {
      expect(renderToString(<SessionContentView messages={[]} tools={[{ ...state.tools[0]!, status }]} />)).toBe("");
    }
    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "tool-completed", toolCall: call, result, isError },
    });
    const output = renderToString(<SessionContentView messages={[]} tools={state.tools} />, { columns: 80 });
    expect(output).toContain(call.name);
    expect(output).toContain(state.tools[0]!.invocationLabel);
    if (call.name === "read" || call.name === "grep") {
      expect(output).toContain(state.tools[0]!.summary);
      expect(output).not.toContain(`${call.name} ·`);
      return;
    }
    const line = ToolLineView({ tool: state.tools[0]! });
    expect(line?.props.color).toBe(isError ? "red" : "green");
    expect(renderToString(line!)).toBe(`${call.name} · ${state.tools[0]!.invocationLabel} · ${state.tools[0]!.summary}`);
  });

  it("archives each result immediately and retains it when the next tool is interrupted", () => {
    const first = canonicalToolFixtures[0]!;
    const second = canonicalToolFixtures[1]!;
    let state = initialState();
    const emit = (event: import("../src/index").HarnessEvent) => {
      state = reduceTuiState(state, { type: "harness-event", event });
    };
    const history = () => renderToString(<SessionContentView messages={[]}
      tools={state.completedOutput.flatMap(item => item.kind === "tool-batch" ? item.tools : [])} />);
    emit({ type: "tool-started", toolCall: first.call });
    emit({
      type: "tool-completed",
      toolCall: first.call,
      result: first.result,
      isError: first.isError,
    });
    expect(history()).toContain("read src/link.ts");
    expect(history()).toContain("L1 · 1 行 · 19 B");
    emit({ type: "tool-started", toolCall: second.call });
    expect(history()).toContain("read src/link.ts");
    expect(history()).not.toContain("write ·");
    emit({ type: "agent-loop-interrupted" });
    expect(history().split("read src/link.ts")).toHaveLength(2);
    expect(history()).toContain("write · /outside/report.txt · 已中断");
    expect(state.awaitingModelAfterTools).toBe(false);
  });

  it("archives a failed Tool Result without requiring tool-started", () => {
    const state = reduceTuiState(initialState(), { type: "harness-event", event: {
      type: "tool-completed",
      toolCall: { id: "failure", name: "bash", arguments: { command: "pwd" } },
      result: { content: [{ type: "text", text: "failed" }] },
      isError: true,
    } });
    const tools = state.completedOutput.flatMap(item => item.kind === "tool-batch" ? item.tools : []);
    expect(renderToString(<SessionContentView messages={[]} tools={tools} />)).toContain("bash · pwd · failed");
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
          content: [{ type: "text", text: "four\nfive\nsix" }],
          details: {
            range: { startLine: 4, endLine: 6 },
            totalLines: 12,
            sizeBytes: 1_024,
            bom: false,
            lineEnding: "lf",
          },
        },
        isError: false,
      },
    });

    expect(state.tools[0]?.summary).toBe("L4–6 / 12");
    expect(state.tools[0]?.startLine).toBe(4);
    expect(state.tools[0]?.totalLines).toBe(12);
    expect(state.tools[0]?.supplementalLines).toEqual(["four", "five", "six"]);
  });

  it("derives the Read file total from offset plus a Pi more-lines notice", () => {
    const state = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall: {
          id: "read-more",
          name: "read",
          arguments: { path: "large.txt", offset: 4, limit: 3 },
        },
        result: {
          content: [{
            type: "text",
            text: "four\nfive\nsix\n\n[6 more lines in file. Use offset=7 to continue.]",
          }],
        },
        isError: false,
      },
    });
    expect(state.tools[0]?.summary).toBe("L4–6 / 12");
    expect(state.tools[0]?.totalLines).toBe(12);
    const output = renderToString(
      <SessionContentView messages={[]} tools={state.tools} />,
      { columns: 80 },
    );
    expect(output).toContain("L4–6 / 12");
    expect(output).toContain(" ⋮  其余 9 行");
    expect(output).not.toContain("[6 more lines");
  });

  it.each<{
    readonly name: string;
    readonly result: ToolResult;
    readonly rows: readonly string[];
  }>([
    {
      name: "ls",
      result: { content: [{ type: "text", text: "(empty directory)" }] },
      rows: ["└ 空目录"],
    },
    {
      name: "ls",
      result: {
        content: [{ type: "text", text: "file.ts\nsrc/\nlink" }],
      },
      rows: ["├ file.ts", "├ src/", "└ link"],
    },
  ])("renders normal $name result rows without content prefixes", ({ name, result, rows }) => {
    const state = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall: { id: "normal", name, arguments: { path: "." } },
        result,
        isError: false,
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
        result: {
          content: [{ type: "text", text: "Missing path" }],
          details: { path: "missing" },
        },
        isError: true,
      },
    });
    expect(state.tools[0]?.supplementalLines).toEqual(
      ["Missing path", 'error details · {"path":"missing"}'],
    );
  });

  it("shares the four-row budget between Ls entries and the Pi limit notice", () => {
    const state = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall: { id: "page", name: "ls", arguments: { path: ".", limit: 4 } },
        result: {
          content: [{
            type: "text",
            text: "a\nb\nc\nd\n\n[4 entries limit reached. Use limit=8 for more]",
          }],
          details: { entryLimitReached: 4 },
        },
        isError: false,
      },
    });
    expect(state.tools[0]?.supplementalLines).toEqual([
      "a",
      "b",
      "c",
      "d",
      "[4 entries limit reached. Use limit=8 for more]",
    ]);
    const output = renderToString(<SessionContentView messages={[]} tools={state.tools} />, { columns: 80 });
    expect(output.split("\n").slice(1).map((line) => line.trim())).toEqual([
      "├ a", "├ b", "├ c", "├ d", "└ …其余 1 行省略",
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
          result: { content: [{ type: "text", text: "ok" }], details: { entries: [] } },
          isError: false,
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
          isError: fixture.isError,
        },
      });
    }

    expect(state.tools.map(({ name, invocationLabel, status, summary }) => ({
      name,
      invocationLabel,
      status,
      summary,
    }))).toEqual([
      { name: "read", invocationLabel: "src/link.ts", status: "completed", summary: "L1 · 1 行 · 19 B" },
      { name: "write", invocationLabel: "/outside/report.txt", status: "completed", summary: "Successfully wrote to /outside/report.txt" },
      { name: "edit", invocationLabel: "src/link.ts", status: "completed", summary: "Successfully replaced 1 block(s) in src/link.ts." },
      { name: "bash", invocationLabel: "pnpm test", status: "failed", summary: "Command exited with code 7" },
      { name: "grep", invocationLabel: "src · /needle/", status: "completed", summary: "2 matches" },
      { name: "find", invocationLabel: ". · **/*.ts", status: "completed", summary: "0 entries" },
      { name: "ls", invocationLabel: "src", status: "completed", summary: "2 entries" },
    ]);
    expect(state.tools[0]?.supplementalLines).toEqual([
      "export const x = 1;",
    ]);
    expect(state.tools[6]?.supplementalLines).toEqual(["index.ts", "ui/"]);
    expect(state.tools[2]?.supplementalLines).toEqual(["-1 old", "+1 new"]);
    expect(state.tools[3]?.supplementalLines).toEqual([
      "tests started",
      "file a",
      "file b",
      "one failure",
      "Command exited with code 7",
    ]);
    expect(state.tools[4]?.supplementalLines).toEqual([
      "a.ts:1: needle",
      "b.ts:2: needle",
    ]);
  });

  it("nests bounded result rows under each tool invocation at 80 columns", () => {
    let state = initialState();
    const first = canonicalToolFixtures[0]!;
    const fixtures = [...canonicalToolFixtures, {
      ...first,
      call: { ...first.call, id: "read-2", arguments: { path: "README.md" } },
      result: {
        content: first.result.content,
      },
    }];
    for (const fixture of fixtures) {
      state = reduceTuiState(state, {
        type: "harness-event",
        event: {
          type: "tool-completed",
          toolCall: fixture.call,
          result: fixture.result,
          isError: fixture.isError,
        },
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
    expect(output).toContain("read src/link.ts");
    expect(output).toContain("L1 · 1 行 · 19 B");
    expect(output).toContain("export const x = 1;");
    expect(output).toContain("write · /outside/report.txt");
    expect(output).toContain("edit · src/link.ts · Successfully replaced");
    expect(output).toContain("+1 new");
    expect(output).not.toContain('"fields":["diff"]');
    expect(output).toContain("bash · pnpm test");
    expect(output).toContain("tests started");
    expect(output).toContain("one failure");
    expect(output).toContain("Command exited with code 7");
    expect(output).toContain("grep src · /needle/");
    expect(output).toContain("2 matches");
    expect(output).toContain("a.ts: needle");
    expect(output).not.toContain("next arguments");
    expect(output).toContain("find · . · **/*.ts · 0 entries");
    expect(output).toContain("ls · src · 2 entries");
    expect(output).toContain("index.ts");
    expect(output).toContain("ui/");
    expect(output).toContain("read README.md");
    expect(output).toContain("…其余");
  });

  it("renders a short read card with a loud verb, dim path, and line gutter", () => {
    const state = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall: canonicalToolFixtures[0]!.call,
        result: canonicalToolFixtures[0]!.result,
        isError: false,
      },
    });
    const output = renderToString(
      <SessionContentView messages={[]} tools={state.tools} />,
      { columns: 80 },
    );
    expect(output).toBe([
      "read src/link.ts                                                L1 · 1 行 · 19 B",
      "   1  export const x = 1;",
    ].join("\n"));
  });

  it("renders a windowed read card with file remainder in the omit row", () => {
    const state = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall: {
          id: "read-window",
          name: "read",
          arguments: { path: "src/ui/tui.tsx", offset: 689, limit: 4 },
        },
        result: {
          content: [{
            type: "text",
            text: [
              "export function ToolLineView({ tool }: { readonly tool: TuiToolCard }) {",
              '  if (tool.status === "requested" || tool.status === "running") return null;',
              "  return (",
              '    <Text color={tool.status === "completed" ? "green" : "red"} wrap="truncate-end">',
              "",
              "[Showing lines 689-692 of 1113. Use offset=693 to continue.]",
            ].join("\n"),
          }],
        },
        isError: false,
      },
    });
    const output = renderToString(
      <SessionContentView messages={[]} tools={state.tools} />,
      { columns: 80 },
    );
    expect(output).toContain("read src/ui/tui.tsx");
    expect(output).toContain("L689–692 / 1113");
    expect(output).toContain(" 689  export function ToolLineView");
    expect(output).toContain(" ⋮  其余 1109 行");
    expect(output).not.toContain("[Showing lines");
    expect(output).not.toContain("├");
    expect(output).not.toContain("└");
  });

  it("renders empty, failed, and image read cards without a line gutter", () => {
    const cards = [
      {
        call: { id: "empty", name: "read", arguments: { path: "notes.md" } },
        result: { content: [{ type: "text" as const, text: "" }] },
        isError: false,
        header: "空文件",
        body: "(empty)",
      },
      {
        call: { id: "missing", name: "read", arguments: { path: "missing.ts" } },
        result: {
          content: [{
            type: "text" as const,
            text: "ENOENT: no such file or directory, open 'missing.ts'",
          }],
        },
        isError: true,
        header: "failed",
        body: "ENOENT: no such file or directory, open 'missing.ts'",
      },
      {
        call: { id: "image", name: "read", arguments: { path: "assets/hero.png" } },
        result: {
          content: [
            { type: "text" as const, text: "Read image file [image/png]" },
            { type: "image" as const, data: "abc", mimeType: "image/png" },
          ],
        },
        isError: false,
        header: "image/png",
        body: "已读 1 张图片",
      },
    ];
    for (const card of cards) {
      const state = reduceTuiState(initialState(), {
        type: "harness-event",
        event: {
          type: "tool-completed",
          toolCall: card.call,
          result: card.result,
          isError: card.isError,
        },
      });
      const output = renderToString(
        <SessionContentView messages={[]} tools={state.tools} />,
        { columns: 80 },
      );
      expect(output).toContain(`read ${card.call.arguments.path}`);
      expect(output).toContain(card.header);
      expect(output).toContain(`      ${card.body}`);
      expect(output).not.toContain("├");
      expect(output).not.toContain("└");
    }
  });

  it("renders grep hits with a line gutter and file: rest remainder", () => {
    const state = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall: canonicalToolFixtures[4]!.call,
        result: canonicalToolFixtures[4]!.result,
        isError: false,
      },
    });
    const output = renderToString(
      <SessionContentView messages={[]} tools={state.tools} />,
      { columns: 80 },
    );
    expect(output).toBe([
      "grep src · /needle/                                                    2 matches",
      "   1  a.ts: needle",
      "   2  b.ts: needle",
    ].join("\n"));
  });

  it("renders a zero-match grep card with the unmatched label at the code column", () => {
    const state = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall: { id: "grep-empty", name: "grep", arguments: { pattern: "none", path: "src" } },
        result: { content: [{ type: "text", text: "No matches found" }] },
        isError: false,
      },
    });
    const output = renderToString(
      <SessionContentView messages={[]} tools={state.tools} />,
      { columns: 80 },
    );
    expect(output).toContain("grep src · /none/");
    expect(output).toContain("0 matches");
    expect(output).toContain("      无匹配");
    expect(output).not.toContain("├");
    expect(output).not.toContain("└");
  });
});
