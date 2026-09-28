import { toolByName } from "./tools/index.js";
import { preview } from "./tools/preview.js";
import type {
  AgentEvent,
  Tool,
  ToolContext,
  ToolResultBlock,
  ToolUseBlock,
} from "./types.js";

export interface ExecutedTool {
  block: ToolResultBlock;
  event: Extract<AgentEvent, { type: "tool_result" }>;
}

interface Call {
  index: number;
  use: ToolUseBlock;
  tool: Tool;
  input: unknown;
  summary: string;
}

/**
 * Runs one turn's tool calls and answers every tool_use block, in order.
 *
 * Yields a `tool_call` event for each valid call before any of them runs.
 * Calls then execute in the order given: adjacent `safe` calls run together,
 * and every `write` or `exec` call runs alone, after all earlier calls finish
 * and before any later call starts. The outcome matches running the calls one
 * by one. Once `ctx.signal` aborts, calls that have not started never start
 * and are answered with an error result instead.
 */
export async function* executeTools(
  toolUses: ToolUseBlock[],
  tools: Tool[],
  ctx: ToolContext,
): AsyncGenerator<AgentEvent, ExecutedTool[]> {
  const results: ExecutedTool[] = [];
  const calls: Call[] = [];

  for (const [index, use] of toolUses.entries()) {
    const tool = toolByName(tools, use.name);
    if (!tool) {
      results[index] = errorResult(use, `unknown tool: ${use.name}`, "unknown tool");
      continue;
    }

    // The model's input is untrusted - validate before it reaches the tool.
    let input: unknown;
    try {
      input = tool.parse(use.input);
    } catch (error) {
      const message = (error as Error).message;
      yield { type: "tool_call", id: use.id, name: use.name, summary: message };
      results[index] = errorResult(use, message, "invalid input");
      continue;
    }

    const summary = tool.summarize(input);
    yield { type: "tool_call", id: use.id, name: use.name, summary };
    calls.push({ index, use, tool, input, summary });
  }

  for (const group of inOrderGroups(calls)) {
    await Promise.all(group.map(async (call) => {
      results[call.index] = ctx.signal.aborted
        ? errorResult(call.use, "not run: interrupted before this call started", "not run")
        : await runCall(call, ctx);
    }));
  }

  return results;
}

/** Adjacent safe calls share a group; any other call is a group of its own. */
function inOrderGroups(calls: Call[]): Call[][] {
  const groups: Call[][] = [];
  for (const call of calls) {
    const last = groups.at(-1);
    if (call.tool.risk === "safe" && last?.[0]?.tool.risk === "safe") {
      last.push(call);
    } else {
      groups.push([call]);
    }
  }
  return groups;
}

async function runCall(call: Call, ctx: ToolContext): Promise<ExecutedTool> {
  const { use, tool, input, summary } = call;
  try {
    const result = await tool.run(input, ctx);
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
        summary: result.summary ?? summary,
        preview: result.preview ?? preview(result.content),
      },
    };
  } catch (error) {
    // A tool throwing is a bug, but the loop must still answer every
    // tool_use block or the next request is malformed.
    const message = (error as Error).message;
    return errorResult(use, `tool crashed: ${message}`, "crashed");
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
      preview: preview(content),
    },
  };
}
