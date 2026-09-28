import { executeTools } from "./execute-tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { Session, SessionStore } from "./session/index.js";
import { loadSkills } from "./skills.js";
import { builtinTools } from "./tools/index.js";
import { estimateTokens } from "./usage.js";
import type {
  AgentEvent,
  ModelProvider,
  Tool,
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
  /** Load skills from this directory into the system prompt; read may open it. */
  skillsDir?: string;
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
  #readOnlyRoots: string[];

  constructor(options: AgentOptions) {
    this.root = options.root;
    this.#provider = options.provider;
    this.tools = options.tools ?? builtinTools;
    this.#maxTurns = options.maxTurns ?? 40;
    this.#sessionHome = options.sessionHome;
    if (this.#sessionHome) {
      this.#store = new SessionStore(this.#sessionHome, this.root);
    }
    const skillsDir = options.skillsDir;
    this.#readOnlyRoots = skillsDir ? [skillsDir] : [];
    this.#system = buildSystemPrompt({
      root: this.root,
      skills: skillsDir ? { dir: skillsDir, list: loadSkills(skillsDir) } : undefined,
    });
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
        let streamedThinking = "";

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
                streamedThinking += event.text;
                yield { type: "thinking_delta", text: event.text };
                break;
              case "thinking_end":
                if (streamedThinking) {
                  yield { type: "thinking_end", text: streamedThinking };
                  streamedThinking = "";
                }
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

          // A truncated or misbehaving stream must not leave a block open.
          if (streamedThinking) {
            yield { type: "thinking_end", text: streamedThinking };
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

        const executed = yield* executeTools(toolUses, this.tools, {
          root: this.root,
          readOnlyRoots: this.#readOnlyRoots,
          signal: controller.signal,
        });

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
}
