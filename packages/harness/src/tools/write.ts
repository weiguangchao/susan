import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { displayPath, resolveInRoot } from "../paths.js";
import { defineTool, fail, ok } from "./define.js";

export const writeTool = defineTool({
  name: "write",
  description:
    "Write a text file, creating parent directories as needed. Overwrites the " +
    "file if it already exists - read it first unless you are creating it fresh.",
  risk: "write",
  schema: z.object({
    path: z.string().min(1),
    content: z.string(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path, relative to the project root.",
      },
      content: { type: "string", description: "Full contents to write." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  summarize: (input) => {
    const lines = input.content === "" ? 0 : input.content.split("\n").length;
    return `${input.path} (${lines} lines)`;
  },
  async run(input, ctx) {
    let target: string;
    try {
      target = resolveInRoot(ctx.root, input.path);
    } catch (error) {
      return fail((error as Error).message);
    }

    const existed = await fs
      .access(target)
      .then(() => true)
      .catch(() => false);

    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, input.content, "utf8");
    } catch (error) {
      return fail(`could not write ${input.path}: ${(error as Error).message}`);
    }

    const lines = input.content === "" ? 0 : input.content.split("\n").length;
    const rel = displayPath(ctx.root, target);
    return ok(
      `${existed ? "Overwrote" : "Created"} ${rel} (${lines} lines, ${input.content.length} bytes).`,
      `${existed ? "overwrote" : "created"}, ${lines} lines`,
    );
  },
});
