import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ApprovalPolicy,
  Config,
  ConfigError,
  ConfigIssue,
  ProviderAdapter,
  ProviderFailure,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderToolDefinition,
  ProviderType,
  ResolvedProviderConfig,
  SessionRecord,
} from "../src/index.js";

describe("shared type contracts", () => {
  it("models the config schema and structured config errors", () => {
    const config = {
      defaultProvider: "deepseek",
      defaultModel: "deepseek-v4-flash",
      approval: "ask",
      providers: {
        deepseek: {
          type: "openai-completion",
          apiKey: "sk-test",
          baseURL: "https://api.deepseek.com",
        },
      },
    } satisfies Config;
    const issue = {
      path: "approval",
      code: "invalid_enum",
      message: "approval must be ask or yolo",
    } satisfies ConfigIssue;
    const error = {
      code: "SUSAN_CONFIG_SCHEMA",
      configPath: "/home/example/.susan/config.json",
      issues: [issue],
    } satisfies ConfigError;

    expectTypeOf<ApprovalPolicy>().toEqualTypeOf<"ask" | "yolo">();
    expectTypeOf<ProviderType>().toEqualTypeOf<
      "anthropic" | "openai-completion" | "responses"
    >();
    expect(error.issues).toHaveLength(1);
  });

  it("models provider-neutral requests, tools, and failures", () => {
    const tool = {
      name: "read_file",
      description: "Read a UTF-8 text file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    } satisfies ProviderToolDefinition;
    const request = {
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: "You are Susan." },
        { role: "user", content: "Read the file." },
        {
          role: "assistant",
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
      tools: [tool],
    } satisfies ProviderRequest;
    const failure = {
      code: "PROVIDER_HTTP",
      message: "Provider rejected the request.",
      httpStatus: 429,
      requestId: "request-1",
      retryAfterMs: 1_000,
      hadSemanticOutput: false,
    } satisfies ProviderFailure;

    expect(request.messages).toHaveLength(4);
    expect(failure.httpStatus).toBe(429);
    expectTypeOf<ProviderFailure["code"]>().toEqualTypeOf<
      | "PROVIDER_NETWORK"
      | "PROVIDER_TIMEOUT"
      | "PROVIDER_HTTP"
      | "PROVIDER_PROTOCOL"
      | "PROVIDER_INCOMPLETE"
      | "PROVIDER_ABORT"
    >();
  });

  it("models normalized provider stream events", () => {
    const events = [
      { type: "text-delta", textDelta: "He" },
      { type: "reasoning-delta", textDelta: "Think" },
      {
        type: "tool-call-delta",
        index: 0,
        id: "call-1",
        name: "read_file",
        argumentsDelta: "{\"path\":",
      },
      {
        type: "response-complete",
        response: {
          assistant: {
            role: "assistant",
            content: "Hello",
            reasoning: "Done",
            toolCalls: [
              { id: "call-1", name: "read_file", arguments: { path: "/tmp/a" } },
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
      {
        type: "response-error",
        failure: {
          code: "PROVIDER_ABORT",
          message: "The request was aborted.",
          hadSemanticOutput: true,
        },
      },
    ] satisfies ProviderStreamEvent[];

    expect(events).toHaveLength(5);
    expectTypeOf<ProviderStreamEvent["type"]>().toEqualTypeOf<
      | "text-delta"
      | "reasoning-delta"
      | "tool-call-delta"
      | "response-complete"
      | "response-error"
    >();
  });

  it("models the provider adapter boundary", () => {
    const adapter = {
      type: "openai-completion",
      defaultBaseURL: new URL("https://api.deepseek.com"),
      createClient(config: ResolvedProviderConfig) {
        return {
          type: config.type,
          async complete() {
            return {
              assistant: { role: "assistant", content: "Summary" },
              finishReason: "stop",
            } as const;
          },
          stream: async function* () {
            yield {
              type: "response-complete",
              response: {
                assistant: { role: "assistant", content: "Hello" },
                finishReason: "stop",
              },
            } satisfies ProviderStreamEvent;
          },
        };
      },
    } satisfies ProviderAdapter;

    expect(adapter.type).toBe("openai-completion");
    expect(adapter.defaultBaseURL.href).toBe("https://api.deepseek.com/");
  });

  it("models session headers and append-only records", () => {
    const records = [
      { type: "message", message: { role: "user", content: "Read the file." } },
      {
        type: "compaction",
        summary: "Goal: read the file.",
        firstKeptMessageIndex: 1,
        tokensBefore: 20_000,
        tokensAfterEstimate: 1_000,
        createdAt: "2026-09-03T00:00:00.000Z",
      },
    ] satisfies SessionRecord[];

    expect(records).toHaveLength(2);
    expectTypeOf<SessionRecord["type"]>().toEqualTypeOf<
      "message" | "compaction"
    >();
  });
});
