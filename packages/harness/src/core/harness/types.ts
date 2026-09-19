import type { ToolResult } from "../tool-result";
import type { CompactionSettings } from "../compaction/compaction";
import type { ModelInput, ToolExecutionContext } from "../provider";
import type {
  CompletionMessage,
  ProviderClient,
  ProviderFailure,
  ProviderToolDefinition,
  ProviderToolCall,
  ReasoningEffort,
} from "../provider";
import type { SessionStore, SessionTranscript } from "../session";

export type { ReasoningEffort };

export type HarnessTool = ProviderToolDefinition & {
  execute(input: unknown, signal?: AbortSignal, context?: ToolExecutionContext): Promise<ToolResult>;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
};

export type HarnessStatus =
  | "idle"
  | "running"
  | "pending"
  | "failed";

export type PendingAgentLoop = {
  readonly reason:
    | "provider-failure"
    | "interrupted"
    | "restored"
    | "user-interrupt";
  readonly failure?: ProviderFailure;
};

export type InterruptedResponse = {
  readonly content?: string;
  readonly reasoning?: string;
};

export type HarnessSnapshot = {
  readonly status: HarnessStatus;
  readonly sessionId: string;
  readonly cwd: string;
  readonly messages: readonly CompletionMessage[];
  readonly pending: PendingAgentLoop | null;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly contextWindow: number;
  readonly contextTokens: number;
  readonly sessionTotalTokens: number;
  readonly sessionInputTokens: number;
  readonly sessionCachedInputTokens: number;
};

export type HarnessEvent =
  | { readonly type: "text-delta"; readonly textDelta: string }
  | { readonly type: "reasoning-delta"; readonly textDelta: string }
  | {
      readonly type: "tool-call-delta";
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    }
  | {
      readonly type: "tool-started";
      readonly toolCall: ProviderToolCall;
    }
  | {
      readonly type: "tool-completed";
      readonly toolCall: ProviderToolCall;
      readonly result: ToolResult;
      readonly isError: boolean;
    }
  | {
      readonly type: "tool-batch-completed";
      readonly toolCalls: readonly ProviderToolCall[];
    }
  | {
      readonly type: "context-compacted";
      readonly tokensBefore: number;
      readonly tokensAfterEstimate: number;
      readonly contextTokens: number;
    }
  | {
      readonly type: "session-usage-updated";
      readonly sessionTotalTokens: number;
      readonly sessionInputTokens: number;
      readonly sessionCachedInputTokens: number;
      readonly contextWindow: number;
      readonly contextTokens: number;
    }
  | {
      readonly type: "compaction-failed";
      readonly message: string;
    }
  | {
      readonly type: "provider-retrying";
      readonly retry: 1 | 2;
      readonly maxRetries: 2;
      readonly delayMs: number;
      readonly failure: ProviderFailure;
    }
  | { readonly type: "agent-loop-completed" }
  | {
      readonly type: "provider-failed";
      readonly failure: ProviderFailure;
    }
  | {
      readonly type: "interrupted-response";
      readonly response: InterruptedResponse;
      readonly failure: ProviderFailure;
    }
  | { readonly type: "agent-loop-interrupted" }
  | { readonly type: "harness-failed"; readonly error: HarnessError };

export type HarnessCommand =
  | {
      readonly type: "submit";
      readonly content: string;
    }
  | { readonly type: "compact"; readonly customInstructions?: string }
  | { readonly type: "retry" }
  | { readonly type: "interrupt" }
  | {
      readonly type: "configure-model";
      readonly provider?: ProviderClient;
      readonly model?: string;
      readonly modelInput?: ModelInput;
      readonly reasoningEffort?: ReasoningEffort;
      readonly contextWindow: number;
      readonly maxOutputTokens: number;
    };

export type HarnessError = {
  readonly code:
    | "HARNESS_BUSY"
    | "HARNESS_ABORTED"
    | "HARNESS_INVALID_COMMAND"
    | "HARNESS_PROVIDER"
    | "HARNESS_SESSION"
    | "HARNESS_COMPACTION"
    | "HARNESS_MODEL_CONFIG_INCOMPLETE";
  readonly message: string;
  readonly providerFailure?: ProviderFailure;
};

export type HarnessCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: HarnessError };

export type HarnessOptions = {
  readonly compaction?: Partial<CompactionSettings>;
  readonly provider?: ProviderClient;
  readonly sessionStore: SessionStore;
  readonly session: SessionTranscript;
  readonly model?: string;
  readonly modelInput?: ModelInput;
  readonly reasoningEffort?: ReasoningEffort;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly tools: readonly HarnessTool[];
  readonly clock?: HarnessClock;
  readonly random?: () => number;
};

export type HarnessClock = {
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
};

export type Harness = {
  compact(customInstructions?: string): Promise<HarnessCommandResult>;
  dispatch(command: HarnessCommand): Promise<HarnessCommandResult>;
  getSnapshot(): HarnessSnapshot;
  subscribe(listener: (event: HarnessEvent) => void): () => void;
};
