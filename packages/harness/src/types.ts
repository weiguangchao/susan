/**
 * Core vocabulary of the harness.
 *
 * Everything crossing a package boundary is defined here so the TUI never has
 * to know which model provider is behind the loop.
 */

// ---------------------------------------------------------------------------
// Conversation state (provider-neutral)
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError: boolean;
}

export type AssistantBlock = TextBlock | ThinkingBlock | ToolUseBlock;
export type UserBlock = TextBlock | ToolResultBlock;

export interface UserMessage {
  role: "user";
  content: UserBlock[];
}

/**
 * A provider's own representation of an assistant turn, kept verbatim so it can
 * be replayed exactly (thinking-block signatures survive the round trip).
 *
 * It is tagged with the producing provider: the payload is only meaningful to
 * the provider that made it, and a session can switch providers mid-flight.
 */
export interface ProviderRaw {
  provider: string;
  value: unknown;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantBlock[];
  raw?: ProviderRaw;
}

export type Message = UserMessage | AssistantMessage;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Tool impact classification, available to clients inspecting the tool list. */
export type ToolRisk = "safe" | "write" | "exec";

export interface ToolContext {
  /** Directory the agent was launched in; every path is resolved against it. */
  root: string;
  signal: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model as the tool_result content. */
  content: string;
  /** One-line summary for the UI, e.g. "read 42 lines". */
  display: string;
}

export interface Tool<Input = unknown> {
  name: string;
  description: string;
  /** JSON Schema sent to the model. */
  inputSchema: Record<string, unknown>;
  risk: ToolRisk;
  /** Validates and narrows the model's raw input; throws on bad input. */
  parse(raw: unknown): Input;
  /** One-line rendering of a call, shown in the log. */
  summarize(input: Input): string;
  run(input: Input, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Events emitted by the agent loop
// ---------------------------------------------------------------------------

export interface Usage {
  /** Total input tokens, including cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause_turn"
  | "stop_sequence"
  | null;

export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "text_end"; text: string }
  | { type: "tool_call"; id: string; name: string; summary: string }
  | { type: "tool_pending"; id: string; name: string; summary: string }
  | { type: "usage_progress"; usage: Usage; measuredTotal: Usage; estimated: boolean }
  | {
      type: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      display: string;
    }
  | { type: "usage"; usage: Usage; total: Usage }
  | { type: "turn_end"; turn: number; stopReason: StopReason }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string }
  | {
      type: "done";
      reason: "end_turn" | "max_turns" | "aborted" | "refusal" | "error";
    };

// ---------------------------------------------------------------------------
// Model provider
// ---------------------------------------------------------------------------

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  /** The reasoning block in progress is complete; the next delta starts a new one. */
  | { type: "thinking_end" }
  | { type: "usage_progress"; usage: Usage }
  | { type: "tool_use_start"; id: string; name: string };

export interface TurnFinal {
  content: AssistantBlock[];
  raw?: ProviderRaw;
  stopReason: StopReason;
  usage: Usage;
}

/** An in-flight model turn: iterate for deltas, then await the whole thing. */
export interface TurnStream extends AsyncIterable<ProviderEvent> {
  final(): Promise<TurnFinal>;
}

export interface TurnRequest {
  system: string;
  messages: Message[];
  tools: Tool[];
  signal: AbortSignal;
}

export interface ModelProvider {
  /** Stable identity, e.g. "anthropic". Tags the raw payloads it produces. */
  readonly id: string;
  /** Shown in the status bar, e.g. "claude-opus-5" or "mock". */
  readonly label: string;
  stream(request: TurnRequest): TurnStream;
}
