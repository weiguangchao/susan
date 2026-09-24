import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAIProvider } from "../providers/openai.js";
import { ResponsesProvider } from "../providers/responses.js";
import type { ModelProvider } from "../types.js";
import type { ModelChoice } from "./schema.js";

/**
 * `effort` names one of `choice.efforts`; leave it undefined to omit the
 * reasoning field. Saved sessions compare the provider id to decide whether a
 * turn can be replayed as is, so keep its format stable.
 */
export function createProvider(choice: ModelChoice, effort?: string): ModelProvider {
  const { providerName, provider, model, efforts } = choice;
  const value = effort ? efforts[effort] : undefined;
  const providerId = `${provider.type}:${providerName}/${model.id}`;
  switch (provider.type) {
    case "anthropic":
      return new AnthropicProvider({
        providerId,
        model: model.id, baseURL: provider.baseUrl, apiKey: provider.apiKey,
        maxTokens: model.outputToken,
        ...(value ? { effort: value as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
      });
    case "responses":
      return new ResponsesProvider({
        providerId,
        model: model.id, baseURL: provider.baseUrl, apiKey: provider.apiKey,
        maxTokens: model.outputToken,
        ...(value ? { reasoningEffort: value } : {}),
      });
    case "openai-completion":
      return new OpenAIProvider({
        providerId,
        model: model.id, baseURL: provider.baseUrl, apiKey: provider.apiKey,
        maxTokens: model.outputToken,
        ...(value ? { reasoningEffort: value } : {}),
      });
  }
}
