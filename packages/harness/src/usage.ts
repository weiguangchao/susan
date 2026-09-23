import type { Usage } from "./types.js";

/** Share of input tokens served from the provider's cache, or null before usage arrives. */
export function cacheHitRate(usage: Usage): number | null {
  if (usage.inputTokens <= 0) return null;
  return Math.round((usage.cacheReadTokens / usage.inputTokens) * 100);
}
