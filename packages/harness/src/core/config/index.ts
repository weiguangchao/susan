import type { ProviderAdapter, ProviderType } from "../provider";
import { DEFAULT_CONFIG_PATH } from "../susan-home";
import { readConfigFile } from "./file";
import { resolveConfig } from "./resolve";
import type { ConfigLoadOptions, ConfigResult } from "./types";

export { resolveConfig } from "./resolve";
export { updateConfigActiveModel } from "./update";
export type {
  ProviderConfigEntry,
  Config,
  ResolvedModelEntry,
  ResolvedProviderEntry,
  ActiveModelConfiguration,
  ActiveModelSelection,
  ResolvedConfig,
  ConfigIssue,
  ConfigErrorCode,
  ConfigError,
  ConfigResult,
  ConfigLoadOptions,
} from "./types";

export async function loadConfig(
  providerAdapters: ReadonlyMap<ProviderType, ProviderAdapter>,
  options: ConfigLoadOptions = {},
): Promise<ConfigResult> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const fileResult = await readConfigFile(configPath);
  if (!fileResult.ok) {
    return fileResult;
  }

  return resolveConfig(
    providerAdapters,
    fileResult.config,
    configPath,
  );
}
