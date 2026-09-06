import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  buildSystemPrompt,
  createHarness,
  createReadTool,
  createSessionStore,
  createWriteTool,
} from "../src/index.js";
import type {
  CompletionMessage,
  HarnessCommand,
  HarnessError,
  HarnessEvent,
  HarnessOptions,
  HarnessStatus,
  HarnessTool,
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderUsage,
  SessionStore,
  SessionUsageRecord,
  SessionTranscript,
} from "../src/index.js";

const SESSION_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "session",
);

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

async function transcriptFromFixture(
  name: string,
): Promise<SessionTranscript> {
  const root = await mkdtemp(join(tmpdir(), "susan-harness-session-"));
  const sessionsDirectory = join(root, "sessions");
  await mkdir(sessionsDirectory, { mode: 0o700 });
  const raw = await readFile(join(SESSION_FIXTURES_DIR, name), "utf8");
  const header = JSON.parse(raw.split("\n")[0]!) as { id: string };
  await writeFile(
    join(sessionsDirectory, `20260101T000000Z-${header.id}.jsonl`),
    raw,
    { mode: 0o600 },
  );
  const loaded = await createSessionStore({ sessionsDirectory }).loadSession(
    header.id,
  );
  await rm(root, { force: true, recursive: true });
  if (!loaded.ok) {
    throw new Error(loaded.error.message);
  }
  return loaded.value;
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
  it("does not expose approval concepts in its public contracts", () => {
    expectTypeOf<
      Extract<HarnessStatus, "awaiting-approval">
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<HarnessCommand, { type: "resolve-approval" }>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<HarnessEvent, { type: "approval-requested" }>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<HarnessError["code"], "HARNESS_APPROVAL">
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof HarnessOptions, "approvalPolicy" | "createId">
    >().toEqualTypeOf<never>();
  });

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
            { id: "call-1", name: "read", arguments: { path: "/tmp" } },
          ],
        },
      ]),
      model: "old-model",
      reasoningEffort: "high",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
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
      tools: [],
    });

    expect(restored.getSnapshot().sessionTotalTokens).toBe(330);
  });

  it("executes every Yolo Tool Call serially before continuing the Agent Loop", async () => {
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
      tools: [tool("first"), tool("second")],
    });
    harness.subscribe((event) => events.push(event));

    expect(
      await harness.dispatch({ type: "submit", content: "Run both" }),
    ).toEqual({ ok: true });

    expect(executionOrder).toEqual(["first", "second"]);
    expect(events.map((event) => event.type)).toContain("tool-started");
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

  it("maps typed errors, exceptions, and timeouts to failed Tool Results", async () => {
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
    const harness = createHarness({
      provider,
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      tools,
      clock: {
        async sleep(milliseconds) {
          expect(milliseconds).toBe(10_000);
        },
      },
    });
    expect(await harness.dispatch({ type: "submit", content: "Run" })).toEqual({
      ok: true,
    });

    expect(
      appended
        .filter((message) => message.role === "tool")
        .map((message) => message.content),
    ).toEqual([
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

  it("rejects an oversized Tool Batch without partial execution", async () => {
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
    const harness = createHarness({
      provider,
      sessionStore: fakeSessionStore(appended),
      session: transcript(),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
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
    expect(
      await harness.dispatch({ type: "submit", content: "Read everything" }),
    ).toEqual({ ok: true });

    expect(executions).toBe(0);
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

  it("enters compatibility stop for a pending legacy read_file Tool Call", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    let executions = 0;
    const harness = createHarness({
      provider: fakeProvider(
        [
          [
            {
              type: "response-complete",
              response: {
                assistant: { role: "assistant", content: "should not run" },
                finishReason: "stop",
              },
            },
          ],
        ],
        requests,
      ),
      sessionStore: fakeSessionStore(appended),
      session: await transcriptFromFixture("pending-legacy-read-file.jsonl"),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      tools: [
        {
          name: "read",
          description: "read",
          parameters: {},
          async execute() {
            executions += 1;
            return { ok: true, result: { content: "x" } };
          },
        },
      ],
    });

    expect(requests).toEqual([]);
    expect(harness.getSnapshot()).toMatchObject({
      status: "compatibility",
      pending: { reason: "compatibility" },
    });
    expect(await harness.dispatch({ type: "retry" })).toMatchObject({
      ok: false,
      error: {
        code: "HARNESS_INVALID_COMMAND",
        message: "Legacy Tool Call cannot be replayed.",
      },
    });
    expect(requests).toEqual([]);
    expect(executions).toBe(0);
    expect(appended).toEqual([]);
  });

  it("applies the same compatibility stop to an old awaiting-approval exit", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    let executions = 0;
    const harness = createHarness({
      provider: fakeProvider([], requests),
      sessionStore: fakeSessionStore(appended),
      session: await transcriptFromFixture("awaiting-approval-exit.jsonl"),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      tools: [
        {
          name: "read",
          description: "read",
          parameters: {},
          async execute() {
            executions += 1;
            return { ok: true, result: { content: "secret" } };
          },
        },
      ],
    });

    expect(harness.getSnapshot()).toMatchObject({
      status: "compatibility",
      pending: { reason: "compatibility" },
    });
    expect(await harness.dispatch({ type: "retry" })).toMatchObject({
      ok: false,
      error: { message: "Legacy Tool Call cannot be replayed." },
    });
    expect(requests).toEqual([]);
    expect(executions).toBe(0);
    expect(appended).toEqual([]);
  });

  it("keeps a restored new read Pending Agent Loop retryable without contacting the Provider", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    let executions = 0;
    const harness = createHarness({
      provider: fakeProvider(
        [
          [
            {
              type: "response-complete",
              response: {
                assistant: { role: "assistant", content: "Done reading." },
                finishReason: "stop",
              },
            },
          ],
        ],
        requests,
      ),
      sessionStore: fakeSessionStore(appended),
      session: await transcriptFromFixture("pending-read.jsonl"),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      tools: [
        {
          name: "read",
          description: "read",
          parameters: {},
          async execute() {
            executions += 1;
            return { ok: true, result: { content: "# Agents\n" } };
          },
        },
      ],
    });

    expect(requests).toEqual([]);
    expect(harness.getSnapshot()).toMatchObject({
      status: "pending",
      pending: { reason: "restored" },
    });
    expect(await harness.dispatch({ type: "retry" })).toEqual({ ok: true });
    expect(executions).toBe(1);
    expect(requests).toHaveLength(1);
    expect(appended.filter((message) => message.role === "tool")).toEqual([
      {
        role: "tool",
        toolCallId: "call-1",
        content: { ok: true, result: { content: "# Agents\n" } },
      },
    ]);
  });

  it("lets a compatibility stop accept a new instruction without replaying the legacy Tool Call", async () => {
    const requests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    let executions = 0;
    const harness = createHarness({
      provider: fakeProvider(
        [
          [
            {
              type: "response-complete",
              response: {
                assistant: { role: "assistant", content: "Understood." },
                finishReason: "stop",
              },
            },
          ],
        ],
        requests,
      ),
      sessionStore: fakeSessionStore(appended),
      session: await transcriptFromFixture("pending-legacy-read-file.jsonl"),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      tools: [
        {
          name: "read",
          description: "read",
          parameters: {},
          async execute() {
            executions += 1;
            return { ok: true, result: { content: "x" } };
          },
        },
      ],
    });

    expect(await harness.dispatch({ type: "submit", content: "Continue without that file." })).toEqual({
      ok: true,
    });
    expect(executions).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toEqual(
      expect.arrayContaining([
        { role: "user", content: "Read AGENTS.md" },
        expect.objectContaining({
          role: "assistant",
          toolCalls: [
            { id: "call-1", name: "read_file", arguments: { path: "AGENTS.md" } },
          ],
        }),
        { role: "user", content: "Continue without that file." },
      ]),
    );
    expect(appended).toEqual([
      { role: "user", content: "Continue without that file." },
      { role: "assistant", content: "Understood." },
    ]);
  });

  it("restores completed legacy read_file records into the next Model Context", async () => {
    const requests: ProviderRequest[] = [];
    const harness = createHarness({
      provider: fakeProvider(
        [
          [
            {
              type: "response-complete",
              response: {
                assistant: { role: "assistant", content: "Still here." },
                finishReason: "stop",
              },
            },
          ],
        ],
        requests,
      ),
      sessionStore: fakeSessionStore([]),
      session: await transcriptFromFixture("completed-legacy-read-file.jsonl"),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 1_000_000,
      maxOutputTokens: 1_000,
      tools: [],
    });

    expect(requests).toEqual([]);
    expect(harness.getSnapshot()).toMatchObject({
      status: "idle",
      pending: null,
    });
    expect(await harness.dispatch({ type: "submit", content: "Summarize that." })).toEqual({
      ok: true,
    });
    expect(requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          toolCalls: [
            { id: "call-1", name: "read_file", arguments: { path: "missing.txt" } },
            { id: "call-2", name: "read_file", arguments: { path: "AGENTS.md" } },
          ],
        }),
        {
          role: "tool",
          toolCallId: "call-1",
          content: {
            ok: false,
            error: {
              code: "ENOENT",
              message: "File not found",
              path: "/workspace/missing.txt",
            },
          },
        },
        {
          role: "tool",
          toolCallId: "call-2",
          content: { ok: true, result: { content: "# Agents\n" } },
        },
      ]),
    );
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

  it("runs the Read Tool through the Harness boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "susan-harness-"));
    try {
      const path = join(root, "note.txt");
      await writeFile(path, "confirmed content\n", "utf8");
      const requests: ProviderRequest[] = [];
      const appended: CompletionMessage[] = [];
      const session = {
        ...transcript(),
        header: { ...transcript().header, cwd: root },
      };
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
                        name: "read",
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
        session,
        model: "model",
        reasoningEffort: "high",
        contextWindow: 1_000_000,
        maxOutputTokens: 1_000,
        tools: [createReadTool({ sessionCwd: root })],
      });

      expect(
        await harness.dispatch({ type: "submit", content: "Read note.txt" }),
      ).toEqual({ ok: true });
      expect(appended.find((message) => message.role === "tool")).toMatchObject({
        content: {
          ok: true,
          result: { resolvedPath: path, content: "confirmed content\n" },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the Write Tool through the Harness boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "susan-harness-write-"));
    try {
      const path = join(root, "created.txt");
      const requests: ProviderRequest[] = [];
      const appended: CompletionMessage[] = [];
      const session = {
        ...transcript(),
        header: { ...transcript().header, cwd: root },
      };
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
                        id: "write-1",
                        name: "write",
                        arguments: { path, content: "created\n" },
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
                  assistant: { role: "assistant", content: "Wrote it" },
                  finishReason: "stop",
                },
              },
            ],
          ],
          requests,
        ),
        sessionStore: fakeSessionStore(appended),
        session,
        model: "model",
        reasoningEffort: "high",
        contextWindow: 1_000_000,
        maxOutputTokens: 1_000,
        tools: [createWriteTool({ sessionCwd: root })],
      });

      expect(
        await harness.dispatch({ type: "submit", content: "Write created.txt" }),
      ).toEqual({ ok: true });
      expect(appended.find((message) => message.role === "tool")).toMatchObject({
        content: {
          ok: true,
          result: { resolvedPath: path, operation: "created", bytesWritten: 8 },
        },
      });
      await expect(readFile(path, "utf8")).resolves.toBe("created\n");
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
        tools: [createReadTool({ sessionCwd: process.cwd() })],
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
    });
    expect(await harness.dispatch({ type: "retry" })).toEqual({ ok: true });
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
