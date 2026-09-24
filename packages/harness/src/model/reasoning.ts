export const DEFAULT_REASONING_EFFORT = {
  "openai-completion": { none: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  responses: { none: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  anthropic: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
} as const;

export type ProviderType = keyof typeof DEFAULT_REASONING_EFFORT;
export type ReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * `levels` replaces the built-in levels of `type`; an empty list means the
 * model takes no reasoning level. `overrides` then hides or remaps levels.
 */
export function reasoningChoices(
  type: ProviderType, overrides?: Record<string, string | null>, levels?: string[],
): Record<string, string> {
  const base: Record<string, string> = levels
    ? Object.fromEntries(levels.map((level) => [level, level]))
    : { ...DEFAULT_REASONING_EFFORT[type] };
  const choices = { ...base };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!(name in base)) throw new Error(`unsupported reasoning level ${name} for ${type}`);
    if (value === null) delete choices[name];
    else if (Object.values(base).includes(value)) choices[name] = value;
    else throw new Error(`unsupported reasoning value ${value} for ${type}`);
  }
  if (Object.keys(base).length && !Object.keys(choices).length) throw new Error(`${type} has no visible reasoning levels`);
  return choices;
}
