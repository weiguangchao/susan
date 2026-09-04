import { describe, expect, it } from "vitest";
import {
  createTuiState,
  formatToolCallDetail,
  isEmptySession,
  reduceTuiState,
  resolveInputIntent,
  resolveSubmission,
} from "../src/index.js";
import type { ProviderToolCall } from "../src/index.js";

const toolCall: ProviderToolCall = {
  id: "call-1",
  name: "read_file",
  arguments: { path: "/tmp/example.txt", offset: 1, limit: 2000 },
};

function initialState(
  overrides: Partial<Parameters<typeof createTuiState>[0]> = {},
) {
  return createTuiState({
    status: "idle",
    sessionId: "session-1",
    cwd: "/workspace",
    messages: [],
    pending: null,
    model: "gpt-5-codex",
    reasoningLevel: "high",
    contextWindow: 418_000,
    sessionTotalTokens: 0,
    ...overrides,
  });
}

describe("TUI state", () => {
  it("supports Ctrl+J multiline input and Enter submission", () => {
    let state = initialState();
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "a" },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "j", ctrl: true },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "b" },
    });

    expect(state.input).toBe("a\nb");
    expect(
      resolveInputIntent(state, { input: "\r", return: true }),
    ).toEqual({ type: "submit", content: "a\nb" });
  });

  it("treats Shift+Space as an ordinary space", () => {
    expect(
      resolveInputIntent(initialState(), { input: " ", shift: true }),
    ).toEqual({ type: "insert", text: " " });
  });

  it("preserves a multiline paste as one insertion", () => {
    const pasted = '{\n  "editor.fontSize": 14,\n  "git.autofetch": true\n}';
    const state = reduceTuiState(initialState(), {
      type: "input-key",
      key: { input: pasted },
    });

    expect(state.input).toBe(pasted);
    expect(state.inputCursor).toEqual({ row: 3, column: 1 });
  });

  it("normalizes carriage returns in pasted multiline input", () => {
    const state = reduceTuiState(initialState(), {
      type: "input-key",
      key: { input: "first\r\nsecond\rthird" },
    });

    expect(state.input).toBe("first\nsecond\nthird");
    expect(state.inputCursor).toEqual({ row: 2, column: 5 });
  });

  it("moves past a pasted carriage return to the next line with one right arrow", () => {
    let state = reduceTuiState(initialState(), {
      type: "input-key",
      key: { input: "first\rsecond" },
    });
    state = {
      ...state,
      inputCursor: { row: 0, column: 5 },
    };
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", rightArrow: true },
    });

    expect(state.inputCursor).toEqual({ row: 1, column: 0 });
  });

  it("marks submission and retry as running immediately", () => {
    let current = initialState();
    current = reduceTuiState(current, {
      type: "input-key",
      key: { input: "hello" },
    });
    current = reduceTuiState(current, {
      type: "input-key",
      key: { input: "\r", return: true },
    });
    expect(current.status).toBe("running");

    current = reduceTuiState(current, {
      type: "snapshot",
      snapshot: {
        status: "pending",
        sessionId: "session-1",
        cwd: "/workspace",
        messages: [],
        pending: { reason: "restored" },
        model: "gpt-5-codex",
        reasoningLevel: "high",
        contextWindow: 418_000,
        sessionTotalTokens: 18_400,
      },
    });
    current = reduceTuiState(current, {
      type: "input-key",
      key: { input: "r" },
    });
    expect(current.status).toBe("running");
    expect(current.pending).toBeNull();
  });

  it("supports cursor movement and editing in multiline input", () => {
    let state = initialState();
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "abc" },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "j", ctrl: true },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "def" },
    });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", upArrow: true, inputWidth: 10 },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", leftArrow: true },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", downArrow: true, inputWidth: 10 },
    });
    expect(state.input).toBe("abc\ndef");
    expect(state.inputCursor).toEqual({ row: 1, column: 2 });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "X" },
    });
    expect(state.input).toBe("abc\ndeXf");
    expect(state.inputCursor).toEqual({ row: 1, column: 3 });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "a", ctrl: true },
    });
    expect(state.inputCursor).toEqual({ row: 1, column: 0 });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", backspace: true },
    });
    expect(state.input).toBe("abcdeXf");
    expect(state.inputCursor).toEqual({ row: 0, column: 3 });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "e", ctrl: true },
    });
    expect(state.inputCursor).toEqual({ row: 0, column: 7 });
  });

  it("moves vertically between wrapped visual rows", () => {
    let state = initialState();
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "abcdefghi" },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", upArrow: true, inputWidth: 6 },
    });

    expect(state.inputCursor).toEqual({ row: 0, column: 3 });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", downArrow: true, inputWidth: 6 },
    });
    expect(state.inputCursor).toEqual({ row: 0, column: 9 });
  });

  it("keeps a cursor at a wrapped row end when moving up", () => {
    let state = initialState();
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "abcdefghi" },
    });
    for (let index = 0; index < 3; index += 1) {
      state = reduceTuiState(state, {
        type: "input-key",
        key: { input: "", leftArrow: true },
      });
    }
    expect(state.inputCursor).toEqual({ row: 0, column: 6 });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", upArrow: true, inputWidth: 6 },
    });
    expect(state.inputCursor).toEqual({ row: 0, column: 6 });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", upArrow: true, inputWidth: 6 },
    });
    expect(state.inputCursor).toEqual({ row: 0, column: 6 });
  });

  it("browses submitted user messages from an empty input", () => {
    let state = initialState({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "first response" },
        { role: "user", content: "second" },
      ],
    });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", upArrow: true },
    });
    expect(state.input).toBe("second");
    expect(state.inputCursor).toEqual({ row: 0, column: 6 });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", upArrow: true },
    });
    expect(state.input).toBe("first");

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", downArrow: true },
    });
    expect(state.input).toBe("second");

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", downArrow: true },
    });
    expect(state.input).toBe("");
    expect(state.inputCursor).toEqual({ row: 0, column: 0 });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "third" },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "\r", return: true },
    });
    expect(state.inputHistory).toEqual(["first", "second", "third"]);
    expect(state.inputHistoryIndex).toBe(3);
  });

  it("keeps global input history across a new session", () => {
    let state = initialState();
    state = {
      ...state,
      inputHistory: ["previous session input"],
      inputHistoryIndex: 1,
    };

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", upArrow: true },
    });
    expect(state.input).toBe("previous session input");

    state = reduceTuiState(state, {
      type: "new-session",
      snapshot: {
        status: "idle",
        sessionId: "session-2",
        cwd: "/workspace",
        messages: [],
        pending: null,
        model: "gpt-5-codex",
        reasoningLevel: "high",
        contextWindow: 418_000,
        sessionTotalTokens: 0,
      },
    });
    expect(state.inputHistory).toEqual(["previous session input"]);
    expect(state.inputHistoryIndex).toBe(1);
  });

  it("applies layered Ctrl+C semantics", () => {
    const approvalState = reduceTuiState(
      initialState({ status: "running" }),
      { type: "harness-event", event: { type: "approval-requested", approvalId: "approval-1", toolCall } },
    );
    expect(
      resolveInputIntent(approvalState, { input: "c", ctrl: true }),
    ).toEqual({ type: "deny-approval", approvalId: "approval-1" });

    expect(
      resolveInputIntent(initialState({ status: "running" }), {
        input: "c",
        ctrl: true,
      }),
    ).toEqual({ type: "interrupt" });

    expect(
      resolveInputIntent(
        reduceTuiState(initialState(), {
          type: "input-key",
          key: { input: "draft" },
        }),
        { input: "c", ctrl: true },
      ),
    ).toEqual({ type: "clear-input" });

    expect(
      resolveInputIntent(initialState(), {
        input: "c",
        ctrl: true,
      }),
    ).toEqual({ type: "exit" });
  });

  it("tracks runtime model, reasoning level, and Session usage", () => {
    const state = initialState();

    expect(state.model).toBe("gpt-5-codex");
    expect(state.reasoningLevel).toBe("high");
    expect(state.contextWindow).toBe(418_000);
    expect(state.sessionTotalTokens).toBe(0);

    const updated = reduceTuiState(state, {
      type: "snapshot",
      snapshot: {
        status: "idle",
        sessionId: "session-1",
        cwd: "/workspace",
        messages: [],
        pending: null,
        model: "deepseek-v4-flash",
        reasoningLevel: "medium",
        contextWindow: 128_000,
        sessionTotalTokens: 18_400,
      },
    });

    expect(updated.model).toBe("deepseek-v4-flash");
    expect(updated.reasoningLevel).toBe("medium");
    expect(updated.contextWindow).toBe(128_000);
    expect(updated.sessionTotalTokens).toBe(18_400);
  });

  it("synchronizes Session token usage from Harness events", () => {
    const updated = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "session-usage-updated",
        sessionTotalTokens: 32_000,
        contextWindow: 128_000,
      },
    });

    expect(updated.sessionTotalTokens).toBe(32_000);
    expect(updated.contextWindow).toBe(128_000);
    expect(
      (updated.sessionTotalTokens / updated.contextWindow) * 100,
    ).toBe(25);
  });

  it("resets Session usage when a new Session starts", () => {
    const previous = {
      ...initialState(),
      sessionTotalTokens: 64_000,
      contextWindow: 128_000,
    };
    const next = reduceTuiState(previous, {
      type: "new-session",
      snapshot: {
        status: "idle",
        sessionId: "session-2",
        cwd: "/workspace",
        messages: [],
        pending: null,
        model: "model",
        reasoningLevel: "high",
        contextWindow: 128_000,
        sessionTotalTokens: 0,
      },
    });

    expect(next.sessionTotalTokens).toBe(0);
  });

  it("reduces streaming, Tool, approval, and retry events without Ink", () => {
    let state = initialState({ status: "running" });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "text-delta", textDelta: "He" },
    });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "text-delta", textDelta: "llo" },
    });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "approval-requested", approvalId: "approval-1", toolCall },
    });
    expect(state.stream?.text).toBe("Hello");
    expect(state.approval?.toolCall.name).toBe("read_file");
    expect(state.tools[0]).toMatchObject({ status: "waiting-approval" });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "\r", return: true },
    });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "tool-started", toolCall },
    });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall,
        result: {
          ok: true,
          result: {
            path: "/tmp/example.txt",
            content: "line one\nline two\nline three",
            startLine: 1,
            endLine: 3,
            truncated: false,
          },
        },
      },
    });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "agent-loop-completed" },
    });

    expect(state.stream).toBeNull();
    expect(state.messages.at(-1)).toMatchObject({
      kind: "assistant",
      text: "Hello",
    });
    expect(state.tools[0]).toMatchObject({ status: "completed" });
    expect(state.tools[0]?.detail).toBe(
      "/tmp/example.txt offset=1 limit=2000",
    );
  });

  it("keeps typed Tool failures distinct from successful Tool calls", () => {
    const state = reduceTuiState(
      initialState({ status: "running" }),
      {
        type: "harness-event",
        event: {
          type: "tool-completed",
          toolCall,
          result: {
            ok: false,
            error: { code: "ENOENT", message: "文件不存在" },
          },
        },
      },
    );

    expect(state.tools[0]).toMatchObject({
      status: "failed",
      summary: "ENOENT · 文件不存在",
    });
    expect(formatToolCallDetail(toolCall)).toBe(
      "/tmp/example.txt offset=1 limit=2000",
    );
  });

  it("uses the agreed approval keys and collapses partial Tool deltas", () => {
    let state = initialState({ status: "running" });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "tool-call-delta",
        index: 0,
        argumentsDelta: '{"path":',
      },
    });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "tool-call-delta",
        index: 0,
        id: toolCall.id,
        name: toolCall.name,
        argumentsDelta: '"/tmp/example.txt"}',
      },
    });
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({ id: toolCall.id });

    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "approval-requested", approvalId: "approval-1", toolCall },
    });
    expect(
      resolveInputIntent(state, { input: "\r", return: true }),
    ).toEqual({ type: "approve-approval", approvalId: "approval-1" });
    expect(resolveInputIntent(state, { input: "", escape: true })).toEqual({
      type: "deny-approval",
      approvalId: "approval-1",
    });
  });

  it("resolves restored Pending Agent Loop shortcuts", () => {
    const state = initialState({
      status: "pending",
      pending: { reason: "restored" },
    });
    expect(resolveInputIntent(state, { input: "r" })).toEqual({ type: "retry" });
    expect(resolveInputIntent(state, { input: "n" })).toEqual({
      type: "new-session",
    });
  });

  it("keeps Provider Failure and Pending Agent Loop state visible", () => {
    let state = initialState({ status: "running" });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "provider-retrying",
        retry: 1,
        maxRetries: 2,
        delayMs: 2000,
        failure: {
          code: "PROVIDER_HTTP",
          message: "Too many requests",
          httpStatus: 429,
          hadSemanticOutput: false,
        },
      },
    });
    expect(state.retry).toMatchObject({
      retry: 1,
      maxRetries: 2,
      delayMs: 2000,
    });

    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "provider-failed",
        failure: {
          code: "PROVIDER_HTTP",
          message: "Too many requests",
          httpStatus: 429,
          requestId: "request-1",
          hadSemanticOutput: false,
        },
      },
    });
    state = reduceTuiState(state, {
      type: "snapshot",
      snapshot: {
        status: "pending",
        sessionId: "session-1",
        cwd: "/workspace",
        messages: [],
        pending: { reason: "provider-failure" },
        model: "gpt-5-codex",
        reasoningLevel: "high",
        contextWindow: 418_000,
        sessionTotalTokens: 18_400,
      },
    });

    expect(state.retry).toBeNull();
    expect(state.failure?.httpStatus).toBe(429);
    expect(state.pending).toEqual({ reason: "provider-failure" });
  });

  it("resolves slash commands before submitting to the Harness", () => {
    expect(resolveSubmission("/exit")).toEqual({ type: "exit" });
    expect(resolveSubmission("/clear")).toEqual({ type: "clear" });
    expect(resolveSubmission("/new")).toEqual({ type: "clear" });
    expect(resolveSubmission("/exit ")).toEqual({ type: "exit" });
    expect(resolveSubmission(" hello\nworld ")).toEqual({
      type: "submit",
      content: "hello\nworld",
    });
  });

  it("recognizes whether a Session has any persisted interaction", () => {
    expect(isEmptySession({ messages: [] })).toBe(true);
    expect(
      isEmptySession({ messages: [{ role: "user", content: "hello" }] }),
    ).toBe(false);
  });
});
