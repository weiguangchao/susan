import type { ProviderAdapter, ProviderType } from "../provider";
import { DEFAULT_MODEL_CONTEXT_WINDOW, DEFAULT_MODEL_MAX_OUTPUT_TOKENS, REASONING_EFFORTS } from "../provider";
import { DEFAULT_CONFIG_PATH } from "../susan-home";
import { configError } from "./errors";
import { configSchema, hasApprovalField, schemaIssues } from "./schema";
import type { Config, ConfigResult, ResolvedProviderEntry } from "./types";

export function resolveConfig(
  providerAdapters: ReadonlyMap<ProviderType, ProviderAdapter>,
  config: Config,
  configPath: string = DEFAULT_CONFIG_PATH,
): ConfigResult {
  if (hasApprovalField(config)) {
    return configError(configPath, "SUSAN_CONFIG_SCHEMA", [
      {
        path: "approval",
        code: "unsupported_field",
        message: "The approval field is not supported and must be removed",
      },
    ]);
  }

  const parsedResult = configSchema.safeParse(config);

  if (!parsedResult.success) {
    return configError(
      configPath,
      "SUSAN_CONFIG_SCHEMA",
      schemaIssues(parsedResult.error),
    );
  }

  const parsed = parsedResult.data;
  if (
    parsed.defaultProvider === undefined &&
    (parsed.defaultModel === undefined) !==
      (parsed.defaultReasoningEffort === undefined)
  ) {
    return configError(configPath, "SUSAN_CONFIG_SCHEMA", [
      {
        path: "defaultModel/defaultReasoningEffort",
        code: "model_preference_pair",
        message:
          "defaultModel and defaultReasoningEffort must both be omitted or both be present when defaultProvider is omitted",
      },
    ]);
  }

  const unsupportedIssues = Object.entries(parsed.providers)
    .filter(([, entry]) => !providerAdapters.has(entry.type))
    .map(([alias, entry]) => ({
      path: `providers.${alias}.type`,
      code: "provider_type_unsupported",
      message: `Provider type ${entry.type} is not registered in this version`,
    }));

  if (unsupportedIssues.length > 0) {
    return configError(
      configPath,
      "SUSAN_CONFIG_PROVIDER_TYPE_UNSUPPORTED",
      unsupportedIssues,
    );
  }

  const defaultProvider =
    parsed.defaultProvider === undefined
      ? undefined
      : parsed.providers[parsed.defaultProvider];

  if (parsed.defaultProvider !== undefined && defaultProvider === undefined) {
    return configError(configPath, "SUSAN_CONFIG_PROVIDER_UNKNOWN", [
      {
        path: `providers.${parsed.defaultProvider}`,
        code: "provider_missing",
        message: `Default provider ${parsed.defaultProvider} is not configured`,
      },
    ]);
  }

  if (defaultProvider !== undefined && defaultProvider.apiKey === undefined) {
    return configError(configPath, "SUSAN_CONFIG_API_KEY_MISSING", [
      {
        path: `providers.${parsed.defaultProvider}.apiKey`,
        code: "api_key_missing",
        message: "Default provider requires an API key",
      },
    ]);
  }

  if (
    defaultProvider !== undefined &&
    parsed.defaultModel !== undefined &&
    !(defaultProvider.models ?? []).some(
      (model) => model.id === parsed.defaultModel,
    )
  ) {
    return configError(configPath, "SUSAN_CONFIG_SCHEMA", [
      {
        path: "defaultModel",
        code: "model_missing",
        message: "defaultModel must belong to the default provider Model Catalog",
      },
    ]);
  }

  if (
    defaultProvider !== undefined &&
    parsed.defaultReasoningEffort !== undefined &&
    !REASONING_EFFORTS[defaultProvider.type].includes(
      parsed.defaultReasoningEffort,
    )
  ) {
    return configError(configPath, "SUSAN_CONFIG_SCHEMA", [
      {
        path: "defaultReasoningEffort",
        code: "reasoning_effort_unsupported",
        message:
          "defaultReasoningEffort must belong to the default provider Provider Type",
      },
    ]);
  }

  const resolvedProviders: Record<string, ResolvedProviderEntry> = {};
  for (const [alias, entry] of Object.entries(parsed.providers)) {
    resolvedProviders[alias] = {
      type: entry.type,
      apiKey: entry.apiKey,
      baseURL: new URL(
        entry.baseURL ?? providerAdapters.get(entry.type)!.defaultBaseURL,
      ),
      models: entry.models,
    };
  }

  const resolvedProvider =
    defaultProvider === undefined
      ? undefined
      : {
          type: defaultProvider.type,
          apiKey: defaultProvider.apiKey!,
          baseURL: resolvedProviders[parsed.defaultProvider!].baseURL,
        };

  const selectedModel =
    parsed.defaultModel === undefined
      ? undefined
      : defaultProvider?.models?.find(
          (model) => model.id === parsed.defaultModel,
        );
  const activeModel =
    parsed.defaultProvider === undefined ||
    parsed.defaultModel === undefined ||
    parsed.defaultReasoningEffort === undefined ||
    defaultProvider === undefined
      ? undefined
      : {
          providerAlias: parsed.defaultProvider,
          provider: resolvedProvider!,
          model: parsed.defaultModel,
          modelInput: selectedModel?.input,
          reasoningEffort: parsed.defaultReasoningEffort,
          contextWindow:
            selectedModel?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
          maxOutputTokens:
            selectedModel?.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
        };

  return {
    ok: true,
    config: {
      defaultProvider: parsed.defaultProvider,
      defaultModel: parsed.defaultModel,
      defaultReasoningEffort: parsed.defaultReasoningEffort,
      providers: resolvedProviders,
      ...(resolvedProvider === undefined ? {} : { provider: resolvedProvider }),
      ...(activeModel === undefined ? {} : { activeModel }),
    },
  };
}
