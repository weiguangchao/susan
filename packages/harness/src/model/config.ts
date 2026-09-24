import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveSusanHome } from "../session/store.js";
import { discoverModels } from "./discovery.js";
import { reasoningChoices } from "./reasoning.js";
import { configSchema, type ModelChoice, type ModelConfig, type SusanConfig } from "./schema.js";

/** `discovered` supplies the models of providers that do not configure `model`. */
export function modelChoices(config: SusanConfig, discovered: Record<string, ModelConfig[]> = {}): ModelChoice[] {
  const choices: ModelChoice[] = [];
  for (const [providerName, provider] of Object.entries(config.providers)) {
    const models = provider.model === undefined ? discovered[providerName] ?? []
      : Array.isArray(provider.model) ? provider.model : [provider.model];
    for (const model of models) {
      if (model.outputToken > model.contextWindow) throw new Error(`${providerName}/${model.id}: outputToken exceeds contextWindow`);
      if (choices.some((item) => item.providerName === providerName && item.model.id === model.id)) {
        throw new Error(`duplicate model ${providerName}/${model.id}`);
      }
      choices.push({ providerName, provider, model, efforts: reasoningChoices(provider.type, model.reasoningEffort, model.reasoningLevels) });
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
    const unlisted = Object.fromEntries(Object.entries(parsed.data.providers)
      .filter(([, provider]) => provider.model === undefined));
    return modelChoices(parsed.data, await discoverModels(unlisted, home));
  }
  return null;
}
