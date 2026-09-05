import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import {
  createOpenAICompletionAdapter,
  openAICompletionProvider,
} from "../src/adapters/openai-completion.js";
import type {
  ProviderRequest,
  ProviderStreamEvent,
  ResolvedProviderConfig,
} from "../src/core/provider.js";

const resolvedConfig = {
  type: "openai-completion",
  apiKey: "sk-test",
  baseURL: new URL("https://api.deepseek.com"),
} satisfies ResolvedProviderConfig;

const request = {
  model: "deepseek-v4-flash",
  reasoningEffort: "medium",
  messages: [
    { role: "system", content: "You are Susan." },
    { role: "user", content: "Read the file." },
    {
      role: "assistant",
      content: "I will read it.",
      reasoning: "The user wants one file.",
      toolCalls: [
        { id: "call-1", name: "read_file", arguments: { path: "/tmp/a" } },
      ],
    },
    {
      role: "tool",
      toolCallId: "call-1",
      content: { ok: true, result: { content: "example" } },
    },
  ],
  tools: [
    {
      name: "read_file",
      description: "Read a UTF-8 text file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
} satisfies ProviderRequest;

type FakeClientOptions = {
  apiKey: string;
  baseURL: string;
  timeout: number;
  maxRetries: number;
};

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        unknownChoiceField: "ignored",
      },
    ],
    unknownTopLevelField: "ignored",
    ...extra,
  };
}

async function streamEvents(
  chunks: readonly unknown[],
  error?: unknown,
): Promise<{
  clientOptions: FakeClientOptions;
  upstreamRequest: unknown;
  createOptions: { readonly signal?: AbortSignal } | undefined;
  events: ProviderStreamEvent[];
}> {
  let clientOptions: FakeClientOptions | undefined;
  let upstreamRequest: unknown;
  let createOptions: { readonly signal?: AbortSignal } | undefined;

  const adapter = createOpenAICompletionAdapter((options) => {
    clientOptions = options;
    return {
      chat: {
        completions: {
          create: async (
            body: unknown,
            options?: { readonly signal?: AbortSignal },
          ) => {
            upstreamRequest = body;
            createOptions = options;
            return (async function* () {
              for (const value of chunks) {
                yield value;
              }
              if (error !== undefined) {
                throw error;
              }
            })();
          },
        },
      },
    };
  });

  const events: ProviderStreamEvent[] = [];
  const iterable = adapter
    .createClient(resolvedConfig)
    .stream(request, new AbortController().signal);

  for await (const event of iterable) {
    events.push(event);
  }

  if (clientOptions === undefined) {
    throw new Error("The adapter did not create an SDK client.");
  }

  return { clientOptions, upstreamRequest, createOptions, events };
}

describe("openai-completion provider adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps provider requests and configures the OpenAI SDK", async () => {
    const {
      clientOptions,
      upstreamRequest,
      createOptions,
      events,
    } = await streamEvents([
      chunk({ content: "Hello" }, "stop"),
    ]);

    expect(clientOptions).toEqual({
      apiKey: "sk-test",
      baseURL: "https://api.deepseek.com/",
      maxRetries: 0,
      timeout: 60_000,
    });
    expect(createOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(upstreamRequest).toEqual({
      model: "deepseek-v4-flash",
      reasoning_effort: "medium",
      messages: [
        { role: "system", content: "You are Susan." },
        { role: "user", content: "Read the file." },
        {
          role: "assistant",
          content: "I will read it.",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"/tmp/a"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: '{"ok":true,"result":{"content":"example"}}',
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read a UTF-8 text file.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(events).toHaveLength(2);
  });

  it("uses a non-streaming request for Compaction summaries", async () => {
    let upstreamRequest: unknown;
    const adapter = createOpenAICompletionAdapter(() => ({
      chat: {
        completions: {
          create: async (body: unknown) => {
            upstreamRequest = body;
            return {
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "Goal\n- Continue" },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 4,
                total_tokens: 24,
              },
              _request_id: "summary-request",
            };
          },
        },
      },
    }));
    const client = adapter.createClient(resolvedConfig);

    const result = await client.complete!(
      {
        model: "deepseek-v4-flash",
        reasoningEffort: "max",
        messages: request.messages.slice(0, 2),
      },
      new AbortController().signal,
    );

    expect(upstreamRequest).toEqual({
      model: "deepseek-v4-flash",
      reasoning_effort: "max",
      messages: [
        { role: "system", content: "You are Susan." },
        { role: "user", content: "Read the file." },
      ],
      stream: false,
    });
    expect(result).toEqual({
      assistant: { role: "assistant", content: "Goal\n- Continue" },
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
      requestId: "summary-request",
    });
  });

  it("normalizes and reassembles text, reasoning, and tool call deltas", async () => {
    const { events } = await streamEvents([
      chunk({ content: "He", unknownDeltaField: "ignored" }, null),
      chunk({ reasoning_content: "Thinking" }, null),
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":',
              },
            },
          ],
        },
        null,
      ),
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              function: { arguments: '"/tmp/a"}' },
            },
          ],
        },
        null,
      ),
      chunk({ content: "llo" }, "tool_calls"),
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
        _request_id: "request-1",
      },
    ]);

    expect(events).toEqual([
      { type: "text-delta", textDelta: "He" },
      { type: "reasoning-delta", textDelta: "Thinking" },
      {
        type: "tool-call-delta",
        index: 0,
        id: "call-1",
        name: "read_file",
        argumentsDelta: '{"path":',
      },
      {
        type: "tool-call-delta",
        index: 0,
        argumentsDelta: '"/tmp/a"}',
      },
      { type: "text-delta", textDelta: "llo" },
      {
        type: "response-complete",
        response: {
          assistant: {
            role: "assistant",
            content: "Hello",
            reasoning: "Thinking",
            toolCalls: [
              {
                id: "call-1",
                name: "read_file",
                arguments: { path: "/tmp/a" },
              },
            ],
          },
          finishReason: "tool_calls",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
          requestId: "request-1",
        },
      },
    ]);
  });

  it("accepts empty wire deltas without treating them as semantic output", async () => {
    const { events } = await streamEvents([
      chunk({ content: "", reasoning_content: "" }, null),
      chunk({ content: "Hello" }, "stop"),
    ]);

    expect(events).toEqual([
      { type: "text-delta", textDelta: "Hello" },
      {
        type: "response-complete",
        response: {
          assistant: { role: "assistant", content: "Hello" },
          finishReason: "stop",
        },
      },
    ]);
  });

  it("fails closed on malformed consumed stream fields", async () => {
    const malformedStreams = [
      {
        hadSemanticOutput: false,
        chunks: [chunk({ content: 42 }, null), chunk({}, "stop")],
      },
      {
        hadSemanticOutput: true,
        chunks: [
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "read_file", arguments: "{" },
                },
              ],
            },
            "tool_calls",
          ),
        ],
      },
      {
        hadSemanticOutput: true,
        chunks: [
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
            "tool_calls",
          ),
        ],
      },
      {
        hadSemanticOutput: true,
        chunks: [
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { arguments: "{}" },
                },
              ],
            },
            "tool_calls",
          ),
        ],
      },
      {
        hadSemanticOutput: true,
        chunks: [
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
                {
                  index: 0,
                  type: "function",
                  function: { name: "read_file", arguments: "{}" },
                },
              ],
            },
            null,
          ),
        ],
      },
      {
        hadSemanticOutput: true,
        chunks: [chunk({ content: "Partial" }, null)],
      },
      {
        hadSemanticOutput: true,
        chunks: [chunk({ content: "Partial" }, "unexpected")],
      },
    ];

    for (const { chunks, hadSemanticOutput } of malformedStreams) {
      const { events } = await streamEvents(chunks);
      const terminal = events.at(-1);

      expect(terminal?.type).toBe("response-error");
      if (terminal?.type === "response-error") {
        expect(terminal.failure.code).toBe("PROVIDER_PROTOCOL");
        expect(terminal.failure.hadSemanticOutput).toBe(hadSemanticOutput);
      }
      expect(events.filter((event) => event.type === "response-complete")).toHaveLength(0);
    }
  });

  it("returns an incomplete failure for non-success finish reasons", async () => {
    for (const finishReason of [
      "length",
      "content_filter",
      "insufficient_system_resource",
    ]) {
      const { events } = await streamEvents([
        chunk({ content: "Partial" }, finishReason),
      ]);

      expect(events).toEqual([
        { type: "text-delta", textDelta: "Partial" },
        {
          type: "response-error",
          failure: {
            code: "PROVIDER_INCOMPLETE",
            message: "Provider ended the response before completion.",
            hadSemanticOutput: true,
          },
        },
      ]);
    }
  });

  it("ends after one terminal error and emits no following deltas", async () => {
    const error = new APIError(
      500,
      { message: "full response body sk-test" },
      "500 full response body sk-test",
      new Headers({ "x-request-id": "request-1" }),
    );
    const { events } = await streamEvents(
      [chunk({ content: "Partial" }, null)],
      error,
    );

    expect(events).toEqual([
      { type: "text-delta", textDelta: "Partial" },
      {
        type: "response-error",
        failure: {
          code: "PROVIDER_HTTP",
          message: "Provider returned HTTP 500.",
          httpStatus: 500,
          requestId: "request-1",
          hadSemanticOutput: true,
          cause: error,
        },
      },
    ]);
  });

  it("ends the iterator immediately after either terminal event", async () => {
    const adapter = createOpenAICompletionAdapter(() => ({
      chat: {
        completions: {
          create: async () => (async function* () {
            yield chunk({ content: "Done" }, "stop");
          })(),
        },
      },
    }));
    const client = adapter.createClient(resolvedConfig);
    const completeIterator = client
      .stream(request, new AbortController().signal)
      [Symbol.asyncIterator]();

    expect((await completeIterator.next()).value).toEqual({
      type: "text-delta",
      textDelta: "Done",
    });
    expect((await completeIterator.next()).value?.type).toBe("response-complete");
    expect(await completeIterator.next()).toEqual({ done: true, value: undefined });

    const aborted = new AbortController();
    aborted.abort();
    const errorIterator = client
      .stream(request, aborted.signal)
      [Symbol.asyncIterator]();

    expect((await errorIterator.next()).value?.type).toBe("response-error");
    expect(await errorIterator.next()).toEqual({ done: true, value: undefined });
  });

  it("parses seconds-based Retry-After and safe HTTP failures", async () => {
    const error = new APIError(
      429,
      { message: "Rate limited sk-test" },
      "429 Rate limited sk-test",
      new Headers({
        "retry-after": "2",
        "x-request-id": "request-1",
      }),
    );
    const { events } = await streamEvents([], error);
    const failure = events[0]?.type === "response-error"
      ? events[0].failure
      : undefined;

    expect(failure).toEqual({
      code: "PROVIDER_HTTP",
      message: "Provider returned HTTP 429.",
      httpStatus: 429,
      requestId: "request-1",
      retryAfterMs: 2_000,
      hadSemanticOutput: false,
      cause: error,
    });
    expect(failure?.message).not.toContain("sk-test");
    expect(failure?.message).not.toContain("Rate limited");
  });

  it("marks only recognized Provider context overflow failures", async () => {
    const error = new APIError(
      400,
      {
        code: "context_length_exceeded",
        message: "Maximum context length exceeded",
      },
      "400 Maximum context length exceeded",
      new Headers(),
    );
    const { events } = await streamEvents([], error);
    const failure = events[0]?.type === "response-error"
      ? events[0].failure
      : undefined;

    expect(failure).toMatchObject({
      code: "PROVIDER_HTTP",
      httpStatus: 400,
      contextOverflow: true,
      hadSemanticOutput: false,
    });
  });

  it("parses HTTP-date Retry-After values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00.000Z"));
    const error = new APIError(
      429,
      undefined,
      "429 Too Many Requests",
      new Headers({ "retry-after": "Mon, 07 Sep 2026 00:00:30 GMT" }),
    );
    const { events } = await streamEvents([], error);
    const failure = events[0]?.type === "response-error"
      ? events[0].failure
      : undefined;

    expect(failure?.retryAfterMs).toBe(4 * 24 * 60 * 60 * 1_000 + 30_000);
  });

  it.each([
    {
      error: new APIConnectionTimeoutError({
        message: "Request timed out sk-test",
      }),
      code: "PROVIDER_TIMEOUT",
      message: "Provider request timed out.",
    },
    {
      error: new APIConnectionError({
        message: "fetch failed sk-test",
      }),
      code: "PROVIDER_NETWORK",
      message: "Provider network request failed.",
    },
    {
      error: new APIUserAbortError({
        message: "Request aborted sk-test",
      }),
      code: "PROVIDER_ABORT",
      message: "Provider request was aborted.",
    },
  ])("normalizes SDK connection failures", async ({ error, code, message }) => {
    const { events } = await streamEvents([], error);
    const failure = events[0]?.type === "response-error"
      ? events[0].failure
      : undefined;

    expect(failure).toMatchObject({
      code,
      message,
      hadSemanticOutput: false,
      cause: error,
    });
    expect(failure?.message).not.toContain("sk-test");
  });

  it("exposes only the provider-neutral adapter boundary", () => {
    expect(openAICompletionProvider.type).toBe("openai-completion");
    expect(openAICompletionProvider.defaultBaseURL.href).toBe(
      "https://api.deepseek.com/",
    );
    expect(openAICompletionProvider.createClient(resolvedConfig).type).toBe(
      "openai-completion",
    );
  });
});
