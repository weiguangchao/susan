import type { JsonObject, JsonValue } from "./json.js";
import type { ToolResultContent } from "./tool-result.js";

export type ProviderType =
  | "anthropic"
  | "openai-completion"
  | "responses";

export const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (REASONING_EFFORT_VALUES as readonly unknown[]).includes(value);
}

export const REASONING_EFFORTS: Readonly<
  Record<ProviderType, readonly ReasoningEffort[]>
> = {
  anthropic: [],
  "openai-completion": REASONING_EFFORT_VALUES,
  responses: ["minimal", "low", "medium", "high"],
};

export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 16_384;

export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
};

export type ProviderToolCall = {
  id: string;
  name: string;
  arguments: JsonValue;
};

export type AssistantMessage = {
  role: "assistant";
  content?: string;
  reasoning?: string;
  toolCalls?: readonly ProviderToolCall[];
};

export type CompletionMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | {
      role: "tool";
      toolCallId: string;
      content: ToolResultContent;
      isError?: boolean;
      details?: JsonValue;
    };

export type ProviderToolDefinition = {
  name: string;
  description: string;
  parameters: JsonObject;
};

export type ModelInput = readonly ("text" | "image")[];
export type ToolExecutionContext = { readonly modelInput?: ModelInput };

export type ProviderRequest = {
  modelInput?: ModelInput;
  model: string;
  reasoningEffort?: ReasoningEffort;
  messages: readonly CompletionMessage[];
  tools?: readonly ProviderToolDefinition[];
};

export type ProviderResponse = {
  assistant: AssistantMessage;
  finishReason: "stop" | "tool_calls";
  usage?: ProviderUsage;
  requestId?: string;
};

export type ProviderFailure = {
  code:
    | "PROVIDER_NETWORK"
    | "PROVIDER_TIMEOUT"
    | "PROVIDER_HTTP"
    | "PROVIDER_PROTOCOL"
    | "PROVIDER_INCOMPLETE"
    | "PROVIDER_ABORT";
  message: string;
  httpStatus?: number;
  requestId?: string;
  retryAfterMs?: number;
  hadSemanticOutput: boolean;
  contextOverflow?: boolean;
  cause?: unknown;
};

export type ProviderStreamEvent =
  | { type: "text-delta"; textDelta: string }
  | { type: "reasoning-delta"; textDelta: string }
  | {
      type: "tool-call-delta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta: string;
    }
  | { type: "response-complete"; response: ProviderResponse }
  | { type: "response-error"; failure: ProviderFailure };

export type ResolvedProviderConfig = {
  type: ProviderType;
  apiKey: string;
  baseURL: URL;
};

export type ProviderClient = {
  readonly type: ProviderType;
  stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderStreamEvent>;
  complete(
    request: ProviderRequest,
    signal: AbortSignal,
  ): Promise<ProviderResponse | ProviderFailure>;
};

export type ProviderAdapter = {
  readonly type: ProviderType;
  readonly defaultBaseURL: URL;
  createClient(config: ResolvedProviderConfig): ProviderClient;
};
