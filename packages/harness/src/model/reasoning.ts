export const DEFAULT_REASONING_EFFORT = {
  "openai-completion": { none: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  responses: { none: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  anthropic: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
} as const;

export type ProviderType = keyof typeof DEFAULT_REASONING_EFFORT;
export type ReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export function reasoningChoices(type: ProviderType, overrides?: Record<string, string | null>): Record<string, string> {
  const defaults: Record<string, string> = { ...DEFAULT_REASONING_EFFORT[type] };
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (!(name in defaults)) throw new Error(`unsupported reasoning level ${name} for ${type}`);
    if (value === null) delete defaults[name];
    else if ((Object.values(DEFAULT_REASONING_EFFORT[type]) as string[]).includes(value)) defaults[name] = value;
    else throw new Error(`unsupported reasoning value ${value} for ${type}`);
  }
  if (Object.keys(defaults).length === 0) throw new Error(`${type} has no visible reasoning levels`);
  return defaults;
}
