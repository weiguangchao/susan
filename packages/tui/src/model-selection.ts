import {
  AnthropicProvider, OpenAIProvider, ResponsesProvider,
  saveModelPreferences,
  type ModelChoice, type ModelPreferences, type ModelProvider,
} from "@susan/harness";

const DEFAULT_SELECTION = {
  "openai-completion": "none",
  responses: "medium",
  anthropic: "high",
} as const;

export class ModelSelection {
  readonly choices: ModelChoice[];
  readonly #preferences: ModelPreferences;
  readonly #home: string;
  #index = 0;
  #effort: string;
  #saving: Promise<void> = Promise.resolve();

  constructor(choices: ModelChoice[], preferences: ModelPreferences, home: string) {
    this.choices = choices;
    this.#preferences = preferences;
    this.#home = home;
    this.#effort = this.#selectEffort(choices[0]!);
  }

  get current(): ModelChoice { return this.choices[this.#index]!; }
  get effort(): string { return this.#effort; }
  get key(): string { return `${this.current.providerName}/${this.current.model.id}`; }
  get label(): string { return `${this.current.model.name} (${this.key}) · ${this.#effort}`; }

  find(query: string): ModelChoice | undefined {
    return this.choices.find((choice) =>
      `${choice.providerName}/${choice.model.id}` === query ||
      (choice.model.id === query && this.choices.filter((item) => item.model.id === query).length === 1));
  }

  select(query: string): void {
    const choice = this.find(query);
    if (!choice) throw new Error(`unknown model ${query}`);
    this.#preferences[this.key] = this.#effort;
    this.#index = this.choices.indexOf(choice);
    this.#effort = this.#selectEffort(choice);
  }

  setEffort(name: string): void {
    if (!(name in this.current.efforts)) throw new Error(`unavailable reasoning level ${name}`);
    this.#effort = name;
    this.#preferences[this.key] = name;
  }

  save(): Promise<void> {
    const snapshot = { ...this.#preferences };
    this.#saving = this.#saving.catch(() => {}).then(() => saveModelPreferences(snapshot, this.#home));
    return this.#saving;
  }

  provider(): ModelProvider {
    const { provider, model, efforts } = this.current;
    const effort = efforts[this.#effort]!;
    const providerId = `${provider.type}:${this.key}`;
    switch (provider.type) {
      case "anthropic":
        return new AnthropicProvider({
          providerId,
          model: model.id, baseURL: provider.baseUrl, apiKey: provider.apiKey,
          maxTokens: model.outputToken,
          effort: effort as "low" | "medium" | "high" | "xhigh" | "max",
        });
      case "responses":
        return new ResponsesProvider({
          providerId,
          model: model.id, baseURL: provider.baseUrl, apiKey: provider.apiKey,
          maxTokens: model.outputToken, reasoningEffort: effort,
        });
      case "openai-completion":
        return new OpenAIProvider({
          providerId,
          model: model.id, baseURL: provider.baseUrl, apiKey: provider.apiKey,
          maxTokens: model.outputToken,
          ...(effort === "none" ? {} : { reasoningEffort: effort }),
        });
    }
  }

  #selectEffort(choice: ModelChoice): string {
    const key = `${choice.providerName}/${choice.model.id}`;
    const saved = this.#preferences[key];
    if (saved && saved in choice.efforts) return saved;
    const fallback = DEFAULT_SELECTION[choice.provider.type];
    return fallback in choice.efforts ? fallback : Object.keys(choice.efforts)[0]!;
  }
}
