import fs from "node:fs/promises";
import { z } from "zod";
import { displayPath, resolveInRoot } from "../paths.js";
import { defineTool, fail, ok } from "./define.js";

export const editTool = defineTool({
  name: "edit",
  description:
    "Replace an exact string in a file. `old_string` must appear exactly once " +
    "unless `replace_all` is true - include surrounding lines to make it unique. " +
    "Read the file first so the match is exact, whitespace included.",
  risk: "write",
  schema: z.object({
    path: z.string().min(1),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path, relative to the project root.",
      },
      old_string: {
        type: "string",
        description: "Exact text to replace, including indentation.",
      },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring exactly one.",
      },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  summarize: (input) =>
    `${input.path}${input.replace_all ? " (all occurrences)" : ""}`,
  async run(input, ctx) {
    let target: string;
    try {
      target = resolveInRoot(ctx.root, input.path);
    } catch (error) {
      return fail((error as Error).message);
    }

    if (input.old_string === input.new_string) {
      return fail("old_string and new_string are identical - nothing to do");
    }

    let original: string;
    try {
      original = await fs.readFile(target, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return fail(`file not found: ${input.path} - use the write tool to create it`);
      }
      return fail(`could not read ${input.path}: ${err.message}`);
    }

    const occurrences = original.split(input.old_string).length - 1;
    if (occurrences === 0) {
      return fail(
        `old_string was not found in ${input.path}. Read the file again - the match must be exact, including whitespace.`,
      );
    }
    if (occurrences > 1 && !input.replace_all) {
      return fail(
        `old_string appears ${occurrences} times in ${input.path}. Add surrounding context to make it unique, or pass replace_all: true.`,
      );
    }

    const updated = input.replace_all
      ? original.split(input.old_string).join(input.new_string)
      : original.replace(input.old_string, input.new_string);

    try {
      await fs.writeFile(target, updated, "utf8");
    } catch (error) {
      return fail(`could not write ${input.path}: ${(error as Error).message}`);
    }

    const rel = displayPath(ctx.root, target);
    const replaced = input.replace_all ? occurrences : 1;
    return ok(
      `Replaced ${replaced} occurrence${replaced === 1 ? "" : "s"} in ${rel}.`,
      `${replaced} replacement${replaced === 1 ? "" : "s"}`,
    );
  },
});
