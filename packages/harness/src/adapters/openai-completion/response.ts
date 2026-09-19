import { isJsonValue, isRecord, type JsonValue } from "@weiguangchao/susan-core";
import type {
  ProviderFailure,
  ProviderResponse,
  ProviderToolCall,
  ProviderUsage,
} from "../../core/provider";
import { optionalString, protocolError } from "./protocol";
import { parseUsage } from "./usage";

export function parseNonStreamingResponse(value: unknown): ProviderResponse | ProviderFailure {
  if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length !== 1) {
    protocolError("Provider returned an invalid non-streaming response.");
  }
  const choice = value.choices[0];
  if (!isRecord(choice) || choice.index !== 0 || !isRecord(choice.message)) {
    protocolError("Provider returned an invalid non-streaming choice.");
  }
  if (choice.finish_reason === "length") return {
    code: "PROVIDER_INCOMPLETE", message: "Generation hit the token cap and the summary is incomplete", hadSemanticOutput: false,
  };
  if (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls") {
    protocolError("Provider returned an invalid non-streaming finish_reason.");
  }
  const content = optionalString(choice.message.content, "content", true);
  const reasoning = optionalString(
    choice.message.reasoning_content,
    "reasoning_content",
    true,
  );
  const toolCalls: ProviderToolCall[] = [];
  if (choice.message.tool_calls !== undefined && choice.message.tool_calls !== null) {
    if (!Array.isArray(choice.message.tool_calls)) {
      protocolError("Provider returned invalid non-streaming tool calls.");
    }
    for (const raw of choice.message.tool_calls) {
      if (!isRecord(raw) || !isRecord(raw.function)) {
        protocolError("Provider returned an invalid non-streaming tool call.");
      }
      const id = optionalString(raw.id, "tool call id");
      const name = optionalString(raw.function.name, "tool call name");
      const argumentsText = optionalString(
        raw.function.arguments,
        "tool call arguments",
        true,
      );
      let argumentsValue: JsonValue;
      try {
        argumentsValue = JSON.parse(argumentsText ?? "") as JsonValue;
      } catch {
        protocolError("Provider tool call has invalid arguments JSON.");
      }
      if (!isJsonValue(argumentsValue)) {
        protocolError("Provider tool call has invalid arguments JSON.");
      }
      toolCalls.push({ id: id!, name: name!, arguments: argumentsValue });
    }
  }
  return buildResponse(
    choice.finish_reason,
    content ?? "",
    reasoning ?? "",
    toolCalls,
    value.usage === undefined || value.usage === null
      ? undefined
      : parseUsage(value.usage),
    optionalString(value._request_id, "_request_id"),
  );
}

export function buildResponse(
  finishReason: "stop" | "tool_calls",
  text: string,
  reasoning: string,
  toolCalls: readonly ProviderToolCall[],
  usage: ProviderUsage | undefined,
  requestId: string | undefined,
): ProviderResponse {
  if (finishReason === "tool_calls" && toolCalls.length === 0) {
    protocolError("Provider ended with tool_calls but contained no tool calls.");
  }

  if (finishReason === "stop" && toolCalls.length > 0) {
    protocolError("Provider ended with stop but contained tool calls.");
  }

  const assistant: Record<string, unknown> = {
    role: "assistant",
  };

  if (text.length > 0) {
    assistant.content = text;
  }

  if (reasoning.length > 0) {
    assistant.reasoning = reasoning;
  }

  if (toolCalls.length > 0) {
    assistant.toolCalls = toolCalls;
  }

  const response: {
    assistant: Record<string, unknown>;
    finishReason: "stop" | "tool_calls";
    usage?: ProviderUsage;
    requestId?: string;
  } = {
    assistant,
    finishReason,
  };

  if (usage !== undefined) {
    response.usage = usage;
  }

  if (requestId !== undefined) {
    response.requestId = requestId;
  }

  return response as ProviderResponse;
}
