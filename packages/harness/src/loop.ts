import { buildSystemPrompt } from "./prompt.js";
import { Session, SessionStore } from "./session/index.js";
import { builtinTools, toolByName } from "./tools/index.js";
import { estimateTokens } from "./usage.js";
import type {
  AgentEvent,
  ModelProvider,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
  TurnFinal,
  Usage,
} from "./types.js";

export interface AgentOptions {
  /** Directory the agent may touch. Every tool path resolves against it. */
  root: string;
  provider: ModelProvider;
  tools?: Tool[];
  /** Safety valve against a runaway loop. */
  maxTurns?: number;
  /** Persist conversation messages under this Susan home directory. */
  sessionHome?: string;
}

interface ExecutedTool {
  block: ToolResultBlock;
  event: Extract<AgentEvent, { type: "tool_result" }>;
}

function withMeasuredTurn(total: Usage, turn: Usage | null): Usage {
  if (!turn) return total;
  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    cacheReadTokens: total.cacheReadTokens + turn.cacheReadTokens,
  };
}

/**
 * The agent loop.
 *
 * One `run()` is one user request: it drives model turns until the model stops
 * asking for tools, and emits a flat event stream the UI renders as it goes.
 * The loop owns conversation state and tool dispatch; it
 * knows nothing about how the model is reached (that is the provider) or how
 * any of it looks (that is the TUI).
 */
export class Agent {
  readonly session = new Session();
  readonly tools: Tool[];
  readonly root: string;

  #provider: ModelProvider;
  #maxTurns: number;
  #system: string;
  #abort: AbortController | null = null;
  #sessionHome?: string;
  #store?: SessionStore;

  constructor(options: AgentOptions) {
    this.root = options.root;
    this.#provider = options.provider;
    this.tools = options.tools ?? builtinTools;
    this.#maxTurns = options.maxTurns ?? 40;
    this.#sessionHome = options.sessionHome;
    if (this.#sessionHome) {
      this.#store = new SessionStore(this.#sessionHome, this.root);
    }
    this.#system = buildSystemPrompt({ root: this.root, tools: this.tools });
  }

  get provider(): ModelProvider {
    return this.#provider;
  }

  get busy(): boolean {
    return this.#abort !== null;
  }

  /** Swap the model provider - used when the user supplies a key mid-session. */
  setProvider(provider: ModelProvider): void {
    this.#provider = provider;
  }

  /** Interrupt the run in flight. Tool processes are killed too. */
  abort(): void {
    this.#abort?.abort();
  }

  clearSession(): void {
    if (this.busy) throw new Error("cannot clear a running session");
    this.session.clear();
    if (this.#sessionHome) {
      this.#store = new SessionStore(this.#sessionHome, this.root);
    }
  }

  async *run(input: string): AsyncGenerator<AgentEvent> {
    if (this.busy) {
      yield { type: "notice", level: "warn", message: "already running" };
      return;
    }

    const controller = new AbortController();
    this.#abort = controller;

    try {
      const userMessage = {
        role: "user" as const,
        content: [{ type: "text" as const, text: input }],
      };
      await this.#store?.append(userMessage);
      this.session.pushUserText(input);
      for (let turn = 1; turn <= this.#maxTurns; turn++) {
        yield { type: "turn_start", turn };

        let final: TurnFinal;
        let streamedText = "";

        try {
          const request = {
            system: this.#system,
            messages: this.session.snapshot(),
            tools: this.tools,
            signal: controller.signal,
          };
          const estimatedUsage = {
            inputTokens: estimateTokens({
              system: request.system,
              messages: request.messages,
              tools: request.tools,
            }),
            outputTokens: 0,
            cacheReadTokens: 0,
          };
          yield { type: "usage_progress", usage: estimatedUsage,
            measuredTotal: this.session.usage, estimated: true };
          const stream = this.#provider.stream(request);

          for await (const event of stream) {
            switch (event.type) {
              case "text_delta":
                streamedText += event.text;
                yield { type: "text_delta", text: event.text };
                break;
              case "thinking_delta":
                yield { type: "thinking_delta", text: event.text };
                break;
              case "usage_progress":
                yield { type: "usage_progress", usage: event.usage,
                  measuredTotal: withMeasuredTurn(this.session.usage, event.usage), estimated: false };
                break;
              case "tool_use_start":
                yield {
                  type: "tool_pending",
                  id: event.id,
                  name: event.name,
                  summary: "preparing...",
                };
                break;
            }
          }

          final = await stream.final();
        } catch (error) {
          if (controller.signal.aborted) {
            yield { type: "done", reason: "aborted" };
            return;
          }
          yield {
            type: "notice",
            level: "error",
            message: (error as Error).message,
          };
          yield { type: "done", reason: "error" };
          return;
        }

        if (controller.signal.aborted) {
          yield { type: "done", reason: "aborted" };
          return;
        }

        await this.#store?.append(
          { role: "assistant", content: final.content, raw: final.raw },
          final.usage,
        );
        this.session.addUsage(final.usage);
        this.session.pushAssistant(final.content, final.raw);
        yield { type: "usage", usage: final.usage, total: this.session.usage };

        if (streamedText) {
          yield { type: "text_end", text: streamedText };
        }
        yield { type: "turn_end", turn, stopReason: final.stopReason };

        const toolUses = final.content.filter(
          (block): block is ToolUseBlock => block.type === "tool_use",
        );

        // A refusal can cut a tool_use off mid-input, so never run that turn's
        // tools - and a tool input truncated at max_tokens can still look like
        // valid JSON, which is worse than an outright parse failure.
        if (final.stopReason === "refusal") {
          yield {
            type: "notice",
            level: "warn",
            message: "the model declined this request",
          };
          yield { type: "done", reason: "refusal" };
          return;
        }

        if (final.stopReason === "max_tokens" && toolUses.length > 0) {
          yield {
            type: "notice",
            level: "error",
            message:
              "the turn hit max_tokens mid tool call - the input may be truncated, stopping here",
          };
          yield { type: "done", reason: "error" };
          return;
        }

        // A server-side tool paused the turn: re-send with the assistant turn
        // already appended and the model picks up where it left off.
        if (final.stopReason === "pause_turn") continue;

        if (toolUses.length === 0) {
          yield { type: "done", reason: "end_turn" };
          return;
        }

        const executed: ExecutedTool[] = yield* this.#executeTools(
          toolUses,
          controller.signal,
        );

        if (controller.signal.aborted) {
          yield { type: "done", reason: "aborted" };
          return;
        }

        const results = executed.map((item) => item.block);
        await this.#store?.append({ role: "user", content: results });
        this.session.pushToolResults(results);
        for (const item of executed) {
          yield item.event;
        }
      }

      yield {
        type: "notice",
        level: "warn",
        message: `stopped after ${this.#maxTurns} turns`,
      };
      yield { type: "done", reason: "max_turns" };
    } finally {
      this.#abort = null;
    }
  }

  /**
   * Parse, then run valid tool calls concurrently.
   */
  async *#executeTools(
    toolUses: ToolUseBlock[],
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, ExecutedTool[]> {
    const pending: Array<() => Promise<ExecutedTool>> = [];
    const settled: ExecutedTool[] = [];

    for (const use of toolUses) {
      const tool = toolByName(this.tools, use.name);
      if (!tool) {
        settled.push(
          errorResult(use, `unknown tool: ${use.name}`, "unknown tool"),
        );
        continue;
      }

      // The model's input is untrusted - validate before it reaches the tool.
      let input: unknown;
      try {
        input = tool.parse(use.input);
      } catch (error) {
        const message = (error as Error).message;
        yield { type: "tool_call", id: use.id, name: use.name, summary: message };
        settled.push(errorResult(use, message, "invalid input"));
        continue;
      }

      const summary = tool.summarize(input);
      yield { type: "tool_call", id: use.id, name: use.name, summary };

      pending.push(async () => {
        try {
          const result = await tool.run(input, { root: this.root, signal });
          return {
            block: {
              type: "tool_result",
              toolUseId: use.id,
              content: result.content,
              isError: !result.ok,
            },
            event: {
              type: "tool_result",
              id: use.id,
              name: use.name,
              ok: result.ok,
              display: result.display,
            },
          };
        } catch (error) {
          // A tool throwing is a bug, but the loop must still answer every
          // tool_use block or the next request is malformed.
          const message = (error as Error).message;
          return errorResult(use, `tool crashed: ${message}`, "crashed");
        }
      });
    }

    const ran = await Promise.all(pending.map((task) => task()));
    const byId = new Map<string, ExecutedTool>();
    for (const item of [...settled, ...ran]) {
      byId.set(item.block.toolUseId, item);
    }

    // Results must line up with the tool_use blocks that asked for them.
    return toolUses
      .map((use) => byId.get(use.id))
      .filter((item): item is ExecutedTool => item !== undefined);
  }
}

function errorResult(
  use: ToolUseBlock,
  content: string,
  display: string,
): ExecutedTool {
  return {
    block: {
      type: "tool_result",
      toolUseId: use.id,
      content,
      isError: true,
    },
    event: {
      type: "tool_result",
      id: use.id,
      name: use.name,
      ok: false,
      display,
    },
  };
}
