import { Box, renderToString } from "ink";
import { describe, expect, it } from "vitest";
import type { ProviderToolCall } from "../src/index.js";
import { createTuiState, reduceTuiState } from "../src/index.js";
import { SessionContentView } from "../src/ui/tui.js";
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
    sessionTotalTokens: 0,
    sessionInputTokens: 0,
    sessionCachedInputTokens: 0,
  });
}

describe("TUI Tool execution ledger", () => {
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
    expect(state.tools[0]?.supplementalLines).toContain(
      "Resolved Path → Real Target Path · /workspace/src/link.ts → /workspace/src/index.ts",
    );
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

  it("renders all eight main records before bounded supplemental content at 80 columns", () => {
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
      <Box height={24} width={80} overflow="hidden" flexDirection="column">
        <SessionContentView messages={messages} tools={state.tools} />
      </Box>,
      { columns: 80 },
    );
    const lines = output.split("\n");
    expect(lines.slice(0, 8).every((line) => /^[✓✗●⏳■] /.test(line))).toBe(true);
    expect(lines[0]).toContain("✓ read · src/link.ts · 已读 1 行 · 19 B");
    expect(lines[7]).toContain("✓ read · README.md · 已读 1 行 · 19 B");
    expect(lines.findIndex((line) => line.includes("Resolved Path → Real Target Path"))).toBeGreaterThanOrEqual(8);
  });
});
