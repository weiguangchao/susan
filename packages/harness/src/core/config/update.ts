import type { ProviderAdapter, ProviderType } from "../provider";
import { readConfigFile, writeConfigFile } from "./file";
import { resolveConfig } from "./resolve";
import type { ActiveModelSelection, Config, ConfigResult } from "./types";

export async function updateConfigActiveModel(
  providerAdapters: ReadonlyMap<ProviderType, ProviderAdapter>,
  configPath: string,
  selection: ActiveModelSelection,
): Promise<ConfigResult> {
  const fileResult = await readConfigFile(configPath);
  if (!fileResult.ok) {
    return fileResult;
  }

  const merged: Config = {
    ...fileResult.config,
    defaultProvider: selection.providerAlias,
    defaultModel: selection.model,
    defaultReasoningEffort: selection.reasoningEffort,
  };
  const resolved = resolveConfig(providerAdapters, merged, configPath);
  if (!resolved.ok) {
    return resolved;
  }

  const written = await writeConfigFile(configPath, merged);
  if (!written.ok) {
    return written;
  }

  return resolved;
}
