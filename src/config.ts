import { openAICompletionProvider } from "./adapters/openai-completion.js";
import {
  DEFAULT_CONFIG_PATH,
  loadConfig as loadConfigWithProviders,
  resolveConfig as resolveConfigWithProviders,
} from "./core/config.js";
import type {
  ApprovalPolicy,
  Config,
  ConfigLoadOptions,
} from "./core/config.js";
import type { ProviderAdapter, ProviderType } from "./core/provider.js";

const providerAdapters: ReadonlyMap<ProviderType, ProviderAdapter> = new Map([
  [openAICompletionProvider.type, openAICompletionProvider],
]);

export { DEFAULT_CONFIG_PATH };

export function resolveConfig(
  config: Config,
  flags: { readonly approval?: ApprovalPolicy } = {},
  configPath: string = DEFAULT_CONFIG_PATH,
) {
  return resolveConfigWithProviders(
    providerAdapters,
    config,
    flags,
    configPath,
  );
}

export function loadConfig(options: ConfigLoadOptions = {}) {
  return loadConfigWithProviders(providerAdapters, options);
}
