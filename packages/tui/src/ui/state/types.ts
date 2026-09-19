import type {
  HarnessEvent,
  HarnessSnapshot,
  HarnessStatus,
  PendingAgentLoop,
  ProviderFailure,
  ReasoningEffort,
} from "@weiguangchao/susan-harness";
import type { TuiToolCard } from "../tool-ledger";

export type TuiMessage =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | {
      readonly kind: "reasoning";
      readonly text: string;
      readonly durationMs?: number;
    }
  | { readonly kind: "interrupted"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

export type TuiCompletedOutput =
  | {
      readonly id: string;
      readonly kind: "message";
      readonly message: TuiMessage;
    }
  | {
      readonly id: string;
      readonly kind: "tool-batch";
      readonly tools: readonly TuiToolCard[];
    };

export type TuiRetry = {
  readonly reason: string;
  readonly retry: 1 | 2;
  readonly maxRetries: 2;
  readonly delayMs: number;
  readonly startedAt: number;
};

export type TuiState = {
  readonly cwd: string;
  readonly status: HarnessStatus;
  readonly messages: readonly TuiMessage[];
  readonly tools: readonly TuiToolCard[];
  readonly completedOutput: readonly TuiCompletedOutput[];
  // Covers the initial Provider wait, Tool execution, and the following Provider wait without resetting the animation.
  readonly awaitingModelAfterTools: boolean;
  readonly stream: {
    readonly text: string;
    readonly reasoning: string;
    readonly reasoningStartedAt: number | null;
    readonly reasoningEndedAt: number | null;
  } | null;
  readonly retry: TuiRetry | null;
  readonly failure: ProviderFailure | null;
  readonly pending: PendingAgentLoop | null;
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly contextWindow: number;
  readonly contextTokens: number;
  readonly sessionTotalTokens: number;
  readonly sessionInputTokens: number;
  readonly sessionCachedInputTokens: number;
  readonly notice: string | null;
  readonly input: string;
  readonly inputCursor: TuiInputCursor;
  readonly inputHistory: readonly string[];
  readonly inputHistoryIndex: number;
  readonly inputHistoryActive: boolean;
  readonly slashCommandSelectedIndex: number;
  readonly modelPickerActive: boolean;
};

export type TuiInputCursor = {
  readonly row: number;
  readonly column: number;
};

export type TuiInputKey = {
  readonly input: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly inputWidth?: number;
};

export type TuiInputIntent =
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "newline" }
  | { readonly type: "backspace" }
  | { readonly type: "move-cursor-up"; readonly inputWidth?: number }
  | { readonly type: "move-cursor-down"; readonly inputWidth?: number }
  | { readonly type: "move-cursor-left" }
  | { readonly type: "move-cursor-right" }
  | { readonly type: "move-cursor-to-line-start" }
  | { readonly type: "move-cursor-to-line-end" }
  | { readonly type: "history-previous" }
  | { readonly type: "history-next" }
  | { readonly type: "move-slash-command-selection"; readonly delta: -1 | 1 }
  | { readonly type: "submit"; readonly content: string }
  | { readonly type: "clear-input" }
  | { readonly type: "clear" }
  | { readonly type: "compact"; readonly customInstructions?: string }
  | { readonly type: "model-picker" }
  | { readonly type: "reload" }
  | { readonly type: "exit" }
  | { readonly type: "interrupt" }
  | { readonly type: "retry" }
  | { readonly type: "new-session" }
  | { readonly type: "dismiss-failure" }
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "none" };

export type TuiSubmissionIntent =
  | { readonly type: "exit" }
  | { readonly type: "clear" }
  | { readonly type: "compact"; readonly customInstructions?: string }
  | { readonly type: "model-picker" }
  | { readonly type: "reload" }
  | { readonly type: "submit"; readonly content: string };

export type TuiAction =
  | { readonly type: "harness-event"; readonly event: HarnessEvent }
  | { readonly type: "snapshot"; readonly snapshot: HarnessSnapshot }
  | { readonly type: "input-key"; readonly key: TuiInputKey }
  | { readonly type: "input-intent"; readonly intent: TuiInputIntent }
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "clear-input" }
  | { readonly type: "close-model-picker" }
  | {
      readonly type: "new-session";
      readonly snapshot: HarnessSnapshot;
      readonly inputHistory?: readonly string[];
    };
