import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  createHarness,
} from "../src/index.js";
import { selectRecentTailStart } from "../src/core/context.js";
import type {
  CompletionMessage,
  HarnessEvent,
  ProviderClient,
  ProviderFailure,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderUsage,
  SessionCompactionRecord,
  SessionStore,
  SessionTranscript,
} from "../src/index.js";

function transcript(messages: readonly CompletionMessage[]): SessionTranscript {
  return {
    header: {
      type: "session",
      version: 1,
      id: "00000000-0000-4000-8000-000000000028",
      createdAt: "2026-09-03T00:00:00.000Z",
      cwd: "/workspace",
    },
    records: messages.map((message) => ({ type: "message", message })),
    messages,
    filePath: "/sessions/context.jsonl",
  };
}

function store(
  messages: CompletionMessage[],
  checkpoints: SessionCompactionRecord[],
  usages: ProviderUsage[] = [],
): SessionStore {
  return {
    async createSession() {
      throw new Error("not used");
    },
    async appendMessage(_sessionId, message) {
      messages.push(message);
      return { ok: true, value: undefined };
    },
    async appendCompaction(_sessionId, checkpoint) {
      checkpoints.push(checkpoint);
      return { ok: true, value: undefined };
    },
    async appendUsage(_sessionId, usage) {
      usages.push(usage);
      return { ok: true, value: undefined };
    },
    async loadSession() {
      throw new Error("not used");
    },
    async listSessions() {
      throw new Error("not used");
    },
    async loadLastSession() {
      throw new Error("not used");
    },
    async loadInputHistory() {
      throw new Error("not used");
    },
  };
}

function provider(input: {
  streams: readonly (readonly ProviderStreamEvent[])[];
  completions: readonly (ProviderResponse | ProviderFailure)[];
  requests: ProviderRequest[];
  summaryRequests: ProviderRequest[];
}): ProviderClient {
  let streamIndex = 0;
  let completionIndex = 0;
  return {
    type: "openai-completion",
    async *stream(request) {
      input.requests.push(request);
      const events = input.streams[streamIndex++];
      if (events === undefined) {
        throw new Error("Unexpected streaming request");
      }
      yield* events;
    },
    async complete(request) {
      input.summaryRequests.push(request);
      const result = input.completions[completionIndex++];
      if (result === undefined) {
        throw new Error("Unexpected summary request");
      }
      return result;
    },
  };
}

const completed = (content: string): readonly ProviderStreamEvent[] => [
  {
    type: "response-complete",
    response: {
      assistant: { role: "assistant", content },
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    },
  },
];

describe("Model Context compaction", () => {
  it("compacts before a request, persists a checkpoint, and restores canonical runtime context", async () => {
    const oldText = "old-context ".repeat(6_000);
    const initial: CompletionMessage[] = [
      { role: "user", content: oldText },
      { role: "assistant", content: "Old answer." },
    ];
    const requests: ProviderRequest[] = [];
    const summaryRequests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const checkpoints: SessionCompactionRecord[] = [];
    const usages: ProviderUsage[] = [];
    const client = provider({
      streams: [completed("Done")],
      completions: [
        {
          assistant: {
            role: "assistant",
            content: "Goal\n- Finish the current request",
          },
          finishReason: "stop",
          usage: { inputTokens: 24_000, outputTokens: 30, totalTokens: 24_030 },
        },
      ],
      requests,
      summaryRequests,
    });
    const events: HarnessEvent[] = [];
    const harness = createHarness({
      provider: client,
      sessionStore: store(appended, checkpoints, usages),
      session: transcript(initial),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 25_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [],
    });
    harness.subscribe((event) => events.push(event));

    expect(await harness.dispatch({ type: "submit", content: "Continue." })).toEqual({ ok: true });

    expect(summaryRequests).toHaveLength(1);
    expect(summaryRequests[0]).toMatchObject({
      model: "model",
      reasoningEffort: "high",
      messages: [
        { role: "system", content: buildSystemPrompt("/workspace") },
        { role: "user" },
      ],
    });
    expect(summaryRequests[0]?.tools).toBeUndefined();
    expect(requests[0]?.messages[0]).toEqual({
      role: "system",
      content: buildSystemPrompt("/workspace"),
    });
    expect(JSON.stringify(requests[0]?.messages)).toContain("Finish the current request");
    expect(JSON.stringify(requests[0]?.messages)).toContain("Continue.");
    expect(JSON.stringify(requests[0]?.messages)).not.toContain(oldText);
    expect(checkpoints).toEqual([
      expect.objectContaining({
        type: "compaction",
        summary: "Goal\n- Finish the current request",
        firstKeptMessageIndex: 1,
      }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "context-compacted" }),
    );
    expect(usages).toEqual([
      { inputTokens: 24_000, outputTokens: 30, totalTokens: 24_030 },
      { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    ]);
    expect(harness.getSnapshot().sessionTotalTokens).toBe(24_140);
  });

  it("returns ContextTooLarge without calling the Provider when the current user turn cannot fit", async () => {
    const requests: ProviderRequest[] = [];
    const summaryRequests: ProviderRequest[] = [];
    const checkpoints: SessionCompactionRecord[] = [];
    const harness = createHarness({
      provider: provider({ streams: [], completions: [], requests, summaryRequests }),
      sessionStore: store([], checkpoints),
      session: transcript([]),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 16_384,
      maxOutputTokens: 1,
      approvalPolicy: "ask",
      tools: [],
    });

    const result = await harness.dispatch({ type: "submit", content: "Too large." });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "CONTEXT_TOO_LARGE",
        estimates: {
          systemPrompt: expect.any(Number),
          tools: 0,
          currentUserTurn: expect.any(Number),
        },
      },
    });
    expect(requests).toEqual([]);
    expect(summaryRequests).toEqual([]);
    expect(checkpoints).toEqual([]);
  });

  it("compacts and retries one overflowed request without replaying completed Tool calls", async () => {
    const oldText = "old-context ".repeat(6_000);
    const requests: ProviderRequest[] = [];
    const summaryRequests: ProviderRequest[] = [];
    const appended: CompletionMessage[] = [];
    const checkpoints: SessionCompactionRecord[] = [];
    let executions = 0;
    const harness = createHarness({
      provider: provider({
        streams: [
          [
            {
              type: "response-complete",
              response: {
                assistant: {
                  role: "assistant",
                  toolCalls: [{ id: "read-1", name: "read_file", arguments: { path: "a" } }],
                },
                finishReason: "tool_calls",
                usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
              },
            },
          ],
          [
            {
              type: "response-error",
              failure: {
                code: "PROVIDER_HTTP",
                message: "Maximum context length exceeded.",
                httpStatus: 400,
                hadSemanticOutput: false,
                contextOverflow: true,
              },
            },
          ],
          completed("Recovered"),
        ],
        completions: [
          {
            assistant: { role: "assistant", content: "Goal\n- Recover" },
            finishReason: "stop",
          },
        ],
        requests,
        summaryRequests,
      }),
      sessionStore: store(appended, checkpoints),
      session: transcript([
        { role: "user", content: oldText },
        { role: "assistant", content: "Old answer." },
      ]),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 100_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "yolo",
      tools: [
        {
          name: "read_file",
          description: "read",
          parameters: { type: "object" },
          async execute() {
            executions += 1;
            return { ok: true, result: { content: "file" } };
          },
        },
      ],
    });

    expect(await harness.dispatch({ type: "submit", content: "Read it." })).toEqual({ ok: true });

    expect(executions).toBe(1);
    expect(requests).toHaveLength(3);
    expect(summaryRequests).toHaveLength(1);
    expect(checkpoints).toHaveLength(1);
    const retriedMessages = requests[2]!.messages;
    expect(retriedMessages).toContainEqual(
      expect.objectContaining({ role: "tool", toolCallId: "read-1" }),
    );
  });

  it("keeps the prior checkpoint when summary generation fails", async () => {
    const oldText = "old-context ".repeat(6_000);
    const requests: ProviderRequest[] = [];
    const summaryRequests: ProviderRequest[] = [];
    const checkpoints: SessionCompactionRecord[] = [];
    const harness = createHarness({
      provider: provider({
        streams: [],
        completions: Array.from({ length: 3 }, () => ({
            code: "PROVIDER_HTTP",
            message: "Summary unavailable.",
            httpStatus: 503,
            hadSemanticOutput: false,
          }) satisfies ProviderFailure),
        requests,
        summaryRequests,
      }),
      sessionStore: store([], checkpoints),
      session: transcript([
        { role: "user", content: oldText },
        { role: "assistant", content: "Old answer." },
      ]),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 25_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [],
      clock: { async sleep() {} },
    });

    const result = await harness.dispatch({ type: "submit", content: "Continue." });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "HARNESS_COMPACTION", message: "Summary unavailable." },
    });
    expect(requests).toEqual([]);
    expect(summaryRequests).toHaveLength(3);
    expect(checkpoints).toEqual([]);
  });

  it("rolls the latest restored summary forward without re-summarizing the full Transcript", async () => {
    const beforeCheckpoint = "already-summarized ".repeat(100);
    const newlyOld = "newly-old ".repeat(7_000);
    const messages: CompletionMessage[] = [
      { role: "user", content: beforeCheckpoint },
      { role: "user", content: newlyOld },
      { role: "assistant", content: "Intermediate answer." },
    ];
    const priorCheckpoint: SessionCompactionRecord = {
      type: "compaction",
      summary: "Goal\n- Previous goal",
      firstKeptMessageIndex: 1,
      tokensBefore: 30_000,
      tokensAfterEstimate: 22_000,
      createdAt: "2026-09-03T00:30:00.000Z",
    };
    const session = transcript(messages);
    const restored: SessionTranscript = {
      ...session,
      records: [
        { type: "message", message: messages[0]! },
        priorCheckpoint,
        ...messages.slice(1).map((message) => ({ type: "message" as const, message })),
      ],
    };
    const requests: ProviderRequest[] = [];
    const summaryRequests: ProviderRequest[] = [];
    const checkpoints: SessionCompactionRecord[] = [];
    const harness = createHarness({
      provider: provider({
        streams: [completed("Done")],
        completions: [
          {
            assistant: { role: "assistant", content: "Goal\n- Updated goal" },
            finishReason: "stop",
          },
        ],
        requests,
        summaryRequests,
      }),
      sessionStore: store([], checkpoints),
      session: restored,
      model: "model",
      reasoningEffort: "high",
      contextWindow: 25_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [],
    });

    expect(await harness.dispatch({ type: "submit", content: "Continue." })).toEqual({ ok: true });

    const summaryInput = JSON.stringify(summaryRequests[0]?.messages);
    expect(summaryInput).toContain("Previous goal");
    expect(summaryInput).toContain(newlyOld);
    expect(summaryInput).not.toContain(beforeCheckpoint);
    expect(checkpoints[0]?.firstKeptMessageIndex).toBe(2);
    expect(JSON.stringify(requests[0]?.messages)).toContain("Updated goal");
  });

  it("uses the latest successful provider usage as the baseline for later budget checks", async () => {
    const requests: ProviderRequest[] = [];
    const summaryRequests: ProviderRequest[] = [];
    const checkpoints: SessionCompactionRecord[] = [];
    const harness = createHarness({
      provider: provider({
        streams: [
          [
            {
              type: "response-complete",
              response: {
                assistant: { role: "assistant", content: "First answer." },
                finishReason: "stop",
                usage: {
                  inputTokens: 35_000,
                  outputTokens: 10,
                  totalTokens: 35_010,
                },
              },
            },
          ],
          completed("Second answer."),
        ],
        completions: [
          {
            assistant: { role: "assistant", content: "Goal\n- Continue" },
            finishReason: "stop",
          },
        ],
        requests,
        summaryRequests,
      }),
      sessionStore: store([], checkpoints),
      session: transcript([
        { role: "user", content: "old-context ".repeat(6_000) },
        { role: "assistant", content: "Old answer." },
      ]),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 50_000,
      maxOutputTokens: 20_000,
      approvalPolicy: "ask",
      tools: [],
    });

    expect(await harness.dispatch({ type: "submit", content: "First." })).toEqual({ ok: true });
    expect(summaryRequests).toEqual([]);
    expect(await harness.dispatch({ type: "submit", content: "Second." })).toEqual({ ok: true });

    expect(summaryRequests).toHaveLength(1);
    expect(checkpoints).toHaveLength(1);
  });

  it("uses the usage baseline after a restored checkpoint", async () => {
    const largeTurn = "x".repeat(63_000);
    const requests: ProviderRequest[] = [];
    const summaryRequests: ProviderRequest[] = [];
    const checkpoints: SessionCompactionRecord[] = [];
    const initialMessages: CompletionMessage[] = [
      { role: "user", content: largeTurn },
      { role: "assistant", content: "Old answer." },
    ];
    const checkpoint: SessionCompactionRecord = {
      type: "compaction",
      summary: "Goal\n- Continue",
      firstKeptMessageIndex: 0,
      tokensBefore: 30_000,
      tokensAfterEstimate: 21_000,
      createdAt: "2026-09-03T00:00:00.000Z",
    };
    const session = transcript(initialMessages);
    const restored: SessionTranscript = {
      ...session,
      records: [
        { type: "message", message: initialMessages[0]! },
        { type: "message", message: initialMessages[1]! },
        checkpoint,
      ],
    };
    const harness = createHarness({
      provider: provider({
        streams: [
          [
            {
              type: "response-complete",
              response: {
                assistant: { role: "assistant", content: "First answer." },
                finishReason: "stop",
                usage: {
                  inputTokens: 35_000,
                  outputTokens: 10,
                  totalTokens: 35_010,
                },
              },
            },
          ],
          completed("Second answer."),
        ],
        completions: [
          {
            assistant: { role: "assistant", content: "Goal\n- Updated" },
            finishReason: "stop",
          },
        ],
        requests,
        summaryRequests,
      }),
      sessionStore: store([], checkpoints),
      session: restored,
      model: "model",
      reasoningEffort: "high",
      contextWindow: 50_000,
      maxOutputTokens: 25_000,
      approvalPolicy: "ask",
      tools: [],
    });

    expect(await harness.dispatch({ type: "submit", content: "First." })).toEqual({ ok: true });
    expect(await harness.dispatch({ type: "submit", content: "Second." })).toEqual({ ok: true });

    expect(summaryRequests).toHaveLength(1);
    expect(checkpoints).toHaveLength(1);
  });

  it("selects a user-turn boundary and never starts at a Tool Result", () => {
    const messages: CompletionMessage[] = [
      { role: "user", content: "old ".repeat(4_000) },
      {
        role: "assistant",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: {} }],
      },
      { role: "tool", toolCallId: "call-1", content: "x".repeat(20_000) },
      { role: "user", content: "Recent turn." },
    ];

    expect(selectRecentTailStart(messages, 0, 6_000)).toBe(3);
  });

  it("stops after the single overflow Compaction retry also overflows", async () => {
    const overflow: readonly ProviderStreamEvent[] = [
      {
        type: "response-error",
        failure: {
          code: "PROVIDER_HTTP",
          message: "Maximum context length exceeded.",
          httpStatus: 400,
          hadSemanticOutput: false,
          contextOverflow: true,
        },
      },
    ];
    const requests: ProviderRequest[] = [];
    const summaryRequests: ProviderRequest[] = [];
    const checkpoints: SessionCompactionRecord[] = [];
    const harness = createHarness({
      provider: provider({
        streams: [overflow, overflow],
        completions: [
          {
            assistant: {
              role: "assistant",
              content: "Goal\n- Recover once",
            },
            finishReason: "stop",
          },
        ],
        requests,
        summaryRequests,
      }),
      sessionStore: store([], checkpoints),
      session: transcript([
        { role: "user", content: "old-context ".repeat(6_000) },
        { role: "assistant", content: "Old answer." },
      ]),
      model: "model",
      reasoningEffort: "high",
      contextWindow: 100_000,
      maxOutputTokens: 1_000,
      approvalPolicy: "ask",
      tools: [],
    });

    const result = await harness.dispatch({
      type: "submit",
      content: "Continue.",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "HARNESS_PROVIDER" },
    });
    expect(requests).toHaveLength(2);
    expect(summaryRequests).toHaveLength(1);
    expect(checkpoints).toHaveLength(1);
  });
});
