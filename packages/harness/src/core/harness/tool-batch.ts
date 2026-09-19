import type { JsonValue } from "@weiguangchao/susan-core";
import { createErrorToolResult, type ToolResult } from "../tool-result";
import type { ModelInput, ProviderToolCall } from "../provider";
import type { SessionState } from "./session-state";
import type { HarnessClock, HarnessCommandResult, HarnessEvent, HarnessTool } from "./types";

export function createProcessToolBatch(input: {
  tools: readonly HarnessTool[];
  modelInput: () => ModelInput;
  signal: () => AbortSignal | undefined;
  clock: HarnessClock;
  emit: (event: HarnessEvent) => void;
  appendMessage: SessionState["appendMessage"];
  onInterrupted: () => HarnessCommandResult;
}): (toolCalls: readonly ProviderToolCall[]) => Promise<HarnessCommandResult> {
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
    if (input.signal()?.aborted) {
      return { kind: "interrupted" };
    }
    const tool = input.tools.find(
      (candidate) => candidate.name === toolCall.name,
    );
    if (tool === undefined) {
      return {
        kind: "completed",
        result: createErrorToolResult("Tool is not registered."),
        isError: true,
      };
    }
    input.emit({ type: "tool-started", toolCall });
    const controller = new AbortController();
    const timerController = new AbortController();
    const runSignal = input.signal();
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
        tool.execute(toolCall.arguments, controller.signal, { modelInput: input.modelInput() }).then(
          (value) => ({ type: "result" as const, value }),
        ),
        input.clock
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

  return async (toolCalls) => {
    for (const toolCall of toolCalls) {
      const outcome = await executeToolCall(toolCall);
      if (outcome.kind === "interrupted") {
        return input.onInterrupted();
      }
      const result = outcome.result;
      const isError = outcome.isError;
      input.emit({ type: "tool-completed", toolCall, result, isError });
      const appendedResult = await input.appendMessage({
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
    input.emit({ type: "tool-batch-completed", toolCalls });
    return { ok: true };
  };
}
