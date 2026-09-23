import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { displayPath, isIgnored, resolveInRoot } from "../paths.js";
import { defineTool, fail, ok, truncate } from "./define.js";

const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 2_000_000;

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

interface Match {
  file: string;
  line: number;
  text: string;
}

async function search(
  root: string,
  dir: string,
  pattern: RegExp,
  include: RegExp | null,
  out: Match[],
): Promise<void> {
  if (out.length >= MAX_MATCHES) return;

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    if (out.length >= MAX_MATCHES) return;
    if (isIgnored(dirent.name)) continue;

    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      await search(root, full, pattern, include, out);
      continue;
    }
    if (!dirent.isFile()) continue;

    const rel = displayPath(root, full);
    if (include && !include.test(rel) && !include.test(dirent.name)) continue;

    const stat = await fs.stat(full).catch(() => null);
    if (!stat || stat.size > MAX_FILE_BYTES) continue;

    let content: string;
    try {
      content = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    // Skip binaries: a NUL byte in the first chunk is a good enough signal.
    if (content.slice(0, 1024).includes("\u0000")) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        out.push({ file: rel, line: i + 1, text: line.trim().slice(0, 300) });
        if (out.length >= MAX_MATCHES) return;
      }
    }
  }
}

export const grepTool = defineTool({
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression. Returns " +
    "`file:line: text` for each match. Use `include` to narrow by glob, e.g. '*.ts'.",
  risk: "safe",
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    include: z.string().optional(),
    ignore_case: z.boolean().optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "JavaScript regular expression to match against each line.",
      },
      path: {
        type: "string",
        description: "Directory to search, relative to the project root. Defaults to '.'.",
      },
      include: {
        type: "string",
        description: "Glob filter on the file path, e.g. '*.ts' or 'src/**/*.tsx'.",
      },
      ignore_case: { type: "boolean", description: "Case-insensitive match." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  summarize: (input) =>
    `/${input.pattern}/ in ${input.path ?? "."}${input.include ? ` (${input.include})` : ""}`,
  async run(input, ctx) {
    let target: string;
    try {
      target = resolveInRoot(ctx.root, input.path ?? ".");
    } catch (error) {
      return fail((error as Error).message);
    }

    let pattern: RegExp;
    try {
      pattern = new RegExp(input.pattern, input.ignore_case ? "i" : "");
    } catch (error) {
      return fail(`invalid regular expression: ${(error as Error).message}`);
    }

    const include = input.include ? globToRegExp(input.include) : null;
    const matches: Match[] = [];
    await search(ctx.root, target, pattern, include, matches);

    if (matches.length === 0) {
      return ok(`No matches for /${input.pattern}/.`, "no matches");
    }

    const body = matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n");
    const capped =
      matches.length >= MAX_MATCHES
        ? `\n\n... [capped at ${MAX_MATCHES} matches]`
        : "";
    const files = new Set(matches.map((m) => m.file)).size;

    return ok(
      truncate(body + capped),
      `${matches.length} matches in ${files} file${files === 1 ? "" : "s"}`,
    );
  },
});
