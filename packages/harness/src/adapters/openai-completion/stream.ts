import { isRecord } from "@weiguangchao/susan-core";
import type {
  ProviderRequest,
  ProviderStreamEvent,
  ProviderUsage,
} from "../../core/provider";
import { failureFromError } from "./failures";
import {
  isNonNegativeInteger,
  optionalString,
  protocolError,
} from "./protocol";
import { toChatCompletionsRequest } from "./request";
import { buildResponse } from "./response";
import {
  applyToolCallDeltas,
  buildToolCalls,
  type ToolCallAccumulator,
} from "./tool-calls";
import { parseUsage } from "./usage";

export type ChatCompletionsClient = {
  readonly chat: {
    readonly completions: {
      create(
        body: unknown,
        options?: { readonly signal?: AbortSignal },
      ): Promise<unknown>;
    };
  };
};

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

export async function* streamChatCompletions(
  client: ChatCompletionsClient,
  request: ProviderRequest,
  signal: AbortSignal,
): AsyncGenerator<ProviderStreamEvent> {
  if (signal.aborted) {
    yield {
      type: "response-error",
      failure: {
        code: "PROVIDER_ABORT",
        message: "Provider request was aborted.",
        hadSemanticOutput: false,
      },
    };
    return;
  }

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let hadSemanticOutput = false;
  let requestId: string | undefined;
  let usage: ProviderUsage | undefined;
  let finishReason: "stop" | "tool_calls" | undefined;
  let terminalFailure:
    | { code: "PROVIDER_INCOMPLETE"; message: string }
    | undefined;

  try {
    const upstream = await client.chat.completions.create(
      toChatCompletionsRequest(request),
      { signal },
    );

    if (!isAsyncIterable(upstream)) {
      protocolError("Provider returned a non-streaming value for a streaming request.");
    }

    for await (const value of upstream) {
      const chunk = value;
      if (!isRecord(chunk)) {
        protocolError("Provider returned a non-object stream chunk.");
      }

      const chunkRequestId = optionalString(
        chunk._request_id,
        "_request_id",
      );
      if (chunkRequestId !== undefined) {
        requestId = chunkRequestId;
      }

      if (chunk.usage !== undefined && chunk.usage !== null) {
        usage = parseUsage(chunk.usage);
      }

      if (!Array.isArray(chunk.choices)) {
        protocolError("Provider returned an invalid choices field.");
      }

      if (chunk.choices.length === 0) {
        continue;
      }

      if (chunk.choices.length > 1) {
        protocolError("Provider returned multiple choices.");
      }

      if (finishReason !== undefined || terminalFailure !== undefined) {
        protocolError("Provider returned stream data after a terminal choice.");
      }

      const choice = chunk.choices[0];
      if (!isRecord(choice)) {
        protocolError("Provider returned an invalid choice.");
      }

      const choiceIndex = choice.index;
      if (!isNonNegativeInteger(choiceIndex)) {
        protocolError("Provider returned an invalid choice index.");
      }

      if (!isRecord(choice.delta)) {
        protocolError("Provider returned an invalid delta.");
      }

      if (!("finish_reason" in choice)) {
        protocolError("Provider choice is missing finish_reason.");
      }

      const delta = choice.delta;
      const text = optionalString(delta.content, "content", true);
      if (text !== undefined) {
        textParts.push(text);
        if (text.length > 0) {
          hadSemanticOutput = true;
          yield {
            type: "text-delta",
            textDelta: text,
          };
        }
      }

      const reasoning = optionalString(
        delta.reasoning_content,
        "reasoning_content",
        true,
      );
      if (reasoning !== undefined) {
        reasoningParts.push(reasoning);
        if (reasoning.length > 0) {
          hadSemanticOutput = true;
          yield {
            type: "reasoning-delta",
            textDelta: reasoning,
          };
        }
      }

      if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
        for (const event of applyToolCallDeltas(toolCalls, delta.tool_calls)) {
          hadSemanticOutput = true;
          yield event;
        }
      }

      const rawFinishReason = choice.finish_reason;
      if (rawFinishReason === null || rawFinishReason === undefined) {
        continue;
      }

      if (typeof rawFinishReason !== "string") {
        protocolError("Provider returned an invalid finish_reason.");
      }

      if (
        rawFinishReason === "stop" ||
        rawFinishReason === "tool_calls"
      ) {
        finishReason = rawFinishReason;
        continue;
      }

      if (
        rawFinishReason !== "length" &&
        rawFinishReason !== "content_filter" &&
        rawFinishReason !== "function_call" &&
        rawFinishReason !== "insufficient_system_resource"
      ) {
        protocolError("Provider returned an invalid finish_reason.");
      }

      terminalFailure = {
        code: "PROVIDER_INCOMPLETE",
        message: "Provider ended the response before completion.",
      };
    }
  } catch (error) {
    yield {
      type: "response-error",
      failure: failureFromError(error, hadSemanticOutput),
    };
    return;
  }

  if (terminalFailure !== undefined) {
    yield {
      type: "response-error",
      failure: {
        ...terminalFailure,
        hadSemanticOutput,
      },
    };
    return;
  }

  if (finishReason === undefined) {
    yield {
      type: "response-error",
      failure: {
        code: "PROVIDER_PROTOCOL",
        message: "Provider stream ended without a terminal choice.",
        hadSemanticOutput,
      },
    };
    return;
  }

  try {
    yield {
      type: "response-complete",
      response: buildResponse(
        finishReason,
        textParts.join(""),
        reasoningParts.join(""),
        buildToolCalls(toolCalls),
        usage,
        requestId,
      ),
    };
  } catch (error) {
    yield {
      type: "response-error",
      failure: failureFromError(error, hadSemanticOutput),
    };
  }
}
