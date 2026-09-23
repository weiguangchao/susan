import type {
  AssistantBlock,
  Message,
  ModelProvider,
  ProviderEvent,
  TurnFinal,
  TurnRequest,
  TurnStream,
} from "../types.js";

/**
 * A scripted provider that drives the real loop - real tool execution, real
 * permission prompts, real rendering - without an API key. It is for seeing the
 * harness work end to end, not for pretending to be a model.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Plan {
  thinking?: string;
  text: string;
  toolUse?: { name: string; input: unknown };
}

let counter = 0;
const nextId = () => `mock_tool_${++counter}`;

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "user") continue;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    if (text) return text;
  }
  return "";
}

/** True when the newest message carries tool results, i.e. we are mid-loop. */
function awaitingToolResults(messages: Message[]): boolean {
  const last = messages[messages.length - 1];
  return (
    !!last &&
    last.role === "user" &&
    last.content.some((block) => block.type === "tool_result")
  );
}

function toolResultSummary(messages: Message[]): string {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return "";
  return last.content
    .filter((block): block is Extract<typeof block, { type: "tool_result" }> =>
      block.type === "tool_result",
    )
    .map((block) => block.content)
    .join("\n")
    .split("\n")
    .slice(0, 12)
    .join("\n");
}

function planTurn(request: TurnRequest): Plan {
  const messages = [...request.messages];
  const available = new Set(request.tools.map((tool) => tool.name));

  if (awaitingToolResults(messages)) {
    const summary = toolResultSummary(messages);
    return {
      text:
        "Here is what the tool returned:\n\n" +
        summary +
        "\n\n(This is the mock provider - the loop, the tools and the permission " +
        "gate above are all real. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or pass " +
        "--base-url, and restart to use a real model.)",
    };
  }

  const prompt = lastUserText(messages).toLowerCase();

  if (/(write|create|新建|创建|写)/.test(prompt) && available.has("write")) {
    return {
      thinking: "The user wants a file created, so I will use the write tool.",
      text: "I'll create a small file so you can see the approval prompt.",
      toolUse: {
        name: "write",
        input: {
          path: "susan-demo.txt",
          content:
            "Written by susan's mock provider.\nThe write went through the permission gate first.\n",
        },
      },
    };
  }

  if (/(grep|search|搜索|查找|find)/.test(prompt) && available.has("grep")) {
    return {
      thinking: "A search request - grep is the right tool.",
      text: "Searching the project for TODO markers.",
      toolUse: { name: "grep", input: { pattern: "TODO|FIXME", include: "*.ts" } },
    };
  }

  if (/(sleep|slow|等待|长任务)/.test(prompt) && available.has("bash")) {
    return {
      thinking: "A long command - a good way to try interrupting with esc.",
      text: "Starting a long-running command. Press esc to interrupt it.",
      toolUse: { name: "bash", input: { command: "sleep 30 && echo finished" } },
    };
  }

  if (/(bash|run|test|build|运行|执行|构建)/.test(prompt) && available.has("bash")) {
    return {
      thinking: "This needs a shell command, which is an exec-risk tool.",
      text: "Running a shell command - this one needs your approval.",
      toolUse: { name: "bash", input: { command: "node --version && pwd" } },
    };
  }

  if (/(read|读|看看|打开)/.test(prompt) && available.has("read")) {
    return {
      thinking: "Reading a file is safe and needs no approval.",
      text: "Reading the project manifest.",
      toolUse: { name: "read", input: { path: "package.json" } },
    };
  }

  return {
    thinking: "No specific request, so I will orient myself with a listing.",
    text: "Let me look at the project layout first.",
    toolUse: { name: "ls", input: { path: ".", depth: 2 } },
  };
}

class MockTurn implements TurnStream {
  readonly #plan: Plan;
  readonly #toolUseId: string;

  constructor(plan: Plan) {
    this.#plan = plan;
    this.#toolUseId = nextId();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    if (this.#plan.thinking) {
      for (const chunk of chunks(this.#plan.thinking)) {
        await sleep(12);
        yield { type: "thinking_delta", text: chunk };
      }
    }
    for (const chunk of chunks(this.#plan.text)) {
      await sleep(14);
      yield { type: "text_delta", text: chunk };
    }
    if (this.#plan.toolUse) {
      await sleep(60);
      yield {
        type: "tool_use_start",
        id: this.#toolUseId,
        name: this.#plan.toolUse.name,
      };
    }
  }

  async final(): Promise<TurnFinal> {
    const content: AssistantBlock[] = [];
    if (this.#plan.thinking) {
      content.push({ type: "thinking", thinking: this.#plan.thinking });
    }
    content.push({ type: "text", text: this.#plan.text });
    if (this.#plan.toolUse) {
      content.push({
        type: "tool_use",
        id: this.#toolUseId,
        name: this.#plan.toolUse.name,
        input: this.#plan.toolUse.input,
      });
    }
    return {
      content,
      stopReason: this.#plan.toolUse ? "tool_use" : "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    };
  }
}

function chunks(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

export class MockProvider implements ModelProvider {
  readonly id = "mock";
  readonly label = "mock (no API key)";

  stream(request: TurnRequest): TurnStream {
    return new MockTurn(planTurn(request));
  }
}
