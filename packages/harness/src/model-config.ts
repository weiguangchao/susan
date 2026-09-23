import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveSusanHome } from "./session/store.js";

export const DEFAULT_REASONING_EFFORT = {
  "openai-completion": { none: "none", low: "low", medium: "medium", high: "high" },
  responses: { none: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
  anthropic: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
} as const;

export type ProviderType = keyof typeof DEFAULT_REASONING_EFFORT;
export type ReasoningLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const modelSchema = z.object({
  name: z.string().min(1),
  id: z.string().min(1),
  contextWindow: z.number().int().positive(),
  outputToken: z.number().int().positive(),
  reasoningEffort: z.record(z.string(), z.string().nullable()).optional(),
});

const providerSchema = z.object({
  baseUrl: z.string().url(),
  type: z.enum(["openai-completion", "responses", "anthropic"]),
  apiKey: z.string(),
  model: z.union([modelSchema, z.array(modelSchema).min(1)]),
});

const configSchema = z.object({
  providers: z.record(z.string(), providerSchema),
});

export type ModelConfig = z.infer<typeof modelSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
export type SusanConfig = z.infer<typeof configSchema>;

export interface ModelChoice {
  providerName: string;
  provider: ProviderConfig;
  model: ModelConfig;
  efforts: Record<string, string>;
}

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

export function modelChoices(config: SusanConfig): ModelChoice[] {
  const choices: ModelChoice[] = [];
  for (const [providerName, provider] of Object.entries(config.providers)) {
    const models = Array.isArray(provider.model) ? provider.model : [provider.model];
    for (const model of models) {
      if (model.outputToken > model.contextWindow) throw new Error(`${providerName}/${model.id}: outputToken exceeds contextWindow`);
      if (choices.some((item) => item.providerName === providerName && item.model.id === model.id)) {
        throw new Error(`duplicate model ${providerName}/${model.id}`);
      }
      choices.push({ providerName, provider, model, efforts: reasoningChoices(provider.type, model.reasoningEffort) });
    }
  }
  if (!choices.length) throw new Error("config must contain at least one model");
  return choices;
}

export async function loadModelConfig(home = resolveSusanHome()): Promise<ModelChoice[] | null> {
  for (const filename of ["confg.json", "config.json"]) {
    const file = path.join(home, filename);
    let source: string;
    try { source = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(source); }
    catch { throw new Error(`invalid JSON in ${file}`); }
    const parsed = configSchema.safeParse(value);
    if (!parsed.success) throw new Error(`invalid ${file}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    return modelChoices(parsed.data);
  }
  return null;
}

export type ModelPreferences = Record<string, string>;

export async function loadModelPreferences(home = resolveSusanHome()): Promise<ModelPreferences> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(home, "model-state.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function saveModelPreferences(preferences: ModelPreferences, home = resolveSusanHome()): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "model-state.json");
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(preferences, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
