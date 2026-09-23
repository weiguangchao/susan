import type { Usage } from "./types.js";

/** Rough count for display until a provider reports measured usage. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(new TextEncoder().encode(text).length / 4);
}

/** Share of input tokens served from the provider's cache, or null before usage arrives. */
export function cacheHitRate(usage: Usage): number | null {
  if (usage.inputTokens <= 0) return null;
  return Math.round((usage.cacheReadTokens / usage.inputTokens) * 100);
}
