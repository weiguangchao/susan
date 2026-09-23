import type { Tool } from "../types.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { grepTool } from "./grep.js";
import { lsTool } from "./ls.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";

/**
 * Order is deliberate and frozen: the tool list is the cacheable prefix of every
 * request, so it must not shuffle between turns.
 */
export const builtinTools: Tool[] = [
  readTool as Tool,
  writeTool as Tool,
  editTool as Tool,
  lsTool as Tool,
  grepTool as Tool,
  bashTool as Tool,
];

export function toolByName(tools: Tool[], name: string): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

export { bashTool, editTool, grepTool, lsTool, readTool, writeTool };
export { defineTool, fail, ok, truncate } from "./define.js";
