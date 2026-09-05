import type { JsonObject, JsonValue } from "./json.js";

export type ProviderType =
  | "anthropic"
  | "openai-completion"
  | "responses";

export type ReasoningLevel = "minimal" | "low" | "medium" | "high";

export const REASONING_EFFORTS: Readonly<
  Record<ProviderType, readonly ReasoningLevel[]>
> = {
  anthropic: [],
  "openai-completion": ["minimal", "low", "medium", "high"],
  responses: ["minimal", "low", "medium", "high"],
};

export const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 16_384;

export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
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
  | { role: "tool"; toolCallId: string; content: JsonValue };

export type ProviderToolDefinition = {
  name: string;
  description: string;
  parameters: JsonObject;
};

export type ProviderRequest = {
  model: string;
  reasoningEffort?: ReasoningLevel;
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
