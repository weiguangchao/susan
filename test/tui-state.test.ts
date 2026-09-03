import { describe, expect, it } from "vitest";
import {
  createTuiState,
  formatToolCallDetail,
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
    ...overrides,
  });
}

describe("TUI state", () => {
  it("supports the agreed multiline input and submission keys", () => {
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
      key: { input: " ", shift: true },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "b" },
    });

    expect(state.input).toBe("a\n\nb");
    expect(
      resolveInputIntent(state, { input: "\r", return: true }),
    ).toEqual({ type: "submit", content: "a\n\nb" });
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
      },
    });
    current = reduceTuiState(current, {
      type: "input-key",
      key: { input: "r" },
    });
    expect(current.status).toBe("running");
    expect(current.pending).toBeNull();
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
      },
    });

    expect(state.retry).toBeNull();
    expect(state.failure?.httpStatus).toBe(429);
    expect(state.pending).toEqual({ reason: "provider-failure" });
  });

  it("resolves slash commands before submitting to the Harness", () => {
    expect(resolveSubmission("/exit")).toEqual({ type: "exit" });
    expect(resolveSubmission("/clear")).toEqual({ type: "clear" });
    expect(resolveSubmission("/exit ")).toEqual({ type: "exit" });
    expect(resolveSubmission(" hello\nworld ")).toEqual({
      type: "submit",
      content: "hello\nworld",
    });
  });
});
