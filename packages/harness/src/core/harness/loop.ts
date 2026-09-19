import type { ProviderFailure, ProviderToolCall, ReasoningEffort } from "../provider";
import type { CompactContext } from "./context-compaction";
import type { ProviderRequestResult } from "./provider-request";
import type { RestoredToolBatch } from "./restore";
import type { SessionState } from "./session-state";
import type {
  HarnessCommandResult,
  HarnessError,
  HarnessEvent,
  HarnessStatus,
  InterruptedResponse,
  PendingAgentLoop,
} from "./types";

type LoopSession = Pick<SessionState, "appendMessage" | "appendProviderUsage">;

export function createAgentLoop(input: {
  pendingToolBatch: () => RestoredToolBatch | undefined;
  clearPendingToolBatch: () => void;
  processToolBatch: (toolCalls: readonly ProviderToolCall[]) => Promise<HarnessCommandResult>;
  requestProvider: (overflowRecoveryAvailable?: boolean, skipPreflight?: boolean) => Promise<ProviderRequestResult>;
  sessionState: LoopSession;
  currentUsageAudit: () => { readonly model: string; readonly reasoningEffort: ReasoningEffort };
  compactContext: CompactContext;
  signal: () => AbortSignal | undefined;
  setStatus: (status: HarnessStatus) => void;
  setPending: (pending: PendingAgentLoop | null) => void;
  getStatus: () => HarnessStatus;
  emit: (event: HarnessEvent) => void;
}): () => Promise<HarnessCommandResult> {
  const failContext = (error: HarnessError): HarnessCommandResult => {
    input.setStatus("pending");
    input.setPending({ reason: "provider-failure" });
    input.emit({ type: "compaction-failed", message: error.message });
    return { ok: false, error };
  };

  const failProvider = (result: {
    readonly failure: ProviderFailure;
    readonly interruptedResponse?: InterruptedResponse;
  }): HarnessCommandResult => {
    input.setStatus("pending");
    input.setPending({
      reason: result.failure.hadSemanticOutput
        ? "interrupted"
        : "provider-failure",
      failure: result.failure,
    });
    if (result.interruptedResponse !== undefined) {
      input.emit({
        type: "interrupted-response",
        response: result.interruptedResponse,
        failure: result.failure,
      });
    } else {
      input.emit({ type: "provider-failed", failure: result.failure });
    }
    return {
      ok: false,
      error: {
        code: "HARNESS_PROVIDER",
        message: result.failure.message,
        providerFailure: result.failure,
      },
    };
  };

  const completeAgentLoop = (): HarnessCommandResult => {
    input.setStatus("idle");
    input.setPending(null);
    input.emit({ type: "agent-loop-completed" });
    return { ok: true };
  };

  return async () => {
    if (input.pendingToolBatch() !== undefined) {
      const processed = await input.processToolBatch(input.pendingToolBatch()!.remaining);
      if (!processed.ok) {
        return processed;
      }
      input.clearPendingToolBatch();
    }
    while (true) {
      const providerResult = await input.requestProvider();
      if (!providerResult.ok) {
        if (providerResult.contextError !== undefined) {
          return failContext(providerResult.contextError);
        }
        return failProvider({
          failure: providerResult.failure!,
          ...(providerResult.interruptedResponse === undefined
            ? {}
            : { interruptedResponse: providerResult.interruptedResponse }),
        });
      }

      const appendedUsage = await input.sessionState.appendProviderUsage(
        providerResult.response.usage,
        input.currentUsageAudit(),
      );
      if (!appendedUsage.ok) {
        return appendedUsage;
      }
      const assistant = providerResult.response.assistant;
      const appendedAssistant = await input.sessionState.appendMessage(assistant);
      if (!appendedAssistant.ok) {
        return appendedAssistant;
      }
      const toolCalls = assistant.toolCalls ?? [];
      if (toolCalls.length === 0) {
        if (!input.signal()?.aborted) {
          const compacted = await input.compactContext();
          if (!compacted.ok) {
            if (input.getStatus() === "failed") return compacted;
            input.emit({ type: "compaction-failed", message: compacted.error.message });
          }
        }
        return completeAgentLoop();
      }

      const processed = await input.processToolBatch(toolCalls);
      if (!processed.ok) {
        return processed;
      }
    }
  };
}
