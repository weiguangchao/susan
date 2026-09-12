import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  APIError,
} from "openai";
import { isJsonValue, isRecord, type JsonValue } from "../core/json";
import { toolResultText } from "../core/tool-result";
import { SUSAN_USER_AGENT } from "../version";
import type {
  ProviderAdapter,
  ProviderClient,
  ProviderFailure,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderToolCall,
  ProviderUsage,
  ResolvedProviderConfig,
} from "../core/provider";

const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_BASE_URL = new URL("https://api.deepseek.com");

type OpenAIClientOptions = {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly defaultHeaders: { readonly "User-Agent": string };
};

type ChatCompletionsClient = {
  readonly chat: {
    readonly completions: {
      create(
        body: unknown,
        options?: { readonly signal?: AbortSignal },
      ): Promise<unknown>;
    };
  };
};

type OpenAIClientFactory = (
  options: OpenAIClientOptions,
) => ChatCompletionsClient;

type ToolCallAccumulator = {
  id?: string;
  name?: string;
  arguments: string;
};

class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function protocolError(message: string): never {
  throw new ProviderProtocolError(message);
}

function createOpenAIClient(options: OpenAIClientOptions): ChatCompletionsClient {
  return new OpenAI(options);
}

function toChatCompletionsRequest(
  request: ProviderRequest,
  stream = true,
): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (let index = 0; index < request.messages.length; index++) {
    const message = request.messages[index];
    if (message.role === "system" || message.role === "user") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "tool") {
      const images: Record<string, unknown>[] = [];
      do {
        const tool = request.messages[index];
        if (tool.role !== "tool") break;
        const hasImages = tool.content.some((block) => block.type === "image");
        messages.push({
          role: "tool",
          tool_call_id: tool.toolCallId,
          content: toolResultText(tool.content) || (hasImages ? "(see attached image)" : "(no tool output)"),
        });
        if (request.modelInput?.includes("image")) {
          for (const block of tool.content) {
            if (block.type === "image") images.push({
              type: "image_url",
              image_url: { url: `data:${block.mimeType};base64,${block.data}` },
            });
          }
        }
        index++;
      } while (index < request.messages.length && request.messages[index].role === "tool");
      index--;
      if (images.length) messages.push({
        role: "user",
        content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...images],
      });
      continue;
    }

    const assistant: Record<string, unknown> = {
      role: "assistant",
    };

    if (message.content !== undefined) {
      assistant.content = message.content;
    }

    if (message.toolCalls !== undefined) {
      assistant.tool_calls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      }));
    }

    messages.push(assistant);
  }

  const chatCompletionsRequest: Record<string, unknown> = {
    model: request.model,
    reasoning_effort: request.reasoningEffort,
    messages,
    stream,
  };

  if (request.maxTokens !== undefined) chatCompletionsRequest.max_tokens = request.maxTokens;

  if (stream) {
    chatCompletionsRequest.stream_options = { include_usage: true };
  }

  if (request.tools !== undefined && request.tools.length > 0) {
    chatCompletionsRequest.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  return chatCompletionsRequest;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function optionalString(
  value: unknown,
  field: string,
  allowEmpty = false,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    protocolError(`Provider returned an invalid ${field} field.`);
  }

  return value;
}

function parseUsage(value: unknown): ProviderUsage {
  if (!isRecord(value)) {
    protocolError("Provider returned an invalid usage field.");
  }

  const inputTokens = value.prompt_tokens;
  const outputTokens = value.completion_tokens;
  const totalTokens = value.total_tokens;

  if (
    !isNonNegativeInteger(inputTokens) ||
    !isNonNegativeInteger(outputTokens) ||
    !isNonNegativeInteger(totalTokens)
  ) {
    protocolError("Provider returned invalid usage values.");
  }

  const cachedInputTokens = parseCachedInputTokens(value.prompt_tokens_details);
  if (cachedInputTokens === undefined) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
  };
}

function parseCachedInputTokens(details: unknown): number | undefined {
  if (details === undefined || details === null) {
    return undefined;
  }
  if (!isRecord(details)) {
    protocolError("Provider returned an invalid prompt_tokens_details field.");
  }
  const cachedTokens = details.cached_tokens;
  if (cachedTokens === undefined || cachedTokens === null) {
    return undefined;
  }
  if (!isNonNegativeInteger(cachedTokens)) {
    protocolError("Provider returned an invalid cached_tokens field.");
  }
  return cachedTokens;
}

function headerValue(
  headers: unknown,
  name: string,
): string | undefined {
  if (!isRecord(headers) && !(headers instanceof Headers)) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const seconds = Number(value);
  if (/^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(seconds)) {
    return Math.round(seconds * 1_000);
  }

  const retryAt = Date.parse(value);
  if (Number.isFinite(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return undefined;
}

function failureFromError(
  error: unknown,
  hadSemanticOutput: boolean,
): ProviderFailure {
  const base = {
    hadSemanticOutput,
    cause: error,
  };

  if (error instanceof APIConnectionTimeoutError) {
    return {
      ...base,
      code: "PROVIDER_TIMEOUT",
      message: "Provider request timed out.",
    };
  }

  if (error instanceof APIUserAbortError) {
    return {
      ...base,
      code: "PROVIDER_ABORT",
      message: "Provider request was aborted.",
    };
  }

  if (error instanceof APIConnectionError) {
    return {
      ...base,
      code: "PROVIDER_NETWORK",
      message: "Provider network request failed.",
    };
  }

  if (error instanceof APIError) {
    const httpStatus =
      typeof error.status === "number" && Number.isSafeInteger(error.status)
        ? error.status
        : undefined;
    const requestId =
      optionalErrorRequestId(error) ??
      headerValue(error.headers, "x-request-id");
    const retryAfterMs = parseRetryAfter(
      headerValue(error.headers, "retry-after"),
    );

    if (httpStatus === undefined) {
      return {
        ...base,
        code: "PROVIDER_NETWORK",
        message: "Provider request failed before an HTTP response.",
        requestId,
        retryAfterMs,
      };
    }

    return {
      ...base,
      code: "PROVIDER_HTTP",
      message: `Provider returned HTTP ${httpStatus}.`,
      httpStatus,
      requestId,
      retryAfterMs,
      ...(isContextOverflowError(error) ? { contextOverflow: true } : {}),
    };
  }

  if (error instanceof ProviderProtocolError) {
    return {
      ...base,
      code: "PROVIDER_PROTOCOL",
      message: error.message,
    };
  }

  if (error instanceof Error && error.name === "AbortError") {
    return {
      ...base,
      code: "PROVIDER_ABORT",
      message: "Provider request was aborted.",
    };
  }

  return {
    ...base,
    code: "PROVIDER_NETWORK",
    message: "Provider network request failed.",
  };
}

function isContextOverflowError(error: APIError): boolean {
  const candidate = error as unknown;
  const values: unknown[] = [];
  if (isRecord(candidate)) {
    values.push(candidate.code, candidate.message);
    if (isRecord(candidate.error)) {
      values.push(candidate.error.code, candidate.error.message);
    }
  }
  return values.some(
    (value) =>
      typeof value === "string" &&
      /context(?:_| )?(?:length|window)|maximum context|too many tokens/i.test(
        value,
      ),
  );
}

function parseNonStreamingResponse(value: unknown): ProviderResponse | ProviderFailure {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1) {
    protocolError("Provider returned an invalid non-streaming response.");
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || choice.index !== 0 || !isRecord(choice.message)) {
    protocolError("Provider returned an invalid non-streaming choice.");
  }
  if (choice.finish_reason === "length") return {
    code: "PROVIDER_INCOMPLETE", message: "Generation hit the token cap and the summary is incomplete", hadSemanticOutput: false,
  };
  if (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls") {
    protocolError("Provider returned an invalid non-streaming finish_reason.");
  }
  const content = optionalString(choice.message.content, "content", true);
  const reasoning = optionalString(
    choice.message.reasoning_content,
    "reasoning_content",
    true,
  );
  const toolCalls: ProviderToolCall[] = [];
  if (choice.message.tool_calls !== undefined && choice.message.tool_calls !== null) {
    if (!Array.isArray(choice.message.tool_calls)) {
      protocolError("Provider returned invalid non-streaming tool calls.");
    }
    for (const raw of choice.message.tool_calls) {
      if (!isRecord(raw) || !isRecord(raw.function)) {
        protocolError("Provider returned an invalid non-streaming tool call.");
      }
      const id = optionalString(raw.id, "tool call id");
      const name = optionalString(raw.function.name, "tool call name");
      const argumentsText = optionalString(
        raw.function.arguments,
        "tool call arguments",
        true,
      );
      let argumentsValue: JsonValue;
      try {
        argumentsValue = JSON.parse(argumentsText ?? "") as JsonValue;
      } catch {
        protocolError("Provider tool call has invalid arguments JSON.");
      }
      if (!isJsonValue(argumentsValue)) {
        protocolError("Provider tool call has invalid arguments JSON.");
      }
      toolCalls.push({ id: id!, name: name!, arguments: argumentsValue });
    }
  }
  return buildResponse(
    choice.finish_reason,
    content ?? "",
    reasoning ?? "",
    toolCalls,
    value.usage === undefined || value.usage === null
      ? undefined
      : parseUsage(value.usage),
    optionalString(value._request_id, "_request_id"),
  );
}

function optionalErrorRequestId(error: APIError): string | undefined {
  if (
    typeof error.requestID === "string" &&
    error.requestID.length > 0
  ) {
    return error.requestID;
  }

  return undefined;
}

function buildToolCalls(
  accumulated: ReadonlyMap<number, ToolCallAccumulator>,
): ProviderToolCall[] {
  return [...accumulated.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, toolCall]) => {
      if (
        toolCall.id === undefined ||
        toolCall.name === undefined ||
        toolCall.id.length === 0 ||
        toolCall.name.length === 0
      ) {
        protocolError(`Provider tool call ${index} is missing id or name.`);
      }

      let argumentsValue: JsonValue;
      try {
        argumentsValue = JSON.parse(toolCall.arguments) as JsonValue;
      } catch {
        protocolError(`Provider tool call ${index} has invalid arguments JSON.`);
      }

      if (!isJsonValue(argumentsValue)) {
        protocolError(`Provider tool call ${index} has invalid arguments JSON.`);
      }

      return {
        id: toolCall.id,
        name: toolCall.name,
        arguments: argumentsValue,
      };
    });
}

function buildResponse(
  finishReason: "stop" | "tool_calls",
  text: string,
  reasoning: string,
  toolCalls: readonly ProviderToolCall[],
  usage: ProviderUsage | undefined,
  requestId: string | undefined,
): ProviderResponse {
  if (finishReason === "tool_calls" && toolCalls.length === 0) {
    protocolError("Provider ended with tool_calls but contained no tool calls.");
  }

  if (finishReason === "stop" && toolCalls.length > 0) {
    protocolError("Provider ended with stop but contained tool calls.");
  }

  const assistant: Record<string, unknown> = {
    role: "assistant",
  };

  if (text.length > 0) {
    assistant.content = text;
  }

  if (reasoning.length > 0) {
    assistant.reasoning = reasoning;
  }

  if (toolCalls.length > 0) {
    assistant.toolCalls = toolCalls;
  }

  const response: {
    assistant: Record<string, unknown>;
    finishReason: "stop" | "tool_calls";
    usage?: ProviderUsage;
    requestId?: string;
  } = {
    assistant,
    finishReason,
  };

  if (usage !== undefined) {
    response.usage = usage;
  }

  if (requestId !== undefined) {
    response.requestId = requestId;
  }

  return response as ProviderResponse;
}

function createClient(
  config: ResolvedProviderConfig,
  clientFactory: OpenAIClientFactory,
): ProviderClient {
  const client = clientFactory({
    apiKey: config.apiKey,
    baseURL: config.baseURL.href,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    // Replaces the SDK default User-Agent (OpenAI/JS x.y.z) intentionally.
    defaultHeaders: { "User-Agent": SUSAN_USER_AGENT },
  });

  return {
    type: "openai-completion",
    async *stream(
      request: ProviderRequest,
      signal: AbortSignal,
    ): AsyncGenerator<ProviderStreamEvent> {
      if (signal.aborted) {
        yield {
          type: "response-error",
          failure: {
            code: "PROVIDER_ABORT",
            message: "Provider request was aborted.",
            hadSemanticOutput: false,
          },
        };
        return;
      }

      const textParts: string[] = [];
      const reasoningParts: string[] = [];
      const toolCalls = new Map<number, ToolCallAccumulator>();
      let hadSemanticOutput = false;
      let requestId: string | undefined;
      let usage: ProviderUsage | undefined;
      let finishReason: "stop" | "tool_calls" | undefined;
      let terminalFailure:
        | { code: "PROVIDER_INCOMPLETE"; message: string }
        | undefined;

      try {
        const upstream = await client.chat.completions.create(
          toChatCompletionsRequest(request),
          { signal },
        );

        if (!isAsyncIterable(upstream)) {
          protocolError("Provider returned a non-streaming value for a streaming request.");
        }

        for await (const value of upstream) {
          const chunk = value;
          if (!isRecord(chunk)) {
            protocolError("Provider returned a non-object stream chunk.");
          }

          const chunkRequestId = optionalString(
            chunk._request_id,
            "_request_id",
          );
          if (chunkRequestId !== undefined) {
            requestId = chunkRequestId;
          }

          if (chunk.usage !== undefined && chunk.usage !== null) {
            usage = parseUsage(chunk.usage);
          }

          if (!Array.isArray(chunk.choices)) {
            protocolError("Provider returned an invalid choices field.");
          }

          if (chunk.choices.length === 0) {
            continue;
          }

          if (chunk.choices.length > 1) {
            protocolError("Provider returned multiple choices.");
          }

          if (finishReason !== undefined || terminalFailure !== undefined) {
            protocolError("Provider returned stream data after a terminal choice.");
          }

          const choice = chunk.choices[0];
          if (!isRecord(choice)) {
            protocolError("Provider returned an invalid choice.");
          }

          const choiceIndex = choice.index;
          if (!isNonNegativeInteger(choiceIndex)) {
            protocolError("Provider returned an invalid choice index.");
          }

          if (!isRecord(choice.delta)) {
            protocolError("Provider returned an invalid delta.");
          }

          if (!("finish_reason" in choice)) {
            protocolError("Provider choice is missing finish_reason.");
          }

          const delta = choice.delta;
          const text = optionalString(delta.content, "content", true);
          if (text !== undefined) {
            textParts.push(text);
            if (text.length > 0) {
              hadSemanticOutput = true;
              yield {
                type: "text-delta",
                textDelta: text,
              };
            }
          }

          const reasoning = optionalString(
            delta.reasoning_content,
            "reasoning_content",
            true,
          );
          if (reasoning !== undefined) {
            reasoningParts.push(reasoning);
            if (reasoning.length > 0) {
              hadSemanticOutput = true;
              yield {
                type: "reasoning-delta",
                textDelta: reasoning,
              };
            }
          }

          if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
            if (!Array.isArray(delta.tool_calls)) {
              protocolError("Provider returned an invalid tool_calls field.");
            }

            const indexesInChunk = new Set<number>();
            for (const toolCallDelta of delta.tool_calls) {
              if (!isRecord(toolCallDelta)) {
                protocolError("Provider returned an invalid tool call delta.");
              }

              const index = toolCallDelta.index;
              if (!isNonNegativeInteger(index)) {
                protocolError("Provider returned an invalid tool call index.");
              }

              if (indexesInChunk.has(index)) {
                protocolError("Provider returned a duplicate tool call index.");
              }
              indexesInChunk.add(index);

              if (
                toolCallDelta.type !== undefined &&
                toolCallDelta.type !== "function"
              ) {
                protocolError("Provider returned an unsupported tool call type.");
              }

              const wireFunction = toolCallDelta.function;
              if (wireFunction !== undefined) {
                if (wireFunction === null || !isRecord(wireFunction)) {
                  protocolError(
                    "Provider returned an invalid tool call function.",
                  );
                }
              }

              const id = optionalString(toolCallDelta.id, "tool call id");
              const name =
                wireFunction === undefined
                  ? undefined
                  : optionalString(
                      wireFunction.name,
                      "tool call name",
                    );
              const argumentsDelta =
                wireFunction === undefined
                  ? undefined
                  : optionalString(
                      wireFunction.arguments,
                      "tool call arguments",
                      true,
                    );

              const current = toolCalls.get(index) ?? {
                arguments: "",
              };

              if (id !== undefined) {
                if (current.id !== undefined && current.id !== id) {
                  protocolError("Provider changed a tool call id.");
                }
                current.id = id;
              }

              if (name !== undefined) {
                if (current.name !== undefined && current.name !== name) {
                  protocolError("Provider changed a tool call name.");
                }
                current.name = name;
              }

              current.arguments += argumentsDelta ?? "";
              toolCalls.set(index, current);
              hadSemanticOutput = true;

              yield {
                type: "tool-call-delta",
                index,
                ...(id === undefined ? {} : { id }),
                ...(name === undefined ? {} : { name }),
                argumentsDelta: argumentsDelta ?? "",
              };
            }
          }

          const rawFinishReason = choice.finish_reason;
          if (rawFinishReason === null || rawFinishReason === undefined) {
            continue;
          }

          if (typeof rawFinishReason !== "string") {
            protocolError("Provider returned an invalid finish_reason.");
          }

          if (
            rawFinishReason === "stop" ||
            rawFinishReason === "tool_calls"
          ) {
            finishReason = rawFinishReason;
            continue;
          }

          if (
            rawFinishReason !== "length" &&
            rawFinishReason !== "content_filter" &&
            rawFinishReason !== "function_call" &&
            rawFinishReason !== "insufficient_system_resource"
          ) {
            protocolError("Provider returned an invalid finish_reason.");
          }

          terminalFailure = {
            code: "PROVIDER_INCOMPLETE",
            message: "Provider ended the response before completion.",
          };
        }
      } catch (error) {
        yield {
          type: "response-error",
          failure: failureFromError(error, hadSemanticOutput),
        };
        return;
      }

      if (terminalFailure !== undefined) {
        yield {
          type: "response-error",
          failure: {
            ...terminalFailure,
            hadSemanticOutput,
          },
        };
        return;
      }

      if (finishReason === undefined) {
        yield {
          type: "response-error",
          failure: {
            code: "PROVIDER_PROTOCOL",
            message: "Provider stream ended without a terminal choice.",
            hadSemanticOutput,
          },
        };
        return;
      }

      try {
        yield {
          type: "response-complete",
          response: buildResponse(
            finishReason,
            textParts.join(""),
            reasoningParts.join(""),
            buildToolCalls(toolCalls),
            usage,
            requestId,
          ),
        };
      } catch (error) {
        yield {
          type: "response-error",
          failure: failureFromError(error, hadSemanticOutput),
        };
      }
    },
    async complete(
      request: ProviderRequest,
      signal: AbortSignal,
    ): Promise<ProviderResponse | ProviderFailure> {
      if (signal.aborted) {
        return {
          code: "PROVIDER_ABORT",
          message: "Provider request was aborted.",
          hadSemanticOutput: false,
        };
      }
      try {
        const response = await client.chat.completions.create(
          toChatCompletionsRequest(request, false),
          { signal },
        );
        return parseNonStreamingResponse(response);
      } catch (error) {
        return failureFromError(error, false);
      }
    },
  };
}

export function createOpenAICompletionAdapter(
  clientFactory: OpenAIClientFactory = createOpenAIClient,
): ProviderAdapter {
  return {
    type: "openai-completion",
    defaultBaseURL: DEFAULT_BASE_URL,
    createClient(config: ResolvedProviderConfig): ProviderClient {
      return createClient(config, clientFactory);
    },
  };
}

export const openAICompletionProvider: ProviderAdapter =
  createOpenAICompletionAdapter();
