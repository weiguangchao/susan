import type { AssemblyConfigView, ConfigUpdateResult } from "@weiguangchao/susan-harness";
import { formatConfigError } from "../../core/config-error";
import type { ModelPickerCatalog } from "../model-picker";

export function modelPickerCatalog(config: AssemblyConfigView): ModelPickerCatalog {
  return {
    defaultProviderAlias: config.defaultProvider,
    preferredModel: config.defaultModel,
    preferredReasoningEffort: config.defaultReasoningEffort,
    providers: config.providers.map(({ host, ...provider }) => ({ ...provider, baseURL: host })),
  };
}

export function assemblyErrorMessage(result: Exclude<ConfigUpdateResult, { kind: "updated" }>): string {
  return result.kind === "config-error" ? formatConfigError(result.error).heading : result.error.message;
}
