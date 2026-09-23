import OpenAI from "openai";
import type {
  AssistantBlock,
  Message,
  ModelProvider,
  ProviderEvent,
  StopReason,
  Tool,
  TurnFinal,
  TurnRequest,
  TurnStream,
  Usage,
} from "../types.js";

export const DEFAULT_OPENAI_MODEL = "gpt-4o";

const PROVIDER_ID = "openai";

export interface OpenAIProviderOptions {
  model?: string;
  /**
   * Any OpenAI-compatible Chat Completions endpoint: OpenAI itself, vLLM,
   * Ollama, LM Studio, DeepSeek, Together, OpenRouter, ...
   */
  baseURL?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Ask for token usage on the final stream chunk. Standard OpenAI, but some
   * older compatible servers reject the field - turn it off for those.
   */
  streamUsage?: boolean;
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

function toApiTools(tools: Tool[]): ChatTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  }));
}

/**
 * The two wire formats disagree about tool results: Anthropic batches every
 * result into one user message, OpenAI wants one `tool` message per call. One
 * of our user messages therefore expands into several here.
 */
function toApiMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (message.role === "user") {
      for (const block of message.content) {
        if (block.type === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: block.toolUseId,
            content: block.content,
          });
        }
      }
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (text) out.push({ role: "user", content: text });
      continue;
    }

    // Replay our own payload when we have it; another provider's is meaningless
    // here, so rebuild the turn from the neutral blocks instead.
    if (message.raw?.provider === PROVIDER_ID) {
      out.push(message.raw.value as ChatMessage);
      continue;
    }

    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const toolCalls = message.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        type: "function" as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      }));

    // Thinking blocks are dropped: there is no portable equivalent, and no
    // compatible server accepts another vendor's reasoning payload back.
    if (toolCalls.length > 0) {
      out.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
    } else {
      out.push({ role: "assistant", content: text });
    }
  }

  return out;
}

function toStopReason(raw: string | null | undefined, hasTools: boolean): StopReason {
  // Some compatible servers report "stop" even when they emitted tool calls,
  // so the calls themselves are the more reliable signal.
  if (hasTools) return "tool_use";
  switch (raw) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return raw ? null : "end_turn";
  }
}

function toUsage(usage: OpenAI.Completions.CompletionUsage | undefined): Usage {
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

/**
 * Tool arguments arrive as a JSON string. When it will not parse we hand the
 * raw string through as the input: the tool's schema rejects a string, and the
 * loop turns that into an error result the model can correct - which beats
 * running a tool on a silently empty object.
 */
function parseArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

interface ToolAccumulator {
  id: string;
  name: string;
  args: string;
}

class OpenAITurn implements TurnStream {
  readonly #start: () => Promise<
    AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
  >;
  #consumed = false;
  #resolve!: (final: TurnFinal) => void;
  #reject!: (error: unknown) => void;
  readonly #final: Promise<TurnFinal>;

  constructor(
    start: () => Promise<
      AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
    >,
  ) {
    this.#start = start;
    this.#final = new Promise<TurnFinal>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // The loop abandons the stream on an error without ever calling final(),
    // so keep that rejection from surfacing as an unhandled one.
    void this.#final.catch(() => {});
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    this.#consumed = true;
    const calls = new Map<number, ToolAccumulator>();
    const announced = new Set<number>();
    let text = "";
    let finishReason: string | null = null;
    let usage: OpenAI.Completions.CompletionUsage | undefined;

    try {
      const stream = await this.#start();

      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage;

        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        if (delta.content) {
          text += delta.content;
          yield { type: "text_delta", text: delta.content };
        }

        // Not part of the OpenAI schema, but the reasoning-model endpoints
        // (DeepSeek and friends) put their visible reasoning here.
        const reasoning = (delta as { reasoning_content?: unknown; reasoning?: unknown })
          .reasoning_content ??
          (delta as { reasoning?: unknown }).reasoning;
        if (typeof reasoning === "string" && reasoning) {
          yield { type: "thinking_delta", text: reasoning };
        }

        for (const call of delta.tool_calls ?? []) {
          const slot = calls.get(call.index) ?? { id: "", name: "", args: "" };
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.name += call.function.name;
          if (call.function?.arguments) slot.args += call.function.arguments;
          calls.set(call.index, slot);

          // Servers that omit the id still need one to correlate the result.
          if (!slot.id && slot.name) slot.id = `call_${call.index}_${Date.now()}`;

          if (!announced.has(call.index) && slot.id && slot.name) {
            announced.add(call.index);
            yield { type: "tool_use_start", id: slot.id, name: slot.name };
          }
        }
      }
    } catch (error) {
      this.#reject(error);
      throw error;
    }

    const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]);

    const content: AssistantBlock[] = [];
    if (text) content.push({ type: "text", text });
    for (const [, slot] of ordered) {
      content.push({
        type: "tool_use",
        id: slot.id,
        name: slot.name,
        input: parseArguments(slot.args),
      });
    }

    const rawMessage: ChatMessage =
      ordered.length > 0
        ? {
            role: "assistant",
            content: text || null,
            tool_calls: ordered.map(([, slot]) => ({
              id: slot.id,
              type: "function" as const,
              function: { name: slot.name, arguments: slot.args || "{}" },
            })),
          }
        : { role: "assistant", content: text };

    this.#resolve({
      content,
      raw: { provider: PROVIDER_ID, value: rawMessage },
      stopReason: toStopReason(finishReason, ordered.length > 0),
      usage: toUsage(usage),
    });
  }

  async final(): Promise<TurnFinal> {
    if (!this.#consumed) {
      // Nobody iterated, so nobody drove the request. Drain it here.
      for await (const _event of this) void _event;
    }
    return this.#final;
  }
}

/**
 * Any OpenAI-compatible Chat Completions endpoint.
 *
 * Streaming and function calling only - no Assistants API, no Responses API -
 * because that is the surface every compatible server actually implements.
 */
export class OpenAIProvider implements ModelProvider {
  readonly id = PROVIDER_ID;
  readonly label: string;
  readonly #client: OpenAI;
  readonly #model: string;
  readonly #maxTokens: number;
  readonly #temperature: number | undefined;
  readonly #streamUsage: boolean;

  constructor(options: OpenAIProviderOptions = {}) {
    const baseURL = options.baseURL ?? process.env.OPENAI_BASE_URL;
    this.#model =
      options.model ??
      process.env.SUSAN_OPENAI_MODEL ??
      DEFAULT_OPENAI_MODEL;
    this.#maxTokens = options.maxTokens ?? 8_192;
    this.#temperature = options.temperature;
    this.#streamUsage = options.streamUsage ?? true;

    this.#client = new OpenAI({
      // Compatible servers frequently want no key at all, but the SDK insists
      // on one being present.
      apiKey: options.apiKey ?? process.env.OPENAI_API_KEY ?? "not-needed",
      ...(baseURL ? { baseURL } : {}),
    });

    const host = baseURL ? new URL(baseURL).host : "openai";
    this.label = `${this.#model} (${host})`;
  }

  stream(request: TurnRequest): TurnStream {
    return new OpenAITurn(() =>
      this.#client.chat.completions.create(
        {
          model: this.#model,
          max_tokens: this.#maxTokens,
          ...(this.#temperature === undefined
            ? {}
            : { temperature: this.#temperature }),
          messages: toApiMessages(request.system, request.messages),
          tools: toApiTools(request.tools),
          stream: true,
          ...(this.#streamUsage
            ? { stream_options: { include_usage: true } }
            : {}),
        },
        { signal: request.signal },
      ),
    );
  }
}

/** Human-readable explanation for a failed request. */
export function describeOpenAIError(error: unknown): string | null {
  if (error instanceof OpenAI.AuthenticationError) {
    return "The endpoint rejected the credentials. Check OPENAI_API_KEY.";
  }
  if (error instanceof OpenAI.RateLimitError) {
    return "Rate limited by the endpoint - wait a moment and retry.";
  }
  if (error instanceof OpenAI.APIError) {
    return `OpenAI API error ${error.status ?? ""}: ${error.message}`.trim();
  }
  return null;
}
