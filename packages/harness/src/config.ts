import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_SUSAN_HOME,
  formatSusanHomeError,
  resolveSusanHome,
} from "./core/susan-home";
import { openAICompletionProvider } from "./adapters/openai-completion";
import {
  loadConfig as loadConfigWithProviders,
  resolveConfig as resolveConfigWithProviders,
  updateConfigActiveModel as updateConfigActiveModelWithProviders,
} from "./core/config";
import type {
  Config,
  ConfigLoadOptions,
} from "./core/config";
import type { ProviderAdapter, ProviderType } from "./core/provider";
import type { ResolvedProviderConfig } from "./core/provider";

const providerAdapters: ReadonlyMap<ProviderType, ProviderAdapter> = new Map([
  [openAICompletionProvider.type, openAICompletionProvider],
]);

export {
  DEFAULT_CONFIG_PATH,
  DEFAULT_SUSAN_HOME,
  formatSusanHomeError,
  resolveSusanHome,
};

export function resolveConfig(
  config: Config,
  configPath: string = DEFAULT_CONFIG_PATH,
) {
  return resolveConfigWithProviders(
    providerAdapters,
    config,
    configPath,
  );
}

export function loadConfig(options: ConfigLoadOptions = {}) {
  return loadConfigWithProviders(providerAdapters, options);
}

export function updateConfigActiveModel(
  configPath: string,
  selection: Parameters<typeof updateConfigActiveModelWithProviders>[2],
) {
  return updateConfigActiveModelWithProviders(
    providerAdapters,
    configPath,
    selection,
  );
}

export function createProviderClient(config: ResolvedProviderConfig) {
  const adapter = providerAdapters.get(config.type);
  if (adapter === undefined) {
    throw new Error(`Provider type ${config.type} is not registered`);
  }
  return adapter.createClient(config);
}
