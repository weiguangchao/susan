import { isAbsolute } from "node:path";
import { isJsonValue, isRecord } from "@weiguangchao/susan-core";
import { isReasoningEffort } from "../provider";
import type { CompletionMessage, ProviderUsage } from "../provider";
import { isToolResultContent } from "../tool-result";
import type { SessionFormatVersion, SessionHeader, SessionRecord } from "./types";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSupportedSessionFormatVersion(
  value: unknown,
): value is SessionFormatVersion {
  return value === 5;
}

export function isCompletionMessage(value: unknown): value is CompletionMessage {
  if (!isRecord(value)) {
    return false;
  }
  if (value.role === "system" || value.role === "user") {
    return typeof value.content === "string";
  }
  if (value.role === "assistant") {
    if (
      (value.content !== undefined && typeof value.content !== "string") ||
      (value.reasoning !== undefined && typeof value.reasoning !== "string")
    ) {
      return false;
    }
    if (value.toolCalls !== undefined) {
      if (!Array.isArray(value.toolCalls)) {
        return false;
      }
      return value.toolCalls.every((toolCall) => {
        if (!isRecord(toolCall)) {
          return false;
        }
        return (
          typeof toolCall.id === "string" &&
          typeof toolCall.name === "string" &&
          isJsonValue(toolCall.arguments)
        );
      });
    }
    return true;
  }
  if (value.role === "tool") {
    return (
      typeof value.toolCallId === "string" &&
      isToolResultContent(value.content) &&
      (value.isError === undefined || typeof value.isError === "boolean") &&
      (value.details === undefined || isJsonValue(value.details))
    );
  }
  return false;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isSessionHeaderShape(value: unknown): value is Omit<
  SessionHeader,
  "version"
> & { version: unknown } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "version", "id", "createdAt", "cwd"]) &&
    value.type === "session" &&
    typeof value.id === "string" &&
    UUID_PATTERN.test(value.id) &&
    typeof value.createdAt === "string" &&
    !Number.isNaN(Date.parse(value.createdAt)) &&
    typeof value.cwd === "string" &&
    isAbsolute(value.cwd)
  );
}

export function isSessionHeader(value: unknown): value is SessionHeader {
  return (
    isSessionHeaderShape(value) &&
    isSupportedSessionFormatVersion(value.version)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
  );
}

export function isProviderUsage(value: unknown): value is ProviderUsage {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens"].includes(
          key,
        ),
    ) ||
    !Object.hasOwn(value, "inputTokens") ||
    !Object.hasOwn(value, "outputTokens") ||
    !Object.hasOwn(value, "totalTokens")
  ) {
    return false;
  }
  const { inputTokens, outputTokens, totalTokens, cachedInputTokens } = value;
  return (
    isNonNegativeInteger(inputTokens) &&
    isNonNegativeInteger(outputTokens) &&
    isNonNegativeInteger(totalTokens) &&
    (cachedInputTokens === undefined || isNonNegativeInteger(cachedInputTokens))
  );
}

export function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "message") {
    return (
      hasExactKeys(value, ["type", "message"]) &&
      isCompletionMessage(value.message)
    );
  }
  if (value.type === "compaction") {
    return (
      Object.keys(value).every((key) => ["type", "summary", "firstKeptEntryId", "retainedTail", "tokensBefore", "details", "usage", "timestamp"].includes(key)) &&
      typeof value.summary === "string" &&
      typeof value.firstKeptEntryId === "string" && /^message:(0|[1-9][0-9]*)$/.test(value.firstKeptEntryId) &&
      Number.isSafeInteger(Number(value.firstKeptEntryId.slice(8))) &&
      Array.isArray(value.retainedTail) && value.retainedTail.every(isCompletionMessage) &&
      isNonNegativeInteger(value.tokensBefore) &&
      isRecord(value.details) && hasExactKeys(value.details, ["readFiles", "modifiedFiles"]) &&
      Array.isArray(value.details.readFiles) && value.details.readFiles.every((f) => typeof f === "string") &&
      Array.isArray(value.details.modifiedFiles) && value.details.modifiedFiles.every((f) => typeof f === "string") &&
      (value.usage === undefined || isProviderUsage(value.usage)) &&
      typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp))
    );
  }
  if (value.type === "usage") {
    if (!isRecord(value) || !isProviderUsage(value.usage)) {
      return false;
    }
    const hasModel = Object.hasOwn(value, "model");
    const hasReasoningEffort = Object.hasOwn(value, "reasoningEffort");
    return (
      (hasModel && hasReasoningEffort) ||
      (!hasModel && !hasReasoningEffort)
    ) &&
      (!hasModel ||
        (typeof value.model === "string" &&
          value.model.length > 0 &&
          isReasoningEffort(value.reasoningEffort))) &&
      Object.keys(value).every((key) =>
        ["type", "usage", "model", "reasoningEffort"].includes(key),
      );
  }
  return false;
}
