import OpenAI from "openai";
import type { Message, ModelProvider, ProviderEvent, TurnFinal, TurnRequest, TurnStream, Usage } from "../types.js";

export interface ResponsesProviderOptions {
  providerId?: string;
  model: string;
  baseURL: string;
  apiKey: string;
  maxTokens: number;
  reasoningEffort?: string;
}

type Input = OpenAI.Responses.ResponseInputItem[];

function toInput(messages: Message[], providerId: string): Input {
  const input: Input = [];
  for (const message of messages) {
    if (message.role === "user") {
      for (const block of message.content) {
        if (block.type === "text") input.push({ role: "user", content: block.text });
        else input.push({ type: "function_call_output", call_id: block.toolUseId, output: block.content });
      }
      continue;
    }
    if (message.raw?.provider === providerId) {
      input.push(...message.raw.value as Input);
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") input.push({ role: "assistant", content: block.text });
      else if (block.type === "tool_use") {
        input.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      }
    }
  }
  return input;
}

function parseArguments(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { return raw; }
}

function toUsage(usage: OpenAI.Responses.Response["usage"]): Usage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
  };
}

class ResponsesTurn implements TurnStream {
  #start: () => Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
  #providerId: string;
  #final?: TurnFinal;
  #consumed = false;

  constructor(start: () => Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>, providerId: string) {
    this.#start = start;
    this.#providerId = providerId;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    this.#consumed = true;
    const announced = new Set<string>();
    let response: OpenAI.Responses.Response | undefined;
    for await (const event of await this.#start()) {
      if (event.type === "response.output_text.delta") {
        yield { type: "text_delta", text: event.delta };
      } else if (event.type === "response.reasoning_summary_text.delta") {
        yield { type: "thinking_delta", text: event.delta };
      } else if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
        if (event.item.type === "function_call" && event.item.name && !announced.has(event.item.call_id)) {
          announced.add(event.item.call_id);
          yield { type: "tool_use_start", id: event.item.call_id, name: event.item.name };
        }
      } else if (event.type === "response.completed" || event.type === "response.incomplete") {
        response = event.response;
        if (response.usage) {
          yield { type: "usage_progress", usage: toUsage(response.usage) };
        }
      } else if (event.type === "response.failed") {
        throw new Error(event.response.error?.message ?? "Responses request failed");
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }
    if (!response) throw new Error("Responses stream ended without a final response");
    const content: TurnFinal["content"] = [];
    for (const item of response.output) {
      if (item.type === "message") {
        for (const block of item.content) {
          if (block.type === "output_text") {
            content.push({ type: "text", text: block.text });
          }
        }
      } else if (item.type === "function_call") {
        content.push({ type: "tool_use", id: item.call_id, name: item.name, input: parseArguments(item.arguments) });
        if (!announced.has(item.call_id)) yield { type: "tool_use_start", id: item.call_id, name: item.name };
      }
    }
    const hasTools = content.some((block) => block.type === "tool_use");
    this.#final = {
      content,
      raw: { provider: this.#providerId, value: response.output },
      stopReason: hasTools ? "tool_use" : response.status === "incomplete" ? "max_tokens" : "end_turn",
      usage: toUsage(response.usage),
    };
  }

  async final(): Promise<TurnFinal> {
    if (!this.#consumed) for await (const _event of this) void _event;
    return this.#final!;
  }
}

export class ResponsesProvider implements ModelProvider {
  readonly id: string;
  readonly label: string;
  readonly #client: OpenAI;
  readonly #options: ResponsesProviderOptions;

  constructor(options: ResponsesProviderOptions) {
    this.id = options.providerId ?? "responses";
    this.#options = options;
    this.#client = new OpenAI({ baseURL: options.baseURL, apiKey: options.apiKey || "not-needed" });
    this.label = `${options.model} (${new URL(options.baseURL).host})`;
  }

  stream(request: TurnRequest): TurnStream {
    return new ResponsesTurn(() => this.#client.responses.create({
      model: this.#options.model,
      instructions: request.system,
      input: toInput(request.messages, this.id),
      max_output_tokens: this.#options.maxTokens,
      ...(this.#options.reasoningEffort
        ? { reasoning: { effort: this.#options.reasoningEffort as OpenAI.ReasoningEffort } }
        : {}),
      tools: request.tools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: null,
      })),
      stream: true,
    }, { signal: request.signal }), this.id);
  }
}
