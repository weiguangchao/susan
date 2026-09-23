import fs from "node:fs/promises";
import { z } from "zod";
import { resolveInRoot } from "../paths.js";
import { defineTool, fail, ok, truncate } from "./define.js";

const MAX_LINES = 2000;

export const readTool = defineTool({
  name: "read",
  description:
    "Read a text file from the project. Returns the contents with line numbers. " +
    "Use `offset`/`limit` for large files. Always read a file before editing it.",
  risk: "safe",
  schema: z.object({
    path: z.string().min(1),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path, relative to the project root.",
      },
      offset: {
        type: "number",
        description: "1-indexed line to start from. Defaults to 1.",
      },
      limit: {
        type: "number",
        description: `Maximum number of lines to return. Defaults to ${MAX_LINES}.`,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  summarize: (input) =>
    input.offset || input.limit
      ? `${input.path} (from line ${input.offset ?? 1})`
      : input.path,
  async run(input, ctx) {
    let target: string;
    try {
      target = resolveInRoot(ctx.root, input.path);
    } catch (error) {
      return fail((error as Error).message);
    }

    let raw: string;
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        return fail(`${input.path} is a directory - use the ls tool`);
      }
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return fail(`file not found: ${input.path}`);
      return fail(`could not read ${input.path}: ${err.message}`);
    }

    if (raw === "") {
      return ok("(file is empty)", "empty file");
    }

    const allLines = raw.split("\n");
    const start = (input.offset ?? 1) - 1;
    const limit = input.limit ?? MAX_LINES;
    const slice = allLines.slice(start, start + limit);

    if (slice.length === 0) {
      return fail(
        `offset ${input.offset} is past the end of the file (${allLines.length} lines)`,
      );
    }

    const width = String(start + slice.length).length;
    const body = slice
      .map((line, i) => `${String(start + i + 1).padStart(width)}\t${line}`)
      .join("\n");

    const more =
      start + slice.length < allLines.length
        ? `\n\n... [${allLines.length - start - slice.length} more lines]`
        : "";

    return ok(truncate(body + more), `${slice.length} lines`);
  },
});
