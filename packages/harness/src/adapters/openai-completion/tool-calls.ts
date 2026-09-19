import { isJsonValue, isRecord, type JsonValue } from "@weiguangchao/susan-core";
import type { ProviderStreamEvent, ProviderToolCall } from "../../core/provider";
import {
  isNonNegativeInteger,
  optionalString,
  protocolError,
} from "./protocol";

export type ToolCallAccumulator = {
  id?: string;
  name?: string;
  arguments: string;
};

export function* applyToolCallDeltas(
  toolCalls: Map<number, ToolCallAccumulator>,
  rawDeltas: unknown,
): Generator<Extract<ProviderStreamEvent, { type: "tool-call-delta" }>> {
  if (!Array.isArray(rawDeltas)) {
    protocolError("Provider returned an invalid tool_calls field.");
  }

  const indexesInChunk = new Set<number>();
  for (const toolCallDelta of rawDeltas) {
    if (!isRecord(toolCallDelta)) {
      protocolError("Provider returned an invalid tool call delta.");
    }

    const index = toolCallDelta.index;
    if (!isNonNegativeInteger(index)) {
      protocolError("Provider returned an invalid tool call index.");
    }

    if (indexesInChunk.has(index)) {
      protocolError("Provider returned a duplicate tool call index.");
    }
    indexesInChunk.add(index);

    if (
      toolCallDelta.type !== undefined &&
      toolCallDelta.type !== "function"
    ) {
      protocolError("Provider returned an unsupported tool call type.");
    }

    const wireFunction = toolCallDelta.function;
    if (wireFunction !== undefined) {
      if (wireFunction === null || !isRecord(wireFunction)) {
        protocolError(
          "Provider returned an invalid tool call function.",
        );
      }
    }

    const id = optionalString(toolCallDelta.id, "tool call id");
    const name =
      wireFunction === undefined
        ? undefined
        : optionalString(
            wireFunction.name,
            "tool call name",
          );
    const argumentsDelta =
      wireFunction === undefined
        ? undefined
        : optionalString(
            wireFunction.arguments,
            "tool call arguments",
            true,
          );

    const current = toolCalls.get(index) ?? {
      arguments: "",
    };

    if (id !== undefined) {
      if (current.id !== undefined && current.id !== id) {
        protocolError("Provider changed a tool call id.");
      }
      current.id = id;
    }

    if (name !== undefined) {
      if (current.name !== undefined && current.name !== name) {
        protocolError("Provider changed a tool call name.");
      }
      current.name = name;
    }

    current.arguments += argumentsDelta ?? "";
    toolCalls.set(index, current);

    yield {
      type: "tool-call-delta",
      index,
      ...(id === undefined ? {} : { id }),
      ...(name === undefined ? {} : { name }),
      argumentsDelta: argumentsDelta ?? "",
    };
  }
}

export function buildToolCalls(
  accumulated: ReadonlyMap<number, ToolCallAccumulator>,
): ProviderToolCall[] {
  return [...accumulated.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, toolCall]) => {
      if (
        toolCall.id === undefined ||
        toolCall.name === undefined ||
        toolCall.id.length === 0 ||
        toolCall.name.length === 0
      ) {
        protocolError(`Provider tool call ${index} is missing id or name.`);
      }

      let argumentsValue: JsonValue;
      try {
        argumentsValue = JSON.parse(toolCall.arguments) as JsonValue;
      } catch {
        protocolError(`Provider tool call ${index} has invalid arguments JSON.`);
      }

      if (!isJsonValue(argumentsValue)) {
        protocolError(`Provider tool call ${index} has invalid arguments JSON.`);
      }

      return {
        id: toolCall.id,
        name: toolCall.name,
        arguments: argumentsValue,
      };
    });
}
