import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  createHarness,
  readFileTool,
} from "../src/index.js";
import type {
  CompletionMessage,
  HarnessEvent,
  HarnessTool,
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderUsage,
  SessionStore,
  SessionUsageRecord,
  SessionTranscript,
} from "../src/index.js";

async function waitFor(
  predicate: () => boolean,
  message = "condition was not reached",
): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(message);
}

function transcript(
  messages: readonly CompletionMessage[] = [],
): SessionTranscript {
  return {
    header: {
      type: "session",
      version: 2,
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: "2026-09-03T00:00:00.000Z",
      cwd: "/workspace",
    },
    records: messages.map((message) => ({ type: "message", message })),
    messages,
    filePath: "/sessions/example.jsonl",
  };
}

function fakeSessionStore(
  appended: CompletionMessage[],
  appendedUsage: ProviderUsage[] = [],
  appendedUsageRecords: SessionUsageRecord[] = [],
): SessionStore {
  return {
    async createSession() {
      throw new Error("not used by Harness");
    },
    async appendMessage(_sessionId, message) {
      appended.push(message);
      return { ok: true, value: undefined };
    },
    async appendCompaction() {
      return { ok: true, value: undefined };
    },
    async appendUsage(_sessionId, usage, modelConfiguration) {
      appendedUsage.push(usage);
      appendedUsageRecords.push({
        type: "usage",
        usage,
        ...(modelConfiguration === undefined
          ? {}
          : {
              model: modelConfiguration.model,
              reasoningEffort: modelConfiguration.reasoningEffort,
            }),
      });
      return { ok: true, value: undefined };
    },
    async loadSession() {
      throw new Error("not used by Harness");
    },
    async listSessions() {
      throw new Error("not used by Harness");
    },
    async loadLastSession() {
      throw new Error("not used by Harness");
    },
    async loadInputHistory() {
      throw new Error("not used by Harness");
    },
  };
}

function fakeProvider(
  responses: readonly (readonly ProviderStreamEvent[])[],
  requests: ProviderRequest[],
): ProviderClient {
  let index = 0;
  return {
    type: "openai-completion",
    async complete() {
      return {
        code: "PROVIDER_PROTOCOL",
        message: "Unexpected summary request",
        hadSemanticOutput: false,
      };
    },
    async *stream(request) {
      requests.push(request);
      const events = responses[index++];
      if (events === undefined) {
        throw new Error("Unexpected Provider request");
      }
      yield* events;
    },
  };
}

describe("Harness", () => {
  it("persists one user turn and the final assistant response", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const provider = fakeProvider(
      [
        [
          { type: "text-delta", textDelta: "Hello" },
          {
            type: "response-complete",
            response: {
              assistant: { role: "assistant", content: "Hello" },
              finishReason: "stop",
            },
          },
        ],
      ],
      requests,
    );
    const harness = createHarness({
      provider,
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "deepseek-v4-flash",
      reasoningEffort: "medium",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [],
    });

    const result = await harness.dispatch({
      type: "submit",
      content: "Hi",
    });

    expect(result).toEqual({ ok: true });
    expect(requests).toEqual([
      {
        model: "deepseek-v4-flash",
        reasoningEffort: "medium",
        messages: [
          { role: "system", content: buildSystemPrompt("/workspace") },
          { role: "user", content: "Hi" },
        ],
      },
    ]);
    expect(appended).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
    expect(harness.getSnapshot()).toMatchObject({
      status: "idle",
      messages: appended,
      pending: null,
    });
  });

  it("configures the model atomically and uses it on the next request", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const harness = createHarness({
      provider: fakeProvider([], requests),
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "old-model",
      reasoningEffort: "high",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      approvalPolicy: "ask",
      tools: [],
    });
    const replacement = fakeProvider(
      [
        [
          {
            type: "response-complete",
            response: {
              assistant: { role: "assistant", content: "Switched" },
              finishReason: "stop",
            },
          },
        ],
      ],
      requests,
    );

    const configured = await harness.dispatch({
      type: "configure-model",
      provider: replacement,
      model: "new-model",
      reasoningEffort: "low",
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
    });
    expect(configured).toEqual({ ok: true });
    expect(harness.getSnapshot()).toMatchObject({
      model: "new-model",
      reasoningEffort: "low",
      contextWindow: 64_000,
    });

    expect(await harness.dispatch({ type: "submit", content: "Hi" })).toEqual({
      ok: true,
    });
    expect(requests).toEqual([
      {
        model: "new-model",
        reasoningEffort: "low",
        messages: [
          { role: "system", content: buildSystemPrompt("/workspace") },
          { role: "user", content: "Hi" },
        ],
      },
    ]);
  });

  it("keeps a Pending Agent Loop when configuring a model", async () => {
    const harness = createHarness({
      provider: fakeProvider([], []),
      sessionStore: fakeSessionStore([]),
      session: transcript([
        {
          role: "assistant",
          toolCalls: [
            { id: "call-1", name: "read_file", arguments: { path: "/tmp" } },
          ],
        },
      ]),
      model: "old-model",
      reasoningEffort: "high",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      approvalPolicy: "ask",
      tools: [],
    });

    const result = await harness.dispatch({
      type: "configure-model",
      provider: fakeProvider([], []),
      model: "new-model",
      reasoningEffort: "low",
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
    });

    expect(result).toEqual({ ok: true });
    expect(harness.getSnapshot()).toMatchObject({
      status: "pending",
      pending: { reason: "restored" },
      model: "new-model",
    });
  });

  it("fails closed before requests when the Active Model Configuration is incomplete", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const harness = createHarness({
      provider: fakeProvider([], requests),
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      approvalPolicy: "ask",
      tools: [],
    });

    const submitted = await harness.dispatch({
      type: "submit",
      content: "Hi",
    });
    expect(submitted).toEqual({
      ok: false,
      error: {
        code: "HARNESS_MODEL_CONFIG_INCOMPLETE",
        message: "Active Model Configuration is incomplete.",
      },
    });
    expect(requests).toEqual([]);
    expect(appended).toEqual([]);
    expect(harness.getSnapshot().status).toBe("idle");
  });

  it("accumulates completed Provider request totals for the Session", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const appendedUsage: ProviderUsage[] = [];
    const appendedUsageRecords: SessionUsageRecord[] = [];
    const harness = createHarness({
      provider: fakeProvider(
        [
          [
            {
              type: "response-complete",
              response: {
                assistant: { role: "assistant", content: "Hello" },
                finishReason: "stop",
                usage: {
                  inputTokens: 120,
                  outputTokens: 5,
                  totalTokens: 125,
                },
              },
            },
          ],
          [
            {
              type: "response-complete",
              response: {
                assistant: { role: "assistant", content: "Again" },
                finishReason: "stop",
                usage: {
                  inputTokens: 180,
                  outputTokens: 30,
                  totalTokens: 210,
                },
              },
            },
          ],
        ],
        requests,
      ),
      sessionStore: fakeSessionStore(appended, appendedUsage, appendedUsageRecords),
      session: transcript(),
      model: "model",
      reasoningEffort: "medium",
      contextWindow: 100_000,
      maxOutputTokens: 100,
      approvalPolicy: "ask",
      tools: [],
    });
    const usageEvents: Extract<
      HarnessEvent,
      { type: "session-usage-updated" }
    >[] = [];
    harness.subscribe((event) => {
      if (event.type === "session-usage-updated") {
        usageEvents.push(event);
      }
    });

    expect(await harness.dispatch({ type: "submit", content: "Hi" })).toEqual({
      ok: true,
    });
    expect(await harness.dispatch({ type: "submit", content: "Again" })).toEqual({
      ok: true,
    });

    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toEqual({
      type: "session-usage-updated",
      sessionTotalTokens: 125,
      contextWindow: 100_000,
    });
    expect(usageEvents[1]).toEqual({
      type: "session-usage-updated",
      sessionTotalTokens: 335,
      contextWindow: 100_000,
    });
    expect(appendedUsage).toEqual([
      { inputTokens: 120, outputTokens: 5, totalTokens: 125 },
      { inputTokens: 180, outputTokens: 30, totalTokens: 210 },
    ]);
    expect(appendedUsageRecords).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 120, outputTokens: 5, totalTokens: 125 },
        model: "model",
        reasoningEffort: "medium",
      },
      {
        type: "usage",
        usage: { inputTokens: 180, outputTokens: 30, totalTokens: 210 },
        model: "model",
        reasoningEffort: "medium",
      },
    ]);
    expect(harness.getSnapshot().sessionTotalTokens).toBe(335);
  });

  it("restores the cumulative Provider usage from the Session Transcript", () => {
    const session = transcript();
    const restored = createHarness({
      provider: fakeProvider([], []),
      sessionStore: fakeSessionStore([]),
      session: {
        ...session,
        records: [
          {
            type: "usage",
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          },
          {
            type: "usage",
            usage: { inputTokens: 180, outputTokens: 30, totalTokens: 210 },
          },
        ],
      },
      model: "model",
      reasoningEffort: "high",
      contextWindow: 100_000,
      maxOutputTokens: 100,
      approvalPolicy: "ask",
      tools: [],
    });

    expect(restored.getSnapshot().sessionTotalTokens).toBe(330);
  });

  it("approves and executes every Tool Call serially before continuing the Agent Loop", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const executionOrder: string[] = [];
    const provider = fakeProvider(
      [
        [
          {
            type: "response-complete",
            response: {
              assistant: {
                role: "assistant",
                toolCalls: [
                  { id: "call-1", name: "first", arguments: { value: 1 } },
                  { id: "call-2", name: "second", arguments: { value: 2 } },
                ],
              },
              finishReason: "tool_calls",
            },
          },
        ],
        [
          {
            type: "response-complete",
            response: {
              assistant: { role: "assistant", content: "Done" },
              finishReason: "stop",
            },
          },
        ],
      ],
      requests,
    );
    const tool = (name: string): HarnessTool => ({
      name,
      description: name,
      parameters: { type: "object" },
      async execute(input) {
        executionOrder.push(name);
        return { ok: true, result: { input } };
      },
    });
    const events: HarnessEvent[] = [];
    const harness = createHarness({
      provider,
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [tool("first"), tool("second")],
      createId: (() => {
        let next = 0;
        return () => `approval-${++next}`;
      })(),
    });
    harness.subscribe((event) => events.push(event));

    const running = harness.dispatch({ type: "submit", content: "Run both" });
    await waitFor(
      () => events.some((event) => event.type === "approval-requested"),
    );
    expect(executionOrder).toEqual([]);
    expect(harness.getSnapshot().status).toBe("awaiting-approval");
    expect(
      events.filter((event) => event.type === "approval-requested"),
    ).toEqual([
      expect.objectContaining({
        type: "approval-requested",
        approvalId: "approval-1",
        toolCall: expect.objectContaining({ id: "call-1", name: "first" }),
      }),
    ]);

    expect(
      await harness.dispatch({
        type: "resolve-approval",
        approvalId: "approval-1",
        approved: true,
      }),
    ).toEqual({ ok: true });
    await waitFor(
      () =>
        events.filter((event) => event.type === "approval-requested")
          .length === 2,
    );
    expect(executionOrder).toEqual(["first"]);

    await harness.dispatch({
      type: "resolve-approval",
      approvalId: "approval-2",
      approved: true,
    });
    expect(await running).toEqual({ ok: true });

    expect(executionOrder).toEqual(["first", "second"]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.slice(-3)).toEqual([
      {
        role: "assistant",
        toolCalls: [
          { id: "call-1", name: "first", arguments: { value: 1 } },
          { id: "call-2", name: "second", arguments: { value: 2 } },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: { ok: true, result: { input: { value: 1 } } },
      },
      {
        role: "tool",
        toolCallId: "call-2",
        content: { ok: true, result: { input: { value: 2 } } },
      },
    ]);
  });

  it("maps rejection, typed errors, exceptions, and timeouts to failed Tool Results", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const provider = fakeProvider(
      [
        [
          {
            type: "response-complete",
            response: {
              assistant: {
                role: "assistant",
                toolCalls: [
                  { id: "denied", name: "ok", arguments: {} },
                  { id: "typed", name: "typed", arguments: {} },
                  { id: "throws", name: "throws", arguments: {} },
                  { id: "timeout", name: "timeout", arguments: {} },
                ],
              },
              finishReason: "tool_calls",
            },
          },
        ],
        [
          {
            type: "response-complete",
            response: {
              assistant: { role: "assistant", content: "Handled" },
              finishReason: "stop",
            },
          },
        ],
      ],
      requests,
    );
    const tools: HarnessTool[] = [
      {
        name: "ok",
        description: "ok",
        parameters: {},
        async execute() {
          return { ok: true, result: {} };
        },
      },
      {
        name: "typed",
        description: "typed",
        parameters: {},
        async execute() {
          return {
            ok: false,
            error: {
              code: "ENOENT",
              message: "Missing",
              details: { path: "/x" },
            },
          };
        },
      },
      {
        name: "throws",
        description: "throws",
        parameters: {},
        async execute() {
          throw new Error("secret stack");
        },
      },
      {
        name: "timeout",
        description: "timeout",
        parameters: {},
        execute(_input, signal) {
          return new Promise((resolve) => {
            signal?.addEventListener("abort", () =>
              resolve({ ok: true, result: "too late" }),
            );
          });
        },
      },
    ];
    const events: HarnessEvent[] = [];
    let approvalNumber = 0;
    const harness = createHarness({
      provider,
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools,
      createId: () => `approval-${++approvalNumber}`,
      clock: {
        async sleep(milliseconds) {
          expect(milliseconds).toBe(10_000);
        },
      },
    });
    harness.subscribe((event) => events.push(event));

    const running = harness.dispatch({ type: "submit", content: "Run" });
    for (let index = 1; index <= 4; index += 1) {
      await waitFor(
        () =>
          events.filter((event) => event.type === "approval-requested")
            .length === index,
      );
      await harness.dispatch({
        type: "resolve-approval",
        approvalId: `approval-${index}`,
        approved: index !== 1,
      });
    }
    expect(await running).toEqual({ ok: true });

    expect(
      appended
        .filter((message) => message.role === "tool")
        .map((message) => message.content),
    ).toEqual([
      {
        ok: false,
        error: {
          code: "EAPPROVAL_DENIED",
          message: "Tool execution was denied.",
        },
      },
      {
        ok: false,
        error: {
          code: "ENOENT",
          message: "Missing",
          details: { path: "/x" },
        },
      },
      {
        ok: false,
        error: { code: "ETOOL", message: "Tool execution failed." },
      },
      {
        ok: false,
        error: { code: "ETIMEDOUT", message: "Tool execution timed out." },
      },
    ]);
  });

  it("rejects an oversized Tool Batch without approval or partial execution", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    let executions = 0;
    const toolCalls = Array.from({ length: 9 }, (_, index) => ({
      id: `call-${index + 1}`,
      name: "read_file",
      arguments: { path: `/file-${index + 1}` },
    }));
    const provider = fakeProvider(
      [
        [
          {
            type: "response-complete",
            response: {
              assistant: { role: "assistant", toolCalls },
              finishReason: "tool_calls",
            },
          },
        ],
        [
          {
            type: "response-complete",
            response: {
              assistant: { role: "assistant", content: "Too many tools" },
              finishReason: "stop",
            },
          },
        ],
      ],
      requests,
    );
    const events: HarnessEvent[] = [];
    const harness = createHarness({
      provider,
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [
        {
          name: "read_file",
          description: "read",
          parameters: {},
          async execute() {
            executions += 1;
            return { ok: true, result: {} };
          },
        },
      ],
    });
    harness.subscribe((event) => events.push(event));

    expect(
      await harness.dispatch({ type: "submit", content: "Read everything" }),
    ).toEqual({ ok: true });

    expect(executions).toBe(0);
    expect(
      events.some((event) => event.type === "approval-requested"),
    ).toBe(false);
    const results = appended.filter((message) => message.role === "tool");
    expect(results).toHaveLength(9);
    expect(results.map((message) => message.content)).toEqual(
      Array.from({ length: 9 }, () => ({
        ok: false,
        error: {
          code: "ETOOL_BATCH_LIMIT",
          message: "Tool Batch exceeds the limit of 8 Tool Calls.",
        },
      })),
    );
  });

  it("stops after 20 Tool Rounds with one Tool-free final request", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const responses: ProviderStreamEvent[][] = Array.from(
      { length: 20 },
      (_, index) => [
        {
          type: "response-complete",
          response: {
            assistant: {
              role: "assistant",
              toolCalls: [
                {
                  id: `call-${index + 1}`,
                  name: "read_file",
                  arguments: { path: `/file-${index + 1}` },
                },
              ],
            },
            finishReason: "tool_calls",
          },
        },
      ],
    );
    responses.push([
      {
        type: "response-complete",
        response: {
          assistant: { role: "assistant", content: "Stopped safely" },
          finishReason: "stop",
        },
      },
    ]);
    const events: HarnessEvent[] = [];
    const harness = createHarness({
      provider: fakeProvider(responses, requests),
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "yolo",
      tools: [
        {
          name: "read_file",
          description: "read",
          parameters: {},
          async execute() {
            return { ok: true, result: { content: "x" } };
          },
        },
      ],
    });
    harness.subscribe((event) => events.push(event));

    expect(
      await harness.dispatch({ type: "submit", content: "Keep reading" }),
    ).toEqual({ ok: true });

    expect(requests).toHaveLength(21);
    expect(requests.slice(0, 20).every((request) => request.tools?.length === 1)).toBe(true);
    expect(requests[20]?.tools).toBeUndefined();
    expect(
      events.filter((event) => event.type === "tool-round-limit-reached"),
    ).toHaveLength(1);
    expect(
      events.some((event) => event.type === "approval-requested"),
    ).toBe(false);
    expect(appended.at(-1)).toEqual({
      role: "assistant",
      content: "Stopped safely",
    });
  });

  it("retries transient Provider failures twice before completing", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const delays: number[] = [];
    const events: HarnessEvent[] = [];
    const provider = fakeProvider(
      [
        [
          {
            type: "response-error",
            failure: {
              code: "PROVIDER_NETWORK",
              message: "Network failed.",
              hadSemanticOutput: false,
            },
          },
        ],
        [
          {
            type: "response-error",
            failure: {
              code: "PROVIDER_HTTP",
              message: "Rate limited.",
              httpStatus: 429,
              retryAfterMs: 45_000,
              hadSemanticOutput: false,
            },
          },
        ],
        [
          {
            type: "response-complete",
            response: {
              assistant: { role: "assistant", content: "Recovered" },
              finishReason: "stop",
            },
          },
        ],
      ],
      requests,
    );
    const harness = createHarness({
      provider,
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [],
      random: () => 0.5,
      clock: {
        async sleep(milliseconds) {
          delays.push(milliseconds);
        },
      },
    });
    harness.subscribe((event) => events.push(event));

    expect(
      await harness.dispatch({ type: "submit", content: "Try" }),
    ).toEqual({ ok: true });

    expect(requests).toHaveLength(3);
    expect(delays).toEqual([1_000, 30_000]);
    expect(events.filter((event) => event.type === "provider-retrying")).toEqual([
      expect.objectContaining({ type: "provider-retrying", retry: 1, delayMs: 1_000 }),
      expect.objectContaining({ type: "provider-retrying", retry: 2, delayMs: 30_000 }),
    ]);
    expect(appended).toEqual([
      { role: "user", content: "Try" },
      { role: "assistant", content: "Recovered" },
    ]);
  });

  it("keeps an Interrupted Response out of the transcript until explicit retry", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const delays: number[] = [];
    const events: HarnessEvent[] = [];
    const provider = fakeProvider(
      [
        [
          { type: "text-delta", textDelta: "Half" },
          {
            type: "response-error",
            failure: {
              code: "PROVIDER_NETWORK",
              message: "Connection lost.",
              hadSemanticOutput: false,
              cause: new Error("secret upstream body"),
            },
          },
        ],
        [
          {
            type: "response-complete",
            response: {
              assistant: { role: "assistant", content: "Complete" },
              finishReason: "stop",
            },
          },
        ],
      ],
      requests,
    );
    const harness = createHarness({
      provider,
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [],
      clock: {
        async sleep(milliseconds) {
          delays.push(milliseconds);
        },
      },
    });
    harness.subscribe((event) => events.push(event));

    const interrupted = await harness.dispatch({
      type: "submit",
      content: "Answer",
    });

    expect(interrupted).toMatchObject({
      ok: false,
      error: {
        code: "HARNESS_PROVIDER",
        providerFailure: {
          code: "PROVIDER_NETWORK",
          hadSemanticOutput: true,
        },
      },
    });
    expect(delays).toEqual([]);
    expect(appended).toEqual([{ role: "user", content: "Answer" }]);
    expect(harness.getSnapshot()).toMatchObject({
      status: "pending",
      pending: { reason: "interrupted" },
    });
    expect(events).toContainEqual({
      type: "interrupted-response",
      response: { content: "Half" },
      failure: {
        code: "PROVIDER_NETWORK",
        message: "Connection lost.",
        hadSemanticOutput: true,
      },
    });

    expect(await harness.dispatch({ type: "retry" })).toEqual({ ok: true });
    expect(requests).toHaveLength(2);
    expect(appended).toEqual([
      { role: "user", content: "Answer" },
      { role: "assistant", content: "Complete" },
    ]);
  });

  it("restores a Pending Agent Loop without contacting the Provider", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const harness = createHarness({
      provider: fakeProvider(
        [
          [
            {
              type: "response-complete",
              response: {
                assistant: { role: "assistant", content: "Resumed" },
                finishReason: "stop",
              },
            },
          ],
        ],
        requests,
      ),
      sessionStore: fakeSessionStore(appended),
      session: transcript([{ role: "user", content: "Persisted" }]),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [],
    });

    expect(requests).toEqual([]);
    expect(harness.getSnapshot()).toMatchObject({
      status: "pending",
      pending: { reason: "restored" },
    });

    expect(await harness.dispatch({ type: "retry" })).toEqual({ ok: true });
    expect(requests).toHaveLength(1);
    expect(appended).toEqual([
      { role: "assistant", content: "Resumed" },
    ]);
  });

  it("interrupts active streaming and preserves only the last stable boundary", async () => {
    const appended: CompletionMessage[] = [];
    let providerStarted = false;
    const provider: ProviderClient = {
      type: "openai-completion",
      async complete() {
        return {
          code: "PROVIDER_PROTOCOL",
          message: "Unexpected summary request",
          hadSemanticOutput: false,
        };
      },
      async *stream(_request, signal) {
        providerStarted = true;
        yield { type: "text-delta", textDelta: "Partial" };
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield {
          type: "response-error",
          failure: {
            code: "PROVIDER_ABORT",
            message: "Provider request was aborted.",
            hadSemanticOutput: true,
          },
        };
      },
    };
    const harness = createHarness({
      provider,
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [],
    });

    const running = harness.dispatch({ type: "submit", content: "Long answer" });
    await waitFor(() => providerStarted);
    expect(
      await harness.dispatch({
        type: "configure-model",
        provider: fakeProvider([], []),
        model: "replacement",
        reasoningEffort: "low",
        contextWindow: 64_000,
        maxOutputTokens: 8_192,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "HARNESS_BUSY" },
    });
    expect(harness.getSnapshot().model).toBe("model");
    expect(await harness.dispatch({ type: "interrupt" })).toEqual({ ok: true });
    expect(await running).toMatchObject({
      ok: false,
      error: { providerFailure: { code: "PROVIDER_ABORT" } },
    });
    expect(appended).toEqual([{ role: "user", content: "Long answer" }]);
    expect(harness.getSnapshot()).toMatchObject({
      status: "pending",
      pending: { reason: "interrupted" },
    });
  });

  it("does not retry non-transient Provider failures or expose their cause", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const delays: number[] = [];
    const events: HarnessEvent[] = [];
    const harness = createHarness({
      provider: fakeProvider(
        [
          [
            {
              type: "response-error",
              failure: {
                code: "PROVIDER_HTTP",
                message: "Provider returned HTTP 401.",
                httpStatus: 401,
                requestId: "request-1",
                hadSemanticOutput: false,
                cause: new Error("authorization: Bearer secret"),
              },
            },
          ],
        ],
        requests,
      ),
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [],
      clock: {
        async sleep(milliseconds) {
          delays.push(milliseconds);
        },
      },
    });
    harness.subscribe((event) => events.push(event));

    expect(
      await harness.dispatch({ type: "submit", content: "Fail" }),
    ).toMatchObject({
      ok: false,
      error: {
        providerFailure: {
          code: "PROVIDER_HTTP",
          httpStatus: 401,
          requestId: "request-1",
        },
      },
    });
    expect(requests).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: "provider-failed",
      failure: {
        code: "PROVIDER_HTTP",
        message: "Provider returned HTTP 401.",
        httpStatus: 401,
        requestId: "request-1",
        hadSemanticOutput: false,
      },
    });
  });

  it("runs the Read File Tool through the Harness boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "susan-harness-"));
    try {
      const path = join(root, "note.txt");
      await writeFile(path, "confirmed content\n", "utf8");
      const requests: ProviderRequest[] = [];
      const appended: CompletionMessage[] = [];
      const harness = createHarness({
        provider: fakeProvider(
          [
            [
              {
                type: "response-complete",
                response: {
                  assistant: {
                    role: "assistant",
                    toolCalls: [
                      {
                        id: "read-1",
                        name: "read_file",
                        arguments: { path },
                      },
                    ],
                  },
                  finishReason: "tool_calls",
                },
              },
            ],
            [
              {
                type: "response-complete",
                response: {
                  assistant: { role: "assistant", content: "Read it" },
                  finishReason: "stop",
                },
              },
            ],
          ],
          requests,
        ),
        sessionStore: fakeSessionStore(appended),
        session: transcript(),
        model: "model",
        reasoningEffort: "high",
        contextWindow: 1_000_000,
        maxOutputTokens: 1_000,
        approvalPolicy: "yolo",
        tools: [readFileTool],
      });

      expect(
        await harness.dispatch({ type: "submit", content: "Read note.txt" }),
      ).toEqual({ ok: true });
      expect(appended.find((message) => message.role === "tool")).toMatchObject({
        content: {
          ok: true,
          result: { path, content: "confirmed content\n" },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed before contacting the Provider when persistence fails", async () => {
    const requests: ProviderRequest[] = [];
    const events: HarnessEvent[] = [];
    const store = fakeSessionStore([]);
    store.appendMessage = async () => ({
      ok: false,
      error: {
        code: "SUSAN_SESSION_IO",
        message: "Session cannot be written.",
      },
    });
    const harness = createHarness({
      provider: fakeProvider([], requests),
      sessionStore: store,
      session: transcript(),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [],
    });
    harness.subscribe((event) => events.push(event));

    expect(
      await harness.dispatch({ type: "submit", content: "Do not lose me" }),
    ).toEqual({
      ok: false,
      error: {
        code: "HARNESS_SESSION",
        message: "Session cannot be written.",
      },
    });
    expect(requests).toEqual([]);
    expect(harness.getSnapshot()).toMatchObject({
      status: "failed",
      pending: null,
      messages: [],
    });
    expect(events).toContainEqual({
      type: "harness-failed",
      error: {
        code: "HARNESS_SESSION",
        message: "Session cannot be written.",
      },
    });
  });

  it("restores the Tool Round budget and rejects Tool Calls in the final request", async () => {
    const persisted: CompletionMessage[] = [
      { role: "user", content: "Loop" },
    ];
    for (let index = 0; index < 20; index += 1) {
      const id = `call-${index + 1}`;
      persisted.push(
        {
          role: "assistant",
          toolCalls: [{ id, name: "read_file", arguments: { path: "/x" } }],
        },
        {
          role: "tool",
          toolCallId: id,
          content: { ok: true, result: { content: "x" } },
        },
      );
    }
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const harness = createHarness({
      provider: fakeProvider(
        [
          [
            {
              type: "response-complete",
              response: {
                assistant: {
                  role: "assistant",
                  toolCalls: [
                    { id: "illegal", name: "read_file", arguments: {} },
                  ],
                },
                finishReason: "tool_calls",
              },
            },
          ],
        ],
        requests,
      ),
      sessionStore: fakeSessionStore(appended),
      session: transcript(persisted),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "yolo",
      tools: [readFileTool],
    });

    expect(await harness.dispatch({ type: "retry" })).toMatchObject({
      ok: false,
      error: {
        code: "HARNESS_PROVIDER",
        providerFailure: { code: "PROVIDER_PROTOCOL" },
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toBeUndefined();
    expect(appended).toEqual([]);
  });

  it("resumes only unfinished Tool Calls from a persisted Tool Batch", async () => {
    const persisted: CompletionMessage[] = [
      { role: "user", content: "Read both" },
      {
        role: "assistant",
        toolCalls: [
          { id: "done", name: "read", arguments: { path: "/done" } },
          { id: "pending", name: "read", arguments: { path: "/pending" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "done",
        content: { ok: true, result: { content: "already read" } },
      },
    ];
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const executed: string[] = [];
    const approvals: HarnessEvent[] = [];
    const harness = createHarness({
      provider: fakeProvider(
        [
          [
            {
              type: "response-complete",
              response: {
                assistant: { role: "assistant", content: "Both complete" },
                finishReason: "stop",
              },
            },
          ],
        ],
        requests,
      ),
      sessionStore: fakeSessionStore(appended),
      session: transcript(persisted),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [
        {
          name: "read",
          description: "read",
          parameters: {},
          async execute(input) {
            const path = (input as { path: string }).path;
            executed.push(path);
            return { ok: true, result: { content: path } };
          },
        },
      ],
      createId: () => "resume-approval",
    });
    harness.subscribe((event) => approvals.push(event));

    const running = harness.dispatch({ type: "retry" });
    await waitFor(() =>
      approvals.some((event) => event.type === "approval-requested"),
    );
    await harness.dispatch({
      type: "resolve-approval",
      approvalId: "resume-approval",
      approved: true,
    });

    expect(await running).toEqual({ ok: true });
    expect(executed).toEqual(["/pending"]);
    expect(appended).toEqual([
      {
        role: "tool",
        toolCallId: "pending",
        content: { ok: true, result: { content: "/pending" } },
      },
      { role: "assistant", content: "Both complete" },
    ]);
    expect(requests[0]?.messages.slice(-3)).toEqual([
      persisted[1],
      persisted[2],
      appended[0],
    ]);
  });

  it("interrupts an active Tool without persisting a fabricated Tool Result", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const events: HarnessEvent[] = [];
    let toolAborted = false;
    const harness = createHarness({
      provider: fakeProvider(
        [
          [
            {
              type: "response-complete",
              response: {
                assistant: {
                  role: "assistant",
                  toolCalls: [
                    { id: "slow", name: "slow", arguments: {} },
                  ],
                },
                finishReason: "tool_calls",
              },
            },
          ],
        ],
        requests,
      ),
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "yolo",
      tools: [
        {
          name: "slow",
          description: "slow",
          parameters: {},
          execute(_input, signal) {
            return new Promise((resolve) => {
              signal?.addEventListener(
                "abort",
                () => {
                  toolAborted = true;
                  resolve({ ok: true, result: "late" });
                },
                { once: true },
              );
            });
          },
        },
      ],
    });
    harness.subscribe((event) => events.push(event));

    const running = harness.dispatch({ type: "submit", content: "Run slowly" });
    await waitFor(() => events.some((event) => event.type === "tool-started"));
    expect(await harness.dispatch({ type: "interrupt" })).toEqual({ ok: true });

    expect(await running).toEqual({
      ok: false,
      error: {
        code: "HARNESS_ABORTED",
        message: "Agent Loop was interrupted.",
      },
    });
    expect(toolAborted).toBe(true);
    expect(requests).toHaveLength(1);
    expect(appended).toEqual([
      { role: "user", content: "Run slowly" },
      {
        role: "assistant",
        toolCalls: [{ id: "slow", name: "slow", arguments: {} }],
      },
    ]);
    expect(harness.getSnapshot()).toMatchObject({
      status: "pending",
      pending: { reason: "user-interrupt" },
    });
  });
});
