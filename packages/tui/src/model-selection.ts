import {
  AnthropicProvider, OpenAIProvider, ResponsesProvider,
  saveModelPreferences,
  type ModelChoice, type ModelPreferences, type ModelProvider,
} from "@susan/harness";

const LAST_USED_MODEL = "lastUsedModel";

export class ModelSelection {
  readonly choices: ModelChoice[];
  readonly #preferences: ModelPreferences;
  readonly #home: string;
  #index = 0;
  #effort?: string;
  #saving: Promise<void> = Promise.resolve();

  constructor(choices: ModelChoice[], preferences: ModelPreferences, home: string) {
    this.choices = choices;
    this.#preferences = preferences;
    this.#home = home;
    const lastUsed = preferences[LAST_USED_MODEL];
    const savedIndex = choices.findIndex((choice) =>
      `${choice.providerName}/${choice.model.id}` === lastUsed);
    this.#index = savedIndex < 0 ? 0 : savedIndex;
    this.#effort = this.#selectEffort(this.current);
  }

  get current(): ModelChoice { return this.choices[this.#index]!; }
  get effort(): string | undefined { return this.#effort; }
  get key(): string { return `${this.current.providerName}/${this.current.model.id}`; }
  get label(): string {
    const model = `${this.current.model.name} (${this.key})`;
    return this.#effort ? `${model} · ${this.#effort}` : model;
  }

  find(query: string): ModelChoice | undefined {
    return this.choices.find((choice) =>
      `${choice.providerName}/${choice.model.id}` === query ||
      (choice.model.id === query && this.choices.filter((item) => item.model.id === query).length === 1));
  }

  select(query: string): void {
    const choice = this.find(query);
    if (!choice) throw new Error(`unknown model ${query}`);
    if (this.#effort) this.#preferences[this.key] = this.#effort;
    this.#index = this.choices.indexOf(choice);
    this.#effort = this.#selectEffort(choice);
  }

  setEffort(name: string): void {
    if (name === "default") {
      this.#effort = undefined;
      delete this.#preferences[this.key];
      return;
    }
    if (!(name in this.current.efforts)) throw new Error(`unavailable reasoning level ${name}`);
    this.#effort = name;
    this.#preferences[this.key] = name;
  }

  save(): Promise<void> {
    const snapshot = { ...this.#preferences };
    this.#saving = this.#saving.catch(() => {}).then(() => saveModelPreferences(snapshot, this.#home));
    return this.#saving;
  }

  recordUse(): Promise<void> {
    this.#preferences[LAST_USED_MODEL] = this.key;
    return this.save();
  }

  provider(): ModelProvider {
    const { provider, model, efforts } = this.current;
    const effort = this.#effort ? efforts[this.#effort] : undefined;
    const providerId = `${provider.type}:${this.key}`;
    switch (provider.type) {
      case "anthropic":
        return new AnthropicProvider({
          providerId,
          model: model.id, baseURL: provider.baseUrl, apiKey: provider.apiKey,
          maxTokens: model.outputToken,
          ...(effort ? { effort: effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
        });
      case "responses":
        return new ResponsesProvider({
          providerId,
          model: model.id, baseURL: provider.baseUrl, apiKey: provider.apiKey,
          maxTokens: model.outputToken,
          ...(effort ? { reasoningEffort: effort } : {}),
        });
      case "openai-completion":
        return new OpenAIProvider({
          providerId,
          model: model.id, baseURL: provider.baseUrl, apiKey: provider.apiKey,
          maxTokens: model.outputToken,
          ...(effort ? { reasoningEffort: effort } : {}),
        });
    }
  }

  #selectEffort(choice: ModelChoice): string | undefined {
    const key = `${choice.providerName}/${choice.model.id}`;
    const saved = this.#preferences[key];
    if (saved && saved in choice.efforts) return saved;
    return undefined;
  }
}
