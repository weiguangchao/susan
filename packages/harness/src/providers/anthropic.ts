import Anthropic from "@anthropic-ai/sdk";
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

export const DEFAULT_MODEL = "claude-opus-5";

const PROVIDER_ID = "anthropic";

export interface AnthropicProviderOptions {
  providerId?: string;
  model?: string;
  maxTokens?: number;
  apiKey?: string;
  /** Point at a gateway, proxy or test double instead of api.anthropic.com. */
  baseURL?: string;
  /** low | medium | high | xhigh | max - higher means more thinking and spend. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

function toApiTools(tools: Tool[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    // Stream large tool inputs as they are generated instead of in one burst
    // at the end. The server stops validating them, so every input goes
    // through the tool's own parse() before it runs.
    eager_input_streaming: true,
  }));
}

function toApiMessages(messages: Message[], providerId = PROVIDER_ID): Anthropic.MessageParam[] {
  return messages.map((message): Anthropic.MessageParam => {
    if (message.role === "assistant") {
      // Replay our own blocks when we have them: thinking-block signatures must
      // round-trip byte for byte. Another provider's payload is meaningless
      // here, so fall through and rebuild the turn from the neutral blocks.
      if (message.raw?.provider === providerId) {
        return {
          role: "assistant",
          content: message.raw.value as Anthropic.ContentBlockParam[],
        };
      }
      const content = message.content
        .filter((block) => block.type !== "thinking")
        .map((block): Anthropic.ContentBlockParam => {
          if (block.type === "tool_use") {
            return {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            };
          }
          return { type: "text", text: block.text };
        })
        .filter((block) => block.type !== "text" || block.text.length > 0);
      return { role: "assistant", content };
    }

    return {
      role: "user",
      content: message.content.map((block): Anthropic.ContentBlockParam => {
        if (block.type === "tool_result") {
          return {
            type: "tool_result",
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError,
          };
        }
        return { type: "text", text: block.text };
      }),
    };
  });
}

function toStopReason(raw: string | null): StopReason {
  switch (raw) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
    case "pause_turn":
    case "stop_sequence":
      return raw;
    default:
      return null;
  }
}

function toUsage(usage: Anthropic.Usage): Usage {
  return {
    inputTokens: (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function toBlocks(content: Anthropic.ContentBlock[]): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      blocks.push({ type: "thinking", thinking: block.thinking });
    } else if (block.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }
  return blocks;
}

class AnthropicTurn implements TurnStream {
  readonly #stream: ReturnType<Anthropic["messages"]["stream"]>;
  readonly #providerId: string;

  constructor(stream: ReturnType<Anthropic["messages"]["stream"]>, providerId = PROVIDER_ID) {
    this.#stream = stream;
    this.#providerId = providerId;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    let liveUsage: Usage | null = null;
    for await (const event of this.#stream) {
      if (event.type === "message_start") {
        liveUsage = toUsage(event.message.usage);
        yield { type: "usage_progress", usage: liveUsage };
        continue;
      }
      if (event.type === "message_delta" && liveUsage) {
        liveUsage = { ...liveUsage, outputTokens: event.usage.output_tokens };
        yield { type: "usage_progress", usage: liveUsage };
        continue;
      }
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          yield {
            type: "tool_use_start",
            id: event.content_block.id,
            name: event.content_block.name,
          };
        }
        continue;
      }
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          yield { type: "text_delta", text: event.delta.text };
        } else if (event.delta.type === "thinking_delta") {
          yield { type: "thinking_delta", text: event.delta.thinking };
        }
      }
    }
  }

  async final(): Promise<TurnFinal> {
    const message = await this.#stream.finalMessage();
    return {
      content: toBlocks(message.content),
      raw: { provider: this.#providerId, value: message.content },
      stopReason: toStopReason(message.stop_reason),
      usage: toUsage(message.usage),
    };
  }
}

/** Claude, over the Messages API, streaming, with a manually driven loop. */
export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #maxTokens: number;
  readonly #effort?: AnthropicProviderOptions["effort"];

  constructor(options: AnthropicProviderOptions = {}) {
    this.id = options.providerId ?? PROVIDER_ID;
    this.#model = options.model ?? process.env.SUSAN_MODEL ?? DEFAULT_MODEL;
    this.#maxTokens = options.maxTokens ?? 64_000;
    this.#effort = options.effort;

    const baseURL = options.baseURL ?? process.env.ANTHROPIC_BASE_URL;
    const clientOptions: ConstructorParameters<typeof Anthropic>[0] = {};
    if (baseURL) clientOptions.baseURL = baseURL;

    if (options.apiKey) {
      clientOptions.apiKey = options.apiKey;
    } else if (
      baseURL &&
      !process.env.ANTHROPIC_API_KEY &&
      !process.env.ANTHROPIC_AUTH_TOKEN
    ) {
      // A local gateway or test double usually wants no credential, but the
      // SDK insists on one. Only inject a placeholder here: doing it
      // unconditionally would shadow ANTHROPIC_AUTH_TOKEN and `ant auth`
      // profiles, which the SDK resolves on its own.
      clientOptions.apiKey = "not-needed";
    }

    this.#client = new Anthropic(clientOptions);
    this.label = baseURL
      ? `${this.#model} (${new URL(baseURL).host})`
      : this.#model;
  }

  stream(request: TurnRequest): TurnStream {
    const stream = this.#client.messages.stream(
      {
        model: this.#model,
        max_tokens: this.#maxTokens,
        // Stable prefix first (system, then the frozen tool list), so the cache
        // hits on every turn of a long session.
        cache_control: { type: "ephemeral" },
        system: request.system,
        thinking: { type: "adaptive", display: "summarized" },
        ...(this.#effort ? { output_config: { effort: this.#effort } } : {}),
        tools: toApiTools(request.tools),
        messages: toApiMessages(request.messages, this.id),
      },
      { signal: request.signal },
    );
    return new AnthropicTurn(stream, this.id);
  }
}

/** Human-readable explanation for why the client could not be constructed. */
export function describeAuthError(error: unknown): string | null {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Anthropic rejected the credentials. Check ANTHROPIC_API_KEY.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limited by the Anthropic API - wait a moment and retry.";
  }
  if (error instanceof Anthropic.APIError) {
    return `Anthropic API error ${error.status ?? ""}: ${error.message}`.trim();
  }
  return null;
}
