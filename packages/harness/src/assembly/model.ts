import { createProviderClient, resolveConfig } from "../config";
import type { ActiveModelSelection, ResolvedConfig } from "../core/config";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
} from "../core/provider";
import type { AssemblyConfigView } from "./types";

export function configView(config: ResolvedConfig): AssemblyConfigView {
  return {
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    defaultReasoningEffort: config.defaultReasoningEffort,
    providers: Object.entries(config.providers).map(([alias, provider]) => ({
      alias,
      type: provider.type,
      host: provider.baseURL.host,
      models: structuredClone(provider.models ?? []),
    })),
  };
}
export function modelOptions(config: ResolvedConfig) {
  const active = config.activeModel;
  return {
    provider:
      active === undefined ? undefined : createProviderClient(active.provider),
    model: active?.model,
    modelInput: active?.modelInput,
    reasoningEffort: active?.reasoningEffort,
    contextWindow: active?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    maxOutputTokens: active?.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  };
}

export function resolveModelSelection(
  config: ResolvedConfig,
  selection: ActiveModelSelection,
  configPath: string,
) {
  return resolveConfig(
    {
      defaultProvider: selection.providerAlias,
      defaultModel: selection.model,
      defaultReasoningEffort: selection.reasoningEffort,
      providers: Object.fromEntries(
        Object.entries(config.providers).map(([alias, provider]) => [
          alias,
          {
            ...provider,
            baseURL: provider.baseURL.href,
            models: provider.models?.map((model) => ({
              ...model,
              input: model.input === undefined ? undefined : [...model.input],
            })),
          },
        ]),
      ),
    },
    configPath,
  );
}
