import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  estimateToolsTokens,
  latestCompactionCheckpoint,
  modelContextMessages,
  selectRecentTailStart,
  serializeCompactionInput,
} from "./context.js";
import type { JsonValue } from "./json.js";
import {
  createErrorToolResult,
  type ToolResult,
} from "./tool-result.js";
import type {
  CompletionMessage,
  ProviderClient,
  ProviderFailure,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ReasoningEffort,
  ProviderToolDefinition,
  ProviderToolCall,
  ProviderUsage,
} from "./provider.js";
import type {
  SessionCompactionRecord,
  SessionRecord,
  SessionStore,
  SessionTranscript,
} from "./session.js";

export const CANONICAL_SYSTEM_PROMPT = `You are Susan, a terminal coding agent operating inside a minimal personal Harness.

Session working directory: {cwd}

Operating rules:
- Work within the user's requested scope. Yolo means Tool Calls execute immediately without approval; it does not authorize expanding that scope. Keep answers, explanations, and diagnoses read-only unless the user also asks for changes. Do not perform destructive actions or cause external side effects unless explicitly requested.
- Inspect the actual files and system state before drawing conclusions. Never guess file contents, command results, or whether an action succeeded.
- Prefer the dedicated Tool for each job: read for known file contents, ls for a directory's direct children, find for path names, grep for file contents, edit for precise replacements, and write for creation or intentional whole-file replacement. Use bash only when the task requires real Bash semantics, program execution, or behavior the dedicated Tools cannot express.
- Resolve relative Tool paths against the Session cwd. The cwd boundary is visible context, not a sandbox: operations outside it still execute with Susan's process permissions and must remain within the user's authorized scope.
- Treat Tool Result errors, truncation, and Traversal Diagnostics as limits on what has been confirmed. Correct an actionable failure or use an appropriate alternative, but do not repeat an unchanged failed call. Follow nextArguments only when the omitted content matters to the task.
- Before changing a file, inspect the relevant existing content. After making changes, verify the outcome in proportion to its risk. If verification is incomplete or impossible, say so explicitly.
- Do not intentionally read, display, repeat, or place secrets such as API keys, tokens, or credentials in commands, responses, or diagnostic output. Prefer existing credential stores or environment-based authentication that does not reveal the value. If a task requires handling a raw secret, ask the user to do that through a channel not visible to the model.
- Gather facts with read-only Tools before asking the user. Make reasonable, stated assumptions for reversible work within scope; ask when a missing choice would materially change the result, expand authority, or create a difficult-to-recover effect.
- Respond in the user's language. Lead with the outcome, then briefly report material changes, verification, and any remaining uncertainty. Be concise and direct.`;

export function buildSystemPrompt(cwd: string): string {
  return CANONICAL_SYSTEM_PROMPT.replace("{cwd}", () => cwd);
}

export type HarnessTool = ProviderToolDefinition & {
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult>;
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

export type { ReasoningEffort };

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
  | { readonly type: "retry" }
  | { readonly type: "interrupt" }
  | {
      readonly type: "configure-model";
      readonly provider: ProviderClient;
      readonly model: string;
      readonly reasoningEffort: ReasoningEffort;
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
    | "HARNESS_MODEL_CONFIG_INCOMPLETE"
    | "CONTEXT_TOO_LARGE";
  readonly message: string;
  readonly providerFailure?: ProviderFailure;
  readonly estimates?: {
    readonly systemPrompt: number;
    readonly tools: number;
    readonly currentUserTurn: number;
  };
};

export type HarnessCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: HarnessError };

export type HarnessOptions = {
  readonly provider?: ProviderClient;
  readonly sessionStore: SessionStore;
  readonly session: SessionTranscript;
  readonly model?: string;
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
  dispatch(command: HarnessCommand): Promise<HarnessCommandResult>;
  getSnapshot(): HarnessSnapshot;
  subscribe(listener: (event: HarnessEvent) => void): () => void;
};

function restoredPending(
  messages: readonly CompletionMessage[],
): PendingAgentLoop | null {
  const last = messages.at(-1);
  if (
    last === undefined ||
    (last.role === "assistant" &&
      (last.toolCalls === undefined || last.toolCalls.length === 0))
  ) {
    return null;
  }
  return { reason: "restored" };
}

function restoredToolBatch(
  messages: readonly CompletionMessage[],
): { readonly remaining: readonly ProviderToolCall[] } | undefined {
  const lastUserIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  let assistantIndex = -1;
  for (let index = messages.length - 1; index > lastUserIndex; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "assistant" &&
      (message.toolCalls?.length ?? 0) > 0
    ) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) {
    return undefined;
  }
  const assistant = messages[assistantIndex];
  if (assistant?.role !== "assistant" || assistant.toolCalls === undefined) {
    return undefined;
  }
  const completed = new Set(
    messages
      .slice(assistantIndex + 1)
      .filter((message) => message.role === "tool")
      .map((message) => message.toolCallId),
  );
  const remaining = assistant.toolCalls.filter(
    (toolCall) => !completed.has(toolCall.id),
  );
  return remaining.length === 0 ? undefined : { remaining };
}

function providerProtocolFailure(message: string): ProviderFailure {
  return {
    code: "PROVIDER_PROTOCOL",
    message,
    hadSemanticOutput: false,
  };
}

function withoutProviderFailureCause(failure: ProviderFailure): ProviderFailure {
  const { cause: _cause, ...safe } = failure;
  return safe;
}

function isRetryableProviderFailure(failure: ProviderFailure): boolean {
  if (failure.hadSemanticOutput) {
    return false;
  }
  if (
    failure.code === "PROVIDER_NETWORK" ||
    failure.code === "PROVIDER_TIMEOUT"
  ) {
    return true;
  }
  if (failure.code !== "PROVIDER_HTTP") {
    return false;
  }
  const status = failure.httpStatus;
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  );
}

const systemClock: HarnessClock = {
  sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(new DOMException("The wait was aborted.", "AbortError"));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  },
};

type UsageBaseline = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly messageCount: number;
};

function restoreUsageBaseline(
  records: readonly SessionRecord[],
): UsageBaseline | undefined {
  let baseline: UsageBaseline | undefined;
  let messageCount = 0;
  for (const record of records) {
    if (record.type === "message") {
      messageCount += 1;
    } else if (record.type === "usage") {
      baseline = {
        inputTokens: record.usage.inputTokens,
        outputTokens: record.usage.outputTokens,
        messageCount,
      };
    } else if (record.type === "compaction") {
      baseline = undefined;
    }
  }
  return baseline;
}

export function createHarness(options: HarnessOptions): Harness {
  const messages = [...options.session.messages];
  const toolDefinitions = options.tools.map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
  const listeners = new Set<(event: HarnessEvent) => void>();
  let checkpoint = latestCompactionCheckpoint(options.session.records);
  let usageBaseline: UsageBaseline | undefined =
    restoreUsageBaseline(options.session.records);
  let sessionTotalTokens = options.session.records.reduce(
    (total, record) =>
      record.type === "usage"
        ? total + record.usage.inputTokens + record.usage.outputTokens
        : total,
    0,
  );
  let sessionInputTokens = options.session.records.reduce(
    (total, record) =>
      record.type === "usage" ? total + record.usage.inputTokens : total,
    0,
  );
  let sessionCachedInputTokens = options.session.records.reduce(
    (total, record) =>
      record.type === "usage"
        ? total + (record.usage.cachedInputTokens ?? 0)
        : total,
    0,
  );
  let pending = restoredPending(messages);
  let status: HarnessStatus = pending === null ? "idle" : "pending";
  let activeRunController: AbortController | undefined;
  let pendingToolBatch = restoredToolBatch(messages);
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  let provider = options.provider;
  let model = options.model;
  let reasoningEffort = options.reasoningEffort;
  let contextWindow = options.contextWindow;
  let maxOutputTokens = options.maxOutputTokens;

  const activeModelConfigurationError = (): HarnessError | null => {
    if (provider !== undefined && model !== undefined && reasoningEffort !== undefined) {
      return null;
    }
    return {
      code: "HARNESS_MODEL_CONFIG_INCOMPLETE",
      message: "Active Model Configuration is incomplete.",
    };
  };

  const currentUsageAudit = (): {
    readonly model: string;
    readonly reasoningEffort: ReasoningEffort;
  } => ({ model: model!, reasoningEffort: reasoningEffort! });

  const emit = (event: HarnessEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const appendMessage = async (
    message: CompletionMessage,
  ): Promise<HarnessCommandResult> => {
    const result = await options.sessionStore.appendMessage(
      options.session.header.id,
      message,
    );
    if (!result.ok) {
      status = "failed";
      pending = null;
      const failed: HarnessCommandResult = {
        ok: false,
        error: { code: "HARNESS_SESSION", message: result.error.message },
      };
      emit({ type: "harness-failed", error: failed.error });
      return failed;
    }
    messages.push(message);
    return { ok: true };
  };

  const appendProviderUsage = async (
    usage: ProviderUsage | undefined,
    modelConfiguration:
      | { readonly model: string; readonly reasoningEffort: ReasoningEffort }
      | undefined,
  ): Promise<HarnessCommandResult> => {
    if (usage === undefined) {
      return { ok: true };
    }
    const result = await options.sessionStore.appendUsage(
      options.session.header.id,
      usage,
      modelConfiguration,
    );
    if (!result.ok) {
      status = "failed";
      pending = null;
      const failed: HarnessCommandResult = {
        ok: false,
        error: { code: "HARNESS_SESSION", message: result.error.message },
      };
      emit({ type: "harness-failed", error: failed.error });
      return failed;
    }
    sessionTotalTokens += usage.inputTokens + usage.outputTokens;
    sessionInputTokens += usage.inputTokens;
    sessionCachedInputTokens += usage.cachedInputTokens ?? 0;
    emit({
      type: "session-usage-updated",
      sessionTotalTokens,
      sessionInputTokens,
      sessionCachedInputTokens,
      contextWindow,
      contextTokens: estimateCurrentContext(),
    });
    return { ok: true };
  };

  const contextTooLarge = (): HarnessError => {
    const systemPrompt = estimateTextTokens(
      buildSystemPrompt(options.session.header.cwd),
    );
    const tools = estimateToolsTokens(toolDefinitions);
    const lastUserIndex = messages.findLastIndex(
      (message) => message.role === "user",
    );
    const currentUserTurn = estimateMessagesTokens(
      messages.slice(Math.max(0, lastUserIndex)),
    );
    return {
      code: "CONTEXT_TOO_LARGE",
      message: "The canonical runtime context and current user turn exceed the model context window.",
      estimates: { systemPrompt, tools, currentUserTurn },
    };
  };

  const failContext = (error: HarnessError): HarnessCommandResult => {
    status = "pending";
    pending = { reason: "provider-failure" };
    emit({ type: "compaction-failed", message: error.message });
    return { ok: false, error };
  };

  const estimateCurrentContext = (): number => {
    if (usageBaseline !== undefined) {
      return (
        usageBaseline.inputTokens +
        usageBaseline.outputTokens +
        estimateMessagesTokens(
          messages.slice(usageBaseline.messageCount + 1),
        )
      );
    }
    if (messages.length === 0) {
      return 0;
    }
    return (
      estimateTextTokens(buildSystemPrompt(options.session.header.cwd)) +
      estimateToolsTokens(toolDefinitions) +
      estimateMessagesTokens(modelContextMessages(messages, checkpoint))
    );
  };

  const currentTurnFits = (): boolean => {
    const estimates = contextTooLarge().estimates!;
    const reserve = Math.max(maxOutputTokens, 16_384);
    return (
      estimates.systemPrompt +
        estimates.tools +
        estimates.currentUserTurn <
      contextWindow - reserve
    );
  };

  const compactContext = async (
    force = false,
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly error: HarnessError }
  > => {
    const reserve = Math.max(maxOutputTokens, 16_384);
    const tokensBefore = estimateCurrentContext();
    if (!force && tokensBefore < contextWindow - reserve) {
      return { ok: true };
    }
    if (!currentTurnFits()) {
      return { ok: false, error: contextTooLarge() };
    }

    const minimumStart = checkpoint?.firstKeptMessageIndex ?? 0;
    const tailTarget = Math.min(
      20_000,
      Math.max(
        0,
        contextWindow -
          reserve -
          estimateTextTokens(buildSystemPrompt(options.session.header.cwd)) -
          estimateToolsTokens(toolDefinitions),
      ),
    );
    const firstKeptMessageIndex = selectRecentTailStart(
      messages,
      minimumStart,
      tailTarget,
    );
    if (firstKeptMessageIndex <= minimumStart) {
      return { ok: false, error: contextTooLarge() };
    }
    const compactedMessages = messages.slice(
      minimumStart,
      firstKeptMessageIndex,
    );
    const complete = provider!.complete;
    const summaryRequest: ProviderRequest = {
      model: model!,
      reasoningEffort: reasoningEffort,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(options.session.header.cwd),
        },
        {
          role: "user",
          content: serializeCompactionInput(
            checkpoint?.summary,
            compactedMessages,
          ),
        },
      ],
    };
    let summaryResult: ProviderResponse | ProviderFailure = {
      code: "PROVIDER_PROTOCOL",
      message: "Compaction summary retry state is invalid.",
      hadSemanticOutput: false,
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        summaryResult = await complete.call(
          provider!,
          summaryRequest,
          activeRunController?.signal ?? new AbortController().signal,
        );
      } catch {
        summaryResult = {
          code: "PROVIDER_NETWORK",
          message: "Compaction summary request failed.",
          hadSemanticOutput: false,
        };
      }
      if (!("code" in summaryResult)) {
        break;
      }
      if (attempt === 2 || !isRetryableProviderFailure(summaryResult)) {
        break;
      }
      const retry = (attempt + 1) as 1 | 2;
      const baseDelay = retry === 1 ? 1_000 : 2_000;
      const retryAfter = summaryResult.retryAfterMs;
      const delayMs =
        retryAfter !== undefined &&
        Number.isFinite(retryAfter) &&
        retryAfter >= 0
          ? Math.min(30_000, retryAfter)
          : Math.round(baseDelay * (0.8 + random() * 0.4));
      emit({
        type: "provider-retrying",
        retry,
        maxRetries: 2,
        delayMs,
        failure: summaryResult,
      });
      try {
        await clock.sleep(delayMs, activeRunController?.signal);
      } catch {
        summaryResult = {
          code: "PROVIDER_ABORT",
          message: "Compaction summary request was aborted.",
          hadSemanticOutput: false,
        };
        break;
      }
    }
    if (!("code" in summaryResult)) {
      const appendedUsage = await appendProviderUsage(
        summaryResult.usage,
        currentUsageAudit(),
      );
      if (!appendedUsage.ok) {
        return { ok: false, error: appendedUsage.error };
      }
    }
    if (
      "code" in summaryResult ||
      summaryResult.finishReason !== "stop" ||
      (summaryResult.assistant.toolCalls?.length ?? 0) > 0 ||
      (summaryResult.assistant.content?.length ?? 0) === 0
    ) {
      const message =
        "code" in summaryResult
          ? summaryResult.message
          : "Compaction summary returned no valid summary.";
      return {
        ok: false,
        error: { code: "HARNESS_COMPACTION", message },
      };
    }

    const candidate: SessionCompactionRecord = {
      type: "compaction",
      summary: summaryResult.assistant.content!,
      firstKeptMessageIndex,
      tokensBefore,
      tokensAfterEstimate: 0,
      createdAt: new Date().toISOString(),
    };
    const tokensAfterEstimate =
      estimateTextTokens(buildSystemPrompt(options.session.header.cwd)) +
      estimateToolsTokens(toolDefinitions) +
      estimateMessagesTokens(modelContextMessages(messages, candidate));
    const completedCheckpoint: SessionCompactionRecord = {
      ...candidate,
      tokensAfterEstimate,
    };
    const appended = await options.sessionStore.appendCompaction(
      options.session.header.id,
      completedCheckpoint,
    );
    if (!appended.ok) {
      return {
        ok: false,
        error: { code: "HARNESS_SESSION", message: appended.error.message },
      };
    }
    checkpoint = completedCheckpoint;
    usageBaseline = undefined;
    emit({
      type: "context-compacted",
      tokensBefore,
      tokensAfterEstimate,
      contextTokens: tokensAfterEstimate,
    });
    return { ok: true };
  };

  const requestProvider = async (
    overflowRecoveryAvailable = true,
    skipPreflight = false,
  ): Promise<
    | { readonly ok: true; readonly response: ProviderResponse }
    | {
        readonly ok: false;
        readonly failure?: ProviderFailure;
        readonly interruptedResponse?: InterruptedResponse;
        readonly contextError?: HarnessError;
      }
  > => {
    if (!skipPreflight) {
      const prepared = await compactContext();
      if (!prepared.ok) {
        return { ok: false, contextError: prepared.error };
      }
    }
    const request: ProviderRequest = {
      model: model!,
      reasoningEffort: reasoningEffort,
      messages: [
        { role: "system", content: buildSystemPrompt(options.session.header.cwd) },
        ...modelContextMessages(messages, checkpoint),
      ],
      ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let terminal: ProviderResponse | ProviderFailure | undefined;
      let hadSemanticOutput = false;
      const textParts: string[] = [];
      const reasoningParts: string[] = [];
      try {
        const signal = activeRunController?.signal ?? new AbortController().signal;
        for await (const event of provider!.stream(request, signal)) {
          if (event.type === "response-complete") {
            terminal = event.response;
          } else if (event.type === "response-error") {
            terminal = event.failure;
          } else {
            if (
              (event.type === "text-delta" && event.textDelta.length > 0) ||
              (event.type === "reasoning-delta" && event.textDelta.length > 0) ||
              event.type === "tool-call-delta"
            ) {
              hadSemanticOutput = true;
            }
            if (event.type === "text-delta") {
              textParts.push(event.textDelta);
            } else if (event.type === "reasoning-delta") {
              reasoningParts.push(event.textDelta);
            }
            emit(event);
          }
        }
      } catch {
        terminal = activeRunController?.signal.aborted
          ? {
              code: "PROVIDER_ABORT",
              message: "Provider request was aborted.",
              hadSemanticOutput,
            }
          : {
              code: "PROVIDER_NETWORK",
              message: "Provider network request failed.",
              hadSemanticOutput,
            };
      }
      if (terminal === undefined) {
        terminal = providerProtocolFailure(
          "Provider stream ended without a terminal event.",
        );
      }
      if (!("code" in terminal)) {
        if (terminal.usage !== undefined) {
          usageBaseline = {
            inputTokens: terminal.usage.inputTokens,
            outputTokens: terminal.usage.outputTokens,
            messageCount: messages.length,
          };
        }
        return { ok: true, response: terminal };
      }

      const failure = withoutProviderFailureCause(
        hadSemanticOutput
          ? { ...terminal, hadSemanticOutput: true }
          : terminal,
      );
      if (
        failure.contextOverflow === true &&
        !failure.hadSemanticOutput &&
        overflowRecoveryAvailable
      ) {
        const compacted = await compactContext(true);
        if (!compacted.ok) {
          return { ok: false, contextError: compacted.error };
        }
        return requestProvider(false, true);
      }
      if (attempt === 2 || !isRetryableProviderFailure(failure)) {
        const interruptedResponse = hadSemanticOutput
          ? {
              ...(textParts.length === 0
                ? {}
                : { content: textParts.join("") }),
              ...(reasoningParts.length === 0
                ? {}
                : { reasoning: reasoningParts.join("") }),
            }
          : undefined;
        return {
          ok: false,
          failure,
          ...(interruptedResponse === undefined ? {} : { interruptedResponse }),
        };
      }

      const retry = (attempt + 1) as 1 | 2;
      const baseDelay = retry === 1 ? 1_000 : 2_000;
      const jitteredDelay = Math.round(baseDelay * (0.8 + random() * 0.4));
      const retryAfter = failure.retryAfterMs;
      const delayMs =
        retryAfter !== undefined &&
        Number.isFinite(retryAfter) &&
        retryAfter >= 0
          ? Math.min(30_000, retryAfter)
          : jitteredDelay;
      emit({
        type: "provider-retrying",
        retry,
        maxRetries: 2,
        delayMs,
        failure,
      });
      try {
        await clock.sleep(delayMs, activeRunController?.signal);
      } catch {
        return {
          ok: false,
          failure: {
            code: "PROVIDER_ABORT",
            message: "Provider request was aborted.",
            hadSemanticOutput: false,
          },
        };
      }
    }

    return {
      ok: false,
      failure: providerProtocolFailure("Provider retry state is invalid."),
    };
  };

  const executeToolCall = async (
    toolCall: ProviderToolCall,
  ): Promise<
    | {
        readonly kind: "completed";
        readonly result: ToolResult;
        readonly isError: boolean;
      }
    | { readonly kind: "interrupted" }
  > => {
    if (activeRunController?.signal.aborted) {
      return { kind: "interrupted" };
    }
    const tool = options.tools.find(
      (candidate) => candidate.name === toolCall.name,
    );
    if (tool === undefined) {
      return {
        kind: "completed",
        result: createErrorToolResult("Tool is not registered."),
        isError: true,
      };
    }
    emit({ type: "tool-started", toolCall });
    const controller = new AbortController();
    const timerController = new AbortController();
    const runSignal = activeRunController?.signal;
    let interruptTool: () => void = () => {};
    const interrupted = new Promise<{ readonly type: "interrupt" }>(
      (resolve) => {
        interruptTool = () => {
          controller.abort();
          resolve({ type: "interrupt" });
        };
        if (runSignal?.aborted) {
          interruptTool();
          return;
        }
        runSignal?.addEventListener("abort", interruptTool, { once: true });
      },
    );
    try {
      const outcome = await Promise.race([
        tool.execute(toolCall.arguments, controller.signal).then(
          (value) => ({ type: "result" as const, value }),
        ),
        clock
          .sleep(10_000, timerController.signal)
          .then(() => ({ type: "timeout" as const })),
        interrupted,
      ]);
      if (runSignal?.aborted || outcome.type === "interrupt") {
        controller.abort();
        timerController.abort();
        return { kind: "interrupted" };
      }
      if (outcome.type === "timeout") {
        controller.abort();
        return {
          kind: "completed",
          result: createErrorToolResult("Tool execution timed out."),
          isError: true,
        };
      }
      timerController.abort();
      return {
        kind: "completed",
        result: outcome.value,
        isError: false,
      };
    } catch (error) {
      timerController.abort();
      return {
        kind: "completed",
        result: createErrorToolResult(
          error instanceof Error ? error.message : String(error),
        ),
        isError: true,
      };
    } finally {
      runSignal?.removeEventListener("abort", interruptTool);
    }
  };

  const interruptAgentLoop = (): HarnessCommandResult => {
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
  };

  const processToolBatch = async (
    toolCalls: readonly ProviderToolCall[],
  ): Promise<HarnessCommandResult> => {
    for (const toolCall of toolCalls) {
      const outcome = await executeToolCall(toolCall);
      if (outcome.kind === "interrupted") {
        return interruptAgentLoop();
      }
      const result = outcome.result;
      const isError = outcome.isError;
      emit({ type: "tool-completed", toolCall, result, isError });
      const appendedResult = await appendMessage({
        role: "tool",
        toolCallId: toolCall.id,
        content: result.content,
        ...(result.details === undefined
          ? {}
          : { details: result.details as JsonValue }),
        ...(isError ? { isError: true } : {}),
      });
      if (!appendedResult.ok) {
        return appendedResult;
      }
    }
    emit({ type: "tool-batch-completed", toolCalls });
    return { ok: true };
  };

  const failProvider = (result: {
    readonly failure: ProviderFailure;
    readonly interruptedResponse?: InterruptedResponse;
  }): HarnessCommandResult => {
    status = "pending";
    pending = {
      reason: result.failure.hadSemanticOutput
        ? "interrupted"
        : "provider-failure",
      failure: result.failure,
    };
    if (result.interruptedResponse !== undefined) {
      emit({
        type: "interrupted-response",
        response: result.interruptedResponse,
        failure: result.failure,
      });
    } else {
      emit({ type: "provider-failed", failure: result.failure });
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
    status = "idle";
    pending = null;
    emit({ type: "agent-loop-completed" });
    return { ok: true };
  };

  const runAgentLoop = async (): Promise<HarnessCommandResult> => {
    if (pendingToolBatch !== undefined) {
      const processed = await processToolBatch(pendingToolBatch.remaining);
      if (!processed.ok) {
        return processed;
      }
      pendingToolBatch = undefined;
    }
    while (true) {
      const providerResult = await requestProvider();
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

      const appendedUsage = await appendProviderUsage(
        providerResult.response.usage,
        currentUsageAudit(),
      );
      if (!appendedUsage.ok) {
        return appendedUsage;
      }
      const assistant = providerResult.response.assistant;
      const appendedAssistant = await appendMessage(assistant);
      if (!appendedAssistant.ok) {
        return appendedAssistant;
      }
      const toolCalls = assistant.toolCalls ?? [];
      if (toolCalls.length === 0) {
        return completeAgentLoop();
      }

      const processed = await processToolBatch(toolCalls);
      if (!processed.ok) {
        return processed;
      }
    }
  };

  return {
    async dispatch(command) {
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
        provider = command.provider;
        model = command.model;
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
      const appendedUser = await appendMessage({
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
        messages: [...messages],
        pending,
        model,
        reasoningEffort,
        contextWindow,
        contextTokens: estimateCurrentContext(),
        sessionTotalTokens,
        sessionInputTokens,
        sessionCachedInputTokens,
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
