import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { displayPath, isIgnored, resolveInRoot } from "../paths.js";
import { defineTool, fail, ok, truncate } from "./define.js";

const MAX_ENTRIES = 400;

interface Entry {
  rel: string;
  isDir: boolean;
  size: number;
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  out: Entry[],
): Promise<void> {
  if (out.length >= MAX_ENTRIES) return;

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  dirents.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const dirent of dirents) {
    if (out.length >= MAX_ENTRIES) return;
    if (isIgnored(dirent.name)) continue;

    const full = path.join(dir, dirent.name);
    const isDir = dirent.isDirectory();
    let size = 0;
    if (!isDir) {
      size = await fs
        .stat(full)
        .then((s) => s.size)
        .catch(() => 0);
    }
    out.push({ rel: displayPath(root, full), isDir, size });

    if (isDir && depth > 1) {
      await walk(root, full, depth - 1, out);
    }
  }
}

export const lsTool = defineTool({
  name: "ls",
  description:
    "List directory contents. Set `depth` above 1 to recurse. Common build and " +
    "VCS directories (node_modules, .git, dist, ...) are skipped.",
  risk: "safe",
  schema: z.object({
    path: z.string().optional(),
    depth: z.number().int().min(1).max(5).optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to list, relative to the project root. Defaults to '.'.",
      },
      depth: {
        type: "number",
        description: "How many levels to recurse (1-5). Defaults to 1.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  summarize: (input) =>
    `${input.path ?? "."}${input.depth && input.depth > 1 ? ` (depth ${input.depth})` : ""}`,
  async run(input, ctx) {
    let target: string;
    try {
      target = resolveInRoot(ctx.root, input.path ?? ".");
    } catch (error) {
      return fail((error as Error).message);
    }

    try {
      const stat = await fs.stat(target);
      if (!stat.isDirectory()) {
        return fail(`${input.path} is not a directory - use the read tool`);
      }
    } catch {
      return fail(`directory not found: ${input.path ?? "."}`);
    }

    const entries: Entry[] = [];
    await walk(ctx.root, target, input.depth ?? 1, entries);

    if (entries.length === 0) {
      return ok("(empty directory)", "empty directory");
    }

    const body = entries
      .map((e) => (e.isDir ? `${e.rel}/` : `${e.rel} (${e.size} bytes)`))
      .join("\n");
    const capped =
      entries.length >= MAX_ENTRIES
        ? `\n\n... [listing capped at ${MAX_ENTRIES} entries]`
        : "";

    return ok(
      truncate(body + capped),
      `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`,
    );
  },
});
