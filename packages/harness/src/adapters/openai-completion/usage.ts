import { isRecord } from "@weiguangchao/susan-core";
import type { ProviderUsage } from "../../core/provider";
import { isNonNegativeInteger, protocolError } from "./protocol";

export function parseUsage(value: unknown): ProviderUsage {
  if (!isRecord(value)) {
    protocolError("Provider returned an invalid usage field.");
  }

  const inputTokens = value.prompt_tokens;
  const outputTokens = value.completion_tokens;
  const totalTokens = value.total_tokens;

  if (
    !isNonNegativeInteger(inputTokens) ||
    !isNonNegativeInteger(outputTokens) ||
    !isNonNegativeInteger(totalTokens)
  ) {
    protocolError("Provider returned invalid usage values.");
  }

  const cachedInputTokens = parseCachedInputTokens(value.prompt_tokens_details);
  if (cachedInputTokens === undefined) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
    };
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
  };
}

function parseCachedInputTokens(details: unknown): number | undefined {
  if (details === undefined || details === null) {
    return undefined;
  }
  if (!isRecord(details)) {
    protocolError("Provider returned an invalid prompt_tokens_details field.");
  }
  const cachedTokens = details.cached_tokens;
  if (cachedTokens === undefined || cachedTokens === null) {
    return undefined;
  }
  if (!isNonNegativeInteger(cachedTokens)) {
    protocolError("Provider returned an invalid cached_tokens field.");
  }
  return cachedTokens;
}
