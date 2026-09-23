import type {
  AssistantBlock,
  AssistantMessage,
  Message,
  ProviderRaw,
  ToolResultBlock,
  Usage,
} from "../types.js";

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
};

/**
 * The conversation so far, plus running token totals.
 *
 * The Messages API is stateless, so this is the single source of truth for what
 * gets replayed on every turn. It is append-only by design: rewriting earlier
 * turns invalidates thinking blocks on current models.
 */
export class Session {
  #messages: Message[] = [];
  #usage: Usage = { ...EMPTY_USAGE };
  #turns = 0;

  get messages(): readonly Message[] {
    return this.#messages;
  }

  get usage(): Usage {
    return { ...this.#usage };
  }

  get turns(): number {
    return this.#turns;
  }

  get isEmpty(): boolean {
    return this.#messages.length === 0;
  }

  snapshot(): Message[] {
    return [...this.#messages];
  }

  pushUserText(text: string): void {
    this.#messages.push({ role: "user", content: [{ type: "text", text }] });
  }

  pushAssistant(content: AssistantBlock[], raw?: ProviderRaw): void {
    const message: AssistantMessage = { role: "assistant", content };
    if (raw !== undefined) message.raw = raw;
    this.#messages.push(message);
    this.#turns += 1;
  }

  pushToolResults(results: ToolResultBlock[]): void {
    // All results for one assistant turn go back in a single user message -
    // splitting them teaches the model to stop calling tools in parallel.
    this.#messages.push({ role: "user", content: results });
  }

  addUsage(turn: Usage): void {
    this.#usage = {
      inputTokens: this.#usage.inputTokens + turn.inputTokens,
      outputTokens: this.#usage.outputTokens + turn.outputTokens,
      cacheReadTokens: this.#usage.cacheReadTokens + turn.cacheReadTokens,
    };
  }

  clear(): void {
    this.#messages = [];
    this.#usage = { ...EMPTY_USAGE };
    this.#turns = 0;
  }
}
