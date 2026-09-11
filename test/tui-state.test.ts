import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createTuiState,
  createModelPickerState,
  modelPickerRowCount,
  modelPickerWindow,
  formatToolCallDetail,
  isEmptySession,
  reduceModelPickerState,
  reduceTuiState,
  resolveInputIntent,
  resolveModelPickerIntent,
  resolveSlashCommandMenu,
  resolveSubmission,
} from "../src/index.js";
import type {
  ProviderToolCall,
  TuiInputIntent,
  TuiState,
  TuiToolStatus,
} from "../src/index.js";

const toolCall: ProviderToolCall = {
  id: "call-1",
  name: "read",
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
    reasoningEffort: "high",
    contextWindow: 418_000,
    contextTokens: 0, sessionTotalTokens: 0, sessionInputTokens: 0, sessionCachedInputTokens: 0,
    ...overrides,
  });
}

describe("TUI state", () => {
  it("does not expose approval concepts in its public contracts", () => {
    expectTypeOf<
      Extract<TuiToolStatus, "waiting-approval" | "denied">
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<TuiInputIntent["type"], "approve-approval" | "deny-approval">
    >().toEqualTypeOf<never>();
    expectTypeOf<Extract<keyof TuiState, "approval">>().toEqualTypeOf<never>();
  });

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

  it("opens the model picker with /model without submitting it", () => {
    let state = initialState();
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "/model" },
    });

    expect(resolveSubmission(state.input)).toEqual({ type: "model-picker" });

    state = reduceTuiState(state, {
      type: "input-intent",
      intent: { type: "model-picker" },
    });

    expect(state.modelPickerActive).toBe(true);
    expect(state.input).toBe("");
  });

  it("opens the model picker before an incomplete submit or retry", () => {
    let idle = initialState({ model: undefined, reasoningEffort: undefined });
    idle = reduceTuiState(idle, {
      type: "input-key",
      key: { input: "keep this prompt" },
    });

    expect(
      resolveInputIntent(idle, { input: "\r", return: true }),
    ).toEqual({ type: "model-picker" });
    idle = reduceTuiState(idle, {
      type: "input-intent",
      intent: { type: "model-picker" },
    });
    expect(idle.modelPickerActive).toBe(true);
    expect(idle.input).toBe("keep this prompt");

    const pending = initialState({
      status: "pending",
      pending: { reason: "restored" },
      model: undefined,
      reasoningEffort: undefined,
    });
    expect(resolveInputIntent(pending, { input: "r" })).toEqual({
      type: "model-picker",
    });
  });

  it("moves among providers and models in declaration order", () => {
    const catalog = {
      defaultProviderAlias: "deepseek",
      preferredModel: "deepseek-v4-flash",
      preferredReasoningEffort: "medium" as const,
      providers: [
        {
          alias: "deepseek",
          type: "openai-completion" as const,
          models: [{ id: "deepseek-v4-flash" }],
        },
        {
          alias: "backup",
          type: "openai-completion" as const,
          models: [
            { id: "backup-fast" },
            { id: "backup-thinking" },
          ],
        },
      ],
    };
    let state = createModelPickerState(catalog);

    expect(state).toMatchObject({
      providerIndex: 0,
      modelIndex: 0,
      reasoningEffort: "medium",
    });

    state = reduceModelPickerState(state, { type: "next-provider" });
    expect(state).toMatchObject({
      providerIndex: 1,
      modelIndex: 0,
      reasoningEffort: "medium",
    });

    state = reduceModelPickerState(state, { type: "move-model", delta: 1 });
    expect(state.modelIndex).toBe(1);
    state = reduceModelPickerState(state, { type: "move-model", delta: -1 });
    expect(state.modelIndex).toBe(0);
    state = reduceModelPickerState(state, { type: "next-provider" });
    expect(state.providerIndex).toBe(0);
    expect(state.modelIndex).toBe(0);
  });

  it("selects every openai-completion Reasoning Effort after an explicit adjustment", () => {
    const catalog = {
      providers: [
        {
          alias: "deepseek",
          type: "openai-completion" as const,
          models: [{ id: "deepseek-v4-flash" }],
        },
      ],
    };
    let state = createModelPickerState(catalog);

    expect(state.reasoningEffort).toBeNull();
    expect(state.modelIndex).toBeNull();
    expect(
      resolveModelPickerIntent(state, { input: "\r", return: true }),
    ).toEqual({ type: "none" });

    state = reduceModelPickerState(state, { type: "adjust-effort", delta: -1 });
    expect(state.reasoningEffort).toBe("none");
    state = reduceModelPickerState(state, { type: "adjust-effort", delta: 1 });
    expect(state.reasoningEffort).toBe("minimal");
    state = reduceModelPickerState(state, { type: "adjust-effort", delta: 1 });
    expect(state.reasoningEffort).toBe("low");
    state = reduceModelPickerState(state, { type: "adjust-effort", delta: 1 });
    expect(state.reasoningEffort).toBe("medium");
    state = reduceModelPickerState(state, { type: "adjust-effort", delta: 1 });
    expect(state.reasoningEffort).toBe("high");
    state = reduceModelPickerState(state, { type: "adjust-effort", delta: 1 });
    expect(state.reasoningEffort).toBe("xhigh");
    state = reduceModelPickerState(state, { type: "adjust-effort", delta: 1 });
    expect(state.reasoningEffort).toBe("max");
    state = reduceModelPickerState(state, { type: "adjust-effort", delta: 1 });
    expect(state.reasoningEffort).toBe("max");

    state = reduceModelPickerState(state, { type: "move-model", delta: -1 });
    expect(
      resolveModelPickerIntent(state, { input: "\r", return: true }),
    ).toEqual({
      type: "apply",
      selection: {
        providerAlias: "deepseek",
        model: "deepseek-v4-flash",
        reasoningEffort: "max",
      },
    });
  });

  it("selects the first model on the first arrow press from unset", () => {
    let state = createModelPickerState({
      providers: [
        {
          alias: "deepseek",
          type: "openai-completion",
          models: [{ id: "first" }, { id: "second" }],
        },
      ],
    });

    expect(state.modelIndex).toBeNull();
    state = reduceModelPickerState(state, { type: "move-model", delta: 1 });
    expect(state.modelIndex).toBe(0);
  });

  it("starts at the first declared provider when provider is omitted", () => {
    let state = createModelPickerState({
      preferredModel: "matching-second",
      preferredReasoningEffort: "medium",
      providers: [
        {
          alias: "first",
          type: "openai-completion",
          models: [{ id: "first-model" }],
        },
        {
          alias: "second",
          type: "openai-completion",
          models: [{ id: "matching-second" }],
        },
      ],
    });

    expect(state.providerIndex).toBe(0);
    expect(state.modelIndex).toBeNull();
    expect(state.reasoningEffort).toBeNull();

    state = reduceModelPickerState(state, { type: "next-provider" });
    expect(state.providerIndex).toBe(1);
    expect(state.modelIndex).toBe(0);
    expect(state.reasoningEffort).toBe("medium");
  });

  it("windows a long model catalog around the selected index", () => {
    expect(modelPickerWindow(null, 9)).toBe(0);
    expect(modelPickerWindow(0, 9)).toBe(0);
    expect(modelPickerWindow(4, 9)).toBe(0);
    expect(modelPickerWindow(5, 9)).toBe(1);
    expect(modelPickerWindow(8, 9)).toBe(4);
    expect(modelPickerWindow(2, 4)).toBe(0);
  });

  it("counts compact picker rows from the visible window", () => {
    const catalog = {
      providers: [
        {
          alias: "deepseek",
          type: "openai-completion" as const,
          models: Array.from({ length: 9 }, (_, index) => ({
            id: `model-${index}`,
          })),
        },
      ],
    };
    const empty = createModelPickerState({ providers: [] });
    const short = createModelPickerState({
      providers: [
        {
          alias: "deepseek",
          type: "openai-completion" as const,
          models: [{ id: "deepseek-v4-flash" }],
        },
      ],
    });
    let long = createModelPickerState(catalog);
    long = reduceModelPickerState(long, { type: "move-model", delta: 1 });

    expect(modelPickerRowCount(empty)).toBe(4);
    expect(modelPickerRowCount(short)).toBe(7);
    expect(modelPickerRowCount(long)).toBe(12);

    for (let index = 0; index < 5; index += 1) {
      long = reduceModelPickerState(long, { type: "move-model", delta: 1 });
    }
    expect(long.modelIndex).toBe(5);
    expect(modelPickerRowCount(long)).toBe(13);
  });

  it("treats Shift+Space as an ordinary space", () => {
    expect(
      resolveInputIntent(initialState(), { input: " ", shift: true }),
    ).toEqual({ type: "insert", text: " " });
  });

  it("clears draft input with Ctrl+D", () => {
    let state = initialState();
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "draft" },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "d", ctrl: true },
    });

    expect(state.input).toBe("");
    expect(state.inputCursor).toEqual({ row: 0, column: 0 });
    expect(state.notice).toBe("已清空输入");
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
        reasoningEffort: "high",
        contextWindow: 418_000,
        contextTokens: 18_400, sessionTotalTokens: 18_400, sessionInputTokens: 16_000, sessionCachedInputTokens: 0,
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
        reasoningEffort: "high",
        contextWindow: 418_000,
        contextTokens: 0, sessionTotalTokens: 0, sessionInputTokens: 0, sessionCachedInputTokens: 0,
      },
    });
    expect(state.inputHistory).toEqual(["previous session input"]);
    expect(state.inputHistoryIndex).toBe(1);
  });

  it("applies layered Ctrl+C semantics", () => {
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
    expect(state.reasoningEffort).toBe("high");
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
        reasoningEffort: "medium",
        contextWindow: 128_000,
        contextTokens: 18_400, sessionTotalTokens: 18_400, sessionInputTokens: 16_000, sessionCachedInputTokens: 0,
      },
    });

    expect(updated.model).toBe("deepseek-v4-flash");
    expect(updated.reasoningEffort).toBe("medium");
    expect(updated.contextWindow).toBe(128_000);
    expect(updated.sessionTotalTokens).toBe(18_400);
    expect(updated.sessionInputTokens).toBe(16_000);
    expect(updated.sessionCachedInputTokens).toBe(0);
  });

  it("synchronizes Session token usage from Harness events", () => {
    const updated = reduceTuiState(initialState(), {
      type: "harness-event",
      event: {
        type: "session-usage-updated",
        contextTokens: 32_000,
        sessionTotalTokens: 32_000,
        sessionInputTokens: 25_600,
        sessionCachedInputTokens: 6_400,
        contextWindow: 128_000,
      },
    });

    expect(updated.sessionTotalTokens).toBe(32_000);
    expect(updated.sessionInputTokens).toBe(25_600);
    expect(updated.sessionCachedInputTokens).toBe(6_400);
    expect(updated.contextWindow).toBe(128_000);
    expect(updated.contextTokens).toBe(32_000);
    expect(
      (updated.contextTokens / updated.contextWindow) * 100,
    ).toBe(25);
    expect(
      (updated.sessionCachedInputTokens / updated.sessionInputTokens) * 100,
    ).toBe(25);
  });

  it("resets Session usage when a new Session starts", () => {
    const previous = {
      ...initialState(),
      contextTokens: 64_000,
      sessionTotalTokens: 64_000,
      sessionInputTokens: 50_000,
      sessionCachedInputTokens: 10_000,
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
        reasoningEffort: "high",
        contextWindow: 128_000,
        contextTokens: 0, sessionTotalTokens: 0, sessionInputTokens: 0, sessionCachedInputTokens: 0,
      },
    });

    expect(next.sessionTotalTokens).toBe(0);
    expect(next.sessionInputTokens).toBe(0);
    expect(next.sessionCachedInputTokens).toBe(0);
  });

  it("reduces streaming, Tool, and retry events without Ink", () => {
    let state = initialState({ status: "running" });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "text-delta", textDelta: "He" },
    });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "text-delta", textDelta: "llo" },
    });
    expect(state.stream?.text).toBe("Hello");
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
          content: [{ type: "text", text: "line one\nline two\nline three" }],
          details: {
            resolvedPath: "/tmp/example.txt",
            realTargetPath: "/tmp/example.txt",
            cwdRelation: "inside",
            range: { startLine: 1, endLine: 3 },
            totalLines: 3,
            sizeBytes: 29,
            bom: false,
            lineEnding: "lf",
          },
        },
        isError: false,
      },
    });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "tool-batch-completed", toolCalls: [toolCall] },
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
    expect(state.tools[0]?.invocationLabel).toBe("/tmp/example.txt");
    expect(state.completedOutput).toEqual([
      {
        id: "message:live:0",
        kind: "message",
        message: { kind: "assistant", text: "Hello" },
      },
      {
        id: "tool-batch:live:1",
        kind: "tool-batch",
        tools: [state.tools[0]],
      },
    ]);
  });

  it("carries the reasoning thinking duration into the finalized reasoning message", () => {
    let now = 1_000;
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => now);
    try {
      let state = initialState({ status: "running" });
      state = reduceTuiState(state, {
        type: "harness-event",
        event: { type: "reasoning-delta", textDelta: "检查 " },
      });
      expect(state.stream).toMatchObject({
        reasoning: "检查 ",
        reasoningStartedAt: 1_000,
        reasoningEndedAt: 1_000,
      });
      now = 2_600;
      state = reduceTuiState(state, {
        type: "harness-event",
        event: { type: "reasoning-delta", textDelta: "结构" },
      });
      now = 3_000;
      state = reduceTuiState(state, {
        type: "harness-event",
        event: { type: "text-delta", textDelta: "答案" },
      });
      state = reduceTuiState(state, {
        type: "harness-event",
        event: { type: "agent-loop-completed" },
      });

      expect(state.messages).toEqual([
        { kind: "reasoning", text: "检查 结构", durationMs: 1_600 },
        { kind: "assistant", text: "答案" },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps restored session reasoning without a thinking duration", () => {
    const state = createTuiState({
      status: "idle",
      sessionId: "session-1",
      cwd: "/workspace",
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", reasoning: "思考", content: "回答" },
      ],
      pending: null,
      model: "gpt-5-codex",
      reasoningEffort: "high",
      contextWindow: 418_000,
      contextTokens: 0, sessionTotalTokens: 0, sessionInputTokens: 0, sessionCachedInputTokens: 0,
    });

    expect(state.messages).toEqual([
      { kind: "user", text: "你好" },
      { kind: "reasoning", text: "思考" },
      { kind: "assistant", text: "回答" },
    ]);
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
            content: [{ type: "text", text: "文件不存在" }],
          },
          isError: true,
        },
      },
    );

    expect(state.tools[0]).toMatchObject({
      status: "failed",
      summary: "文件不存在",
    });
    expect(formatToolCallDetail(toolCall)).toBe("/tmp/example.txt");
  });

  it("collapses partial Tool deltas before Yolo execution starts", () => {
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
    expect(state.tools[0]).toMatchObject({
      id: toolCall.id,
      status: "requested",
      summary: "等待执行",
    });

    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "tool-started", toolCall },
    });
    expect(state.tools[0]).toMatchObject({
      id: toolCall.id,
      status: "running",
      summary: "执行中 · outside cwd",
    });
  });

  it("advances a Tool from requested through running to completed under Yolo", () => {
    let state = initialState({ status: "running" });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "tool-call-delta",
        index: 0,
        id: toolCall.id,
        name: toolCall.name,
        argumentsDelta: '{"path":"/tmp/example.txt"}',
      },
    });
    expect(state.tools[0]).toMatchObject({
      status: "requested",
      summary: "等待执行",
    });
    expect(state).not.toHaveProperty("approval");

    state = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "tool-started", toolCall },
    });
    expect(state.tools[0]).toMatchObject({
      status: "running",
      summary: "执行中 · outside cwd",
    });

    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "tool-completed",
        toolCall,
        result: {
          content: [{ type: "text", text: "line one\nline two" }],
          details: {
            resolvedPath: "/tmp/example.txt",
            realTargetPath: "/tmp/example.txt",
            cwdRelation: "inside",
            range: { startLine: 1, endLine: 2 },
            totalLines: 2,
            sizeBytes: 17,
            bom: false,
            lineEnding: "lf",
          },
        },
        isError: false,
      },
    });
    expect(state.tools[0]).toMatchObject({
      status: "completed",
      summary: "已读 2 行 · 17 B",
    });
  });

  it("advances a Tool from requested through running to failed under Yolo", () => {
    let state = initialState({ status: "running" });
    state = reduceTuiState(state, {
      type: "harness-event",
      event: {
        type: "tool-call-delta",
        index: 0,
        id: toolCall.id,
        name: toolCall.name,
        argumentsDelta: '{"path":"/tmp/missing.txt"}',
      },
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
          content: [{ type: "text", text: "文件不存在" }],
        },
        isError: true,
      },
    });

    expect(state.tools[0]).toMatchObject({
      status: "failed",
      summary: "文件不存在",
    });
    expect(state.tools[0]?.status).not.toBe("denied");
  });

  it("does not treat Enter or Escape as approval shortcuts while a Tool is requested", () => {
    const state = reduceTuiState(initialState({ status: "running" }), {
      type: "harness-event",
      event: {
        type: "tool-call-delta",
        index: 0,
        id: toolCall.id,
        name: toolCall.name,
        argumentsDelta: "{}",
      },
    });

    expect(
      resolveInputIntent(state, { input: "\r", return: true }),
    ).toEqual({ type: "notice", message: "生成中 · Ctrl+C 可中断" });
    expect(resolveInputIntent(state, { input: "", escape: true }).type).toBe(
      "insert",
    );
    expect(resolveInputIntent(state, { input: "c", ctrl: true })).toEqual({
      type: "interrupt",
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
        reasoningEffort: "high",
        contextWindow: 418_000,
        contextTokens: 18_400, sessionTotalTokens: 18_400, sessionInputTokens: 16_000, sessionCachedInputTokens: 0,
      },
    });

    expect(state.retry).toBeNull();
    expect(state.failure?.httpStatus).toBe(429);
    expect(state.pending).toEqual({ reason: "provider-failure" });
  });

  it("derives the Slash Command Menu from the whole input and runtime state", () => {
    expect(resolveSlashCommandMenu({
      input: "/",
      status: "idle",
      modelPickerActive: false,
      selectedIndex: 0,
    })).toMatchObject({
      visible: true,
      query: "/",
      candidates: [
        { name: "/compact", label: "压缩上下文" },
        { name: "/exit", label: "退出" },
        { name: "/model", label: "模型" },
        { name: "/new", label: "新对话" },
      ],
      selected: { name: "/compact" },
    });
    expect(resolveSlashCommandMenu({
      input: "/m",
      status: "pending",
      modelPickerActive: false,
      selectedIndex: 0,
    })).toMatchObject({
      visible: true,
      candidates: [{ name: "/model" }],
      selected: { name: "/model" },
    });
    expect(resolveSlashCommandMenu({
      input: "/M",
      status: "idle",
      modelPickerActive: false,
      selectedIndex: 0,
    })).toMatchObject({ visible: true, candidates: [], selected: null });

    for (const input of ["", " /", "/model please", "/model\n", "／model"]) {
      expect(resolveSlashCommandMenu({
        input,
        status: "idle",
        modelPickerActive: false,
        selectedIndex: 0,
      }).visible).toBe(false);
    }
    expect(resolveSlashCommandMenu({
      input: "/m",
      status: "running",
      modelPickerActive: false,
      selectedIndex: 0,
    }).visible).toBe(false);
    expect(resolveSlashCommandMenu({
      input: "/m",
      status: "idle",
      modelPickerActive: true,
      selectedIndex: 0,
    }).visible).toBe(false);
  });

  it("resets, clamps, and applies Slash Command Menu selection", () => {
    let state = reduceTuiState(initialState(), {
      type: "input-key",
      key: { input: "/" },
    });
    expect(state.slashCommandSelectedIndex).toBe(0);
    expect(resolveInputIntent(state, { input: "", downArrow: true })).toEqual({
      type: "move-slash-command-selection",
      delta: 1,
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", downArrow: true },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", downArrow: true },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", downArrow: true },
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", downArrow: true },
    });
    expect(state.slashCommandSelectedIndex).toBe(3);
    expect(resolveInputIntent(state, { input: "\r", return: true })).toEqual({
      type: "clear",
    });

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "m" },
    });
    expect(state.slashCommandSelectedIndex).toBe(0);
    expect(resolveInputIntent(state, { input: "\r", return: true })).toEqual({
      type: "model-picker",
    });
  });

  it("lets history produce a Slash Query before the menu takes over arrows", () => {
    let state = initialState({
      messages: [{ role: "user", content: "/" }],
    });
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", upArrow: true },
    });
    expect(state.input).toBe("/");
    expect(state.slashCommandSelectedIndex).toBe(0);

    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", downArrow: true },
    });
    expect(state.input).toBe("/");
    expect(state.slashCommandSelectedIndex).toBe(1);
    expect(state.inputHistoryIndex).toBe(0);
  });

  it("clears a Slash Query and Provider Failure with the same Escape", () => {
    let state = initialState({ status: "pending", pending: { reason: "provider-failure" } });
    state = {
      ...state,
      input: "/m",
      inputCursor: { row: 0, column: 2 },
      failure: {
        code: "PROVIDER_HTTP",
        message: "failed",
        hadSemanticOutput: false,
      },
    };
    state = reduceTuiState(state, {
      type: "input-key",
      key: { input: "", escape: true },
    });
    expect(state.input).toBe("");
    expect(state.failure).toBeNull();
  });

  it("uses exact canonical Slash Commands and submits aliases or prose", () => {
    expect(resolveSubmission("/compact")).toEqual({ type: "compact" });
    expect(resolveSubmission("/compact preserve paths")).toEqual({
      type: "compact",
      customInstructions: "preserve paths",
    });
    expect(resolveSubmission("/exit")).toEqual({ type: "exit" });
    expect(resolveSubmission("/new")).toEqual({ type: "clear" });
    expect(resolveSubmission("/model")).toEqual({ type: "model-picker" });
    expect(resolveSubmission("/exit ")).toEqual({ type: "exit" });
    expect(resolveSubmission("/clear")).toEqual({
      type: "submit",
      content: "/clear",
    });
    expect(resolveSubmission("/unknown")).toEqual({
      type: "submit",
      content: "/unknown",
    });
    expect(resolveSubmission("/unknown please help")).toEqual({
      type: "submit",
      content: "/unknown please help",
    });
    expect(resolveSubmission(" hello\nworld ")).toEqual({
      type: "submit",
      content: "hello\nworld",
    });
  });

  it("submits an empty-candidate Slash Query when idle but blocks it when Pending", () => {
    const idle = {
      ...initialState(),
      input: "/z",
      inputCursor: { row: 0, column: 2 },
    };
    expect(resolveInputIntent(idle, { input: "\r", return: true })).toEqual({
      type: "submit",
      content: "/z",
    });

    const pending = {
      ...idle,
      status: "pending" as const,
      pending: { reason: "restored" as const },
    };
    expect(resolveInputIntent(pending, { input: "\r", return: true })).toEqual({
      type: "notice",
      message: "Pending Agent Loop · 清空输入后 r 重试 / n 新对话",
    });
  });

  it("executes every selected Slash Command while Pending", () => {
    for (const [query, expected] of [
      ["/", { type: "compact" }],
      ["/e", { type: "exit" }],
      ["/m", { type: "model-picker" }],
      ["/n", { type: "clear" }],
    ] as const) {
      const state = {
        ...initialState({ status: "pending", pending: { reason: "restored" } }),
        input: query,
        inputCursor: { row: 0, column: query.length },
      };
      expect(resolveInputIntent(state, { input: "\r", return: true })).toEqual(expected);
    }
  });

  it("suppresses the menu while running without changing its query", () => {
    const state = {
      ...initialState({ status: "running" }),
      input: "/m",
      inputCursor: { row: 0, column: 2 },
    };
    expect(resolveSlashCommandMenu(state).visible).toBe(false);
    expect(resolveInputIntent(state, { input: "\r", return: true })).toEqual({
      type: "notice",
      message: "生成中 · Ctrl+C 可中断",
    });
    const idle = reduceTuiState(state, {
      type: "harness-event",
      event: { type: "agent-loop-completed" },
    });
    expect(idle.input).toBe("/m");
    expect(resolveSlashCommandMenu(idle).visible).toBe(true);
  });

  it("recognizes whether a Session has any persisted interaction", () => {
    expect(isEmptySession({ messages: [] })).toBe(true);
    expect(
      isEmptySession({ messages: [{ role: "user", content: "hello" }] }),
    ).toBe(false);
  });

  it("restores completed Tool Results into TUI messages and Tool cards", () => {
    const state = initialState({
      messages: [
        { role: "user", content: "Read the missing file and AGENTS.md" },
        {
          role: "assistant",
          content: "I will read both.",
          toolCalls: [
            { id: "call-1", name: "read", arguments: { path: "missing.txt" } },
            { id: "call-2", name: "read", arguments: { path: "AGENTS.md" } },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          content: [{ type: "text", text: "File not found" }],
          isError: true,
        },
        {
          role: "tool",
          toolCallId: "call-2",
          content: [{ type: "text", text: "# Agents\n" }],
        },
        { role: "assistant", content: "AGENTS.md describes the workflow." },
      ],
    });

    expect(state.messages).toEqual([
      { kind: "user", text: "Read the missing file and AGENTS.md" },
      { kind: "assistant", text: "I will read both." },
      { kind: "assistant", text: "AGENTS.md describes the workflow." },
    ]);
    expect(state.tools).toEqual([
      {
        id: "call-1",
        name: "read",
        invocationLabel: "missing.txt",
        supplementalLines: ["File not found"],
        status: "failed",
        summary: "File not found",
      },
      {
        id: "call-2",
        name: "read",
        invocationLabel: "AGENTS.md",
        supplementalLines: ["# Agents", ""],
        status: "completed",
        summary: "已读 2 行 · 9 B",
      },
    ]);
  });
});
