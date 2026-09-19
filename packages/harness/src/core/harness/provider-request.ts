import { buildSystemPrompt } from "../system-prompt";
import { modelContextMessages } from "../context";
import type {
  ModelInput,
  ProviderClient,
  ProviderFailure,
  ProviderRequest,
  ProviderResponse,
  ProviderToolDefinition,
  ReasoningEffort,
} from "../provider";
import type { CompactionSettings } from "../compaction/compaction";
import type { CompactContext } from "./context-compaction";
import type { SessionState } from "./session-state";
import type { HarnessClock, HarnessError, HarnessEvent, HarnessTool, InterruptedResponse } from "./types";

export type ProviderRequestResult =
  | { readonly ok: true; readonly response: ProviderResponse }
  | {
      readonly ok: false;
      readonly failure?: ProviderFailure;
      readonly interruptedResponse?: InterruptedResponse;
      readonly contextError?: HarnessError;
    };

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

type RequestSession = Pick<SessionState, "messages" | "checkpoint" | "setUsageBaseline">;

export function createRequestProvider(input: {
  compactContext: CompactContext;
  sessionState: RequestSession;
  provider: () => ProviderClient | undefined;
  model: () => string | undefined;
  modelInput: () => ModelInput;
  reasoningEffort: () => ReasoningEffort | undefined;
  tools: readonly HarnessTool[];
  toolDefinitions: readonly ProviderToolDefinition[];
  cwd: string;
  signal: () => AbortSignal | undefined;
  compactionSettings: CompactionSettings;
  clock: HarnessClock;
  random: () => number;
  emit: (event: HarnessEvent) => void;
}): (overflowRecoveryAvailable?: boolean, skipPreflight?: boolean) => Promise<ProviderRequestResult> {
  const requestProvider = async (
    overflowRecoveryAvailable = true,
    skipPreflight = false,
  ): Promise<ProviderRequestResult> => {
    if (!skipPreflight) {
      const prepared = await input.compactContext();
      if (!prepared.ok) {
        return { ok: false, contextError: prepared.error };
      }
    }
    const request: ProviderRequest = {
      model: input.model()!,
      modelInput: input.modelInput(),
      reasoningEffort: input.reasoningEffort(),
      messages: [
        { role: "system", content: buildSystemPrompt(input.tools, input.cwd) },
        ...modelContextMessages(input.sessionState.messages(), input.sessionState.checkpoint()),
      ],
      ...(input.toolDefinitions.length > 0 ? { tools: input.toolDefinitions } : {}),
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let terminal: ProviderResponse | ProviderFailure | undefined;
      let hadSemanticOutput = false;
      const textParts: string[] = [];
      const reasoningParts: string[] = [];
      try {
        const signal = input.signal() ?? new AbortController().signal;
        for await (const event of input.provider()!.stream(request, signal)) {
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
            input.emit(event);
          }
        }
      } catch {
        terminal = input.signal()?.aborted
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
        if (terminal.usage !== undefined && terminal.usage.totalTokens > 0 && !input.signal()?.aborted) {
          input.sessionState.setUsageBaseline({
            model: input.model(),
            inputTokens: terminal.usage.inputTokens,
            outputTokens: terminal.usage.outputTokens,
            messageCount: input.sessionState.messages().length,
          });
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
        !input.signal()?.aborted &&
        input.compactionSettings.enabled &&
        overflowRecoveryAvailable
      ) {
        const compacted = await input.compactContext(true);
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
      const jitteredDelay = Math.round(baseDelay * (0.8 + input.random() * 0.4));
      const retryAfter = failure.retryAfterMs;
      const delayMs =
        retryAfter !== undefined &&
        Number.isFinite(retryAfter) &&
        retryAfter >= 0
          ? Math.min(30_000, retryAfter)
          : jitteredDelay;
      input.emit({
        type: "provider-retrying",
        retry,
        maxRetries: 2,
        delayMs,
        failure,
      });
      try {
        await input.clock.sleep(delayMs, input.signal());
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

  return requestProvider;
}
