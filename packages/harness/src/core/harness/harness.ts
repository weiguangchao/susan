import { DEFAULT_COMPACTION_SETTINGS } from "../compaction/compaction";
import type { ModelInput } from "../provider";
import { systemClock } from "./clock";
import { createCompactContext } from "./context-compaction";
import { createAgentLoop } from "./loop";
import { createRequestProvider } from "./provider-request";
import { restoredPending, restoredToolBatch, type RestoredToolBatch } from "./restore";
import { createSessionState } from "./session-state";
import { createProcessToolBatch } from "./tool-batch";
import type {
  Harness,
  HarnessCommandResult,
  HarnessError,
  HarnessEvent,
  HarnessOptions,
  HarnessStatus,
  PendingAgentLoop,
} from "./types";

export function createHarness(options: HarnessOptions): Harness {
  const toolDefinitions = options.tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const listeners = new Set<(event: HarnessEvent) => void>();
  const emit = (event: HarnessEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  let pending: PendingAgentLoop | null = null;
  let status: HarnessStatus = "idle";
  let activeRunController: AbortController | undefined;
  let pendingToolBatch: RestoredToolBatch | undefined;
  let provider = options.provider;
  let model = options.model;
  let modelInput: ModelInput = options.modelInput ?? ["text"];
  let reasoningEffort = options.reasoningEffort;
  let contextWindow = options.contextWindow;
  let maxOutputTokens = options.maxOutputTokens;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...options.compaction };
  if (!Number.isSafeInteger(compactionSettings.reserveTokens) || compactionSettings.reserveTokens <= 0 ||
      !Number.isSafeInteger(compactionSettings.keepRecentTokens) || compactionSettings.keepRecentTokens < 0) {
    throw new Error("Invalid compaction token settings");
  }
  const sessionState = createSessionState({
    session: options.session,
    sessionStore: options.sessionStore,
    tools: options.tools,
    toolDefinitions,
    model: () => model,
    contextWindow: () => contextWindow,
    emit,
    markFailed(error) {
      status = "failed";
      pending = null;
      emit({ type: "harness-failed", error });
    },
  });
  pending = restoredPending(sessionState.messages());
  status = pending === null ? "idle" : "pending";
  pendingToolBatch = restoredToolBatch(sessionState.messages());

  const activeModelConfigurationError = (): HarnessError | null => {
    if (provider !== undefined && model !== undefined && reasoningEffort !== undefined) {
      return null;
    }
    return {
      code: "HARNESS_MODEL_CONFIG_INCOMPLETE",
      message: "Active Model Configuration is incomplete.",
    };
  };
  const currentUsageAudit = () => ({ model: model!, reasoningEffort: reasoningEffort! });
  const signal = () => activeRunController?.signal;
  const compactContext = createCompactContext({
    sessionState,
    provider: () => provider,
    model: () => model,
    modelInput: () => modelInput,
    reasoningEffort: () => reasoningEffort,
    maxOutputTokens: () => maxOutputTokens,
    contextWindow: () => contextWindow,
    signal,
    compactionSettings,
    clock,
    emit,
  });
  const requestProvider = createRequestProvider({
    compactContext,
    sessionState,
    provider: () => provider,
    model: () => model,
    modelInput: () => modelInput,
    reasoningEffort: () => reasoningEffort,
    tools: options.tools,
    toolDefinitions,
    cwd: options.session.header.cwd,
    signal,
    compactionSettings,
    clock,
    random,
    emit,
  });
  const processToolBatch = createProcessToolBatch({
    tools: options.tools,
    modelInput: () => modelInput,
    signal,
    clock,
    emit,
    appendMessage: (message) => sessionState.appendMessage(message),
    onInterrupted() {
      status = "pending";
      pending = { reason: "user-interrupt" };
      emit({ type: "agent-loop-interrupted" });
      return {
        ok: false,
        error: {
          code: "HARNESS_ABORTED",
          message: "Agent Loop was interrupted.",
        },
      };
    },
  });
  const runAgentLoop = createAgentLoop({
    pendingToolBatch: () => pendingToolBatch,
    clearPendingToolBatch() {
      pendingToolBatch = undefined;
    },
    processToolBatch,
    requestProvider,
    sessionState,
    currentUsageAudit,
    compactContext,
    signal,
    setStatus(next) {
      status = next;
    },
    setPending(next) {
      pending = next;
    },
    getStatus: () => status,
    emit,
  });

  return {
    compact(customInstructions) { return this.dispatch({ type: "compact", customInstructions }); },
    async dispatch(command) {
      if (command.type === "compact") {
        if (status !== "idle" && status !== "pending") return { ok: false, error: { code: "HARNESS_BUSY", message: "Harness must be idle or Pending to compact." } };
        if (pendingToolBatch) return { ok: false, error: { code: "HARNESS_BUSY", message: "Finish the pending Tool Batch before compacting." } };
        const configError = activeModelConfigurationError();
        if (configError) return { ok: false, error: configError };
        const previousStatus = status;
        status = "running";
        activeRunController = new AbortController();
        try {
          return await compactContext(true, command.customInstructions);
        } finally {
          if (status === "running") {
            status = previousStatus;
          }
          activeRunController = undefined;
        }
      }
      if (command.type === "interrupt") {
        if (
          status !== "running" ||
          activeRunController === undefined
        ) {
          return {
            ok: false,
            error: {
              code: "HARNESS_INVALID_COMMAND",
              message: "There is no active generation to interrupt.",
            },
          };
        }
        activeRunController.abort();
        return { ok: true };
      }
      if (command.type === "retry") {
        if (status !== "pending") {
          return {
            ok: false,
            error: {
              code: "HARNESS_INVALID_COMMAND",
              message: "There is no Pending Agent Loop to retry.",
            },
          };
        }
        const modelConfigurationError = activeModelConfigurationError();
        if (modelConfigurationError !== null) {
          return { ok: false, error: modelConfigurationError };
        }
        status = "running";
        pending = null;
        activeRunController = new AbortController();
        const result = await runAgentLoop();
        activeRunController = undefined;
        return result;
      }
      if (command.type === "configure-model") {
        if (status !== "idle" && status !== "pending") {
          return {
            ok: false,
            error: {
              code: "HARNESS_BUSY",
              message: "Harness must be idle or Pending to configure a model.",
            },
          };
        }
        if (provider !== command.provider || model !== command.model) sessionState.clearUsageBaseline();
        provider = command.provider;
        model = command.model;
        modelInput = command.modelInput ?? ["text"];
        reasoningEffort = command.reasoningEffort;
        contextWindow = command.contextWindow;
        maxOutputTokens = command.maxOutputTokens;
        return { ok: true };
      }
      if (status !== "idle") {
        return {
          ok: false,
          error: { code: "HARNESS_BUSY", message: "Harness is not idle." },
        };
      }
      if (command.type !== "submit" || command.content.length === 0) {
        return {
          ok: false,
          error: {
            code: "HARNESS_INVALID_COMMAND",
            message: "submit requires non-empty content.",
          },
        };
      }

      const modelConfigurationError = activeModelConfigurationError();
      if (modelConfigurationError !== null) {
        return { ok: false, error: modelConfigurationError };
      }

      status = "running";
      pending = null;
      activeRunController = new AbortController();
      const appendedUser = await sessionState.appendMessage({
        role: "user",
        content: command.content,
      });
      if (!appendedUser.ok) {
        activeRunController = undefined;
        return appendedUser;
      }

      const result = await runAgentLoop();
      activeRunController = undefined;
      return result;
    },

    getSnapshot() {
      return {
        status,
        sessionId: options.session.header.id,
        cwd: options.session.header.cwd,
        messages: [...sessionState.messages()],
        pending,
        model,
        reasoningEffort,
        contextWindow,
        contextTokens: sessionState.estimateCurrentContext(),
        sessionTotalTokens: sessionState.sessionTotalTokens(),
        sessionInputTokens: sessionState.sessionInputTokens(),
        sessionCachedInputTokens: sessionState.sessionCachedInputTokens(),
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
