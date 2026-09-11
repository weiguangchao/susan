import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GREP_PROMPT_GUIDELINES,
  GREP_PROMPT_SNIPPET,
  createGrepTool,
  ensureTool,
  type GrepOperations,
  type GrepTool,
  type ToolResult,
} from "../src/index.js";

const GREP_DESCRIPTION =
  "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.";

function textOf(result: ToolResult): string {
  const block = result.content[0];
  if (block === undefined || block.type !== "text") {
    throw new Error("expected a text content block");
  }
  return block.text;
}

function listingOf(result: ToolResult): string[] {
  const text = textOf(result);
  if (text === "No matches found") {
    return [];
  }
  const noticeAt = text.indexOf("\n\n[");
  const listing = noticeAt === -1 ? text : text.slice(0, noticeAt);
  return listing.split("\n").filter((line) => line !== "");
}

function noticeOf(result: ToolResult): string | undefined {
  const text = textOf(result);
  const noticeAt = text.indexOf("\n\n[");
  return noticeAt === -1 ? undefined : text.slice(noticeAt + 2);
}

describe("Grep Tool", () => {
  let sessionCwd: string;
  let tool: GrepTool;

  beforeAll(async () => {
    const rgPath = await ensureTool("rg");
    if (!rgPath) {
      throw new Error("ripgrep (rg) is required for grep tests");
    }
  }, 120_000);

  beforeEach(async () => {
    sessionCwd = await mkdtemp(join(tmpdir(), "susan-grep-"));
    tool = createGrepTool({ sessionCwd });
  });

  afterEach(async () => {
    await rm(sessionCwd, { force: true, recursive: true });
  });

  it("exposes the Pi grep definition with empty guidelines", () => {
    expect(tool).toMatchObject({
      name: "grep",
      description: GREP_DESCRIPTION,
      promptSnippet: GREP_PROMPT_SNIPPET,
      promptGuidelines: GREP_PROMPT_GUIDELINES,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["pattern"],
        properties: {
          pattern: {
            type: "string",
            description: "Search pattern (regex or literal string)",
          },
          path: {
            type: "string",
            description: "Directory or file to search (default: current directory)",
          },
          glob: {
            type: "string",
            description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
          },
          ignoreCase: {
            type: "boolean",
            description: "Case-insensitive search (default: false)",
          },
          literal: {
            type: "boolean",
            description:
              "Treat pattern as literal string instead of regex (default: false)",
          },
          context: {
            type: "number",
            description: "Number of lines to show before and after each match (default: 0)",
          },
          limit: {
            type: "number",
            description: "Maximum number of matches to return (default: 100)",
          },
        },
      },
    });
    expect(GREP_PROMPT_SNIPPET).toBe(
      "Search file contents for patterns (respects .gitignore)",
    );
    expect(GREP_PROMPT_GUIDELINES).toEqual([]);
  });

  it("rejects extra keys and wrong types", async () => {
    await expect(tool.execute({})).rejects.toThrow("Invalid grep arguments.");
    await expect(tool.execute({ pattern: 1 })).rejects.toThrow(
      "Invalid grep arguments.",
    );
    await expect(tool.execute({ pattern: "a", path: 1 })).rejects.toThrow(
      "Invalid grep arguments.",
    );
    await expect(tool.execute({ pattern: "a", glob: 1 })).rejects.toThrow(
      "Invalid grep arguments.",
    );
    await expect(tool.execute({ pattern: "a", literal: "yes" })).rejects.toThrow(
      "Invalid grep arguments.",
    );
    await expect(tool.execute({ pattern: "a", ignoreCase: "yes" })).rejects.toThrow(
      "Invalid grep arguments.",
    );
    await expect(tool.execute({ pattern: "a", context: "1" })).rejects.toThrow(
      "Invalid grep arguments.",
    );
    await expect(tool.execute({ pattern: "a", limit: Number.NaN })).rejects.toThrow(
      "Invalid grep arguments.",
    );
    await expect(tool.execute({ pattern: "a", maxDepth: 1 })).rejects.toThrow(
      "Invalid grep arguments.",
    );
    await expect(tool.execute({ pattern: "a", includeIgnored: true })).rejects.toThrow(
      "Invalid grep arguments.",
    );
    await expect(tool.execute({ pattern: "a", offset: 0 })).rejects.toThrow(
      "Invalid grep arguments.",
    );
    await expect(tool.execute({ pattern: "a", extra: 1 })).rejects.toThrow(
      "Invalid grep arguments.",
    );
  });

  it("searches a single file and reports its basename", async () => {
    await writeFile(
      join(sessionCwd, "app.ts"),
      "const a = 1;\nexport const total = 2;\nconst b = 3;\n",
    );

    const result = await tool.execute({ pattern: "^export", path: "app.ts" });
    expect(textOf(result)).toBe("app.ts:2: export const total = 2;");
    expect(result.details).toBeUndefined();
  });

  it("counts a line with several hits as one match", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "aa aa aa\nbb\n");
    expect(listingOf(await tool.execute({ pattern: "a", path: "a.txt" }))).toEqual([
      "a.txt:1: aa aa aa",
    ]);
  });

  it("treats the pattern literally with literal and folds case with ignoreCase", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "a.c\nabc\nABC\n");

    expect(
      listingOf(await tool.execute({ pattern: "a.c", path: "a.txt" })),
    ).toEqual(["a.txt:1: a.c", "a.txt:2: abc"]);
    expect(
      listingOf(
        await tool.execute({ pattern: "a.c", path: "a.txt", literal: true }),
      ),
    ).toEqual(["a.txt:1: a.c"]);
    expect(
      listingOf(
        await tool.execute({ pattern: "abc", path: "a.txt", ignoreCase: true }),
      ),
    ).toEqual(["a.txt:2: abc", "a.txt:3: ABC"]);
    expect(
      listingOf(
        await tool.execute({
          pattern: "A.C",
          path: "a.txt",
          literal: true,
          ignoreCase: true,
        }),
      ),
    ).toEqual(["a.txt:1: a.c"]);
  });

  it("uses ripgrep regex and never matches across logical lines", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "café\nfirst\nsecond\n");

    expect(
      listingOf(await tool.execute({ pattern: "\\p{L}+é", path: "a.txt" })),
    ).toEqual(["a.txt:1: café"]);
    await expect(
      tool.execute({ pattern: "first\\nsecond", path: "a.txt" }),
    ).rejects.toThrow(/multiline mode/);
  });

  it("recurses a directory, includes hidden files, and returns relative paths", async () => {
    await mkdir(join(sessionCwd, "src", "deep"), { recursive: true });
    await writeFile(join(sessionCwd, "top.ts"), "needle\n");
    await writeFile(join(sessionCwd, ".dotfile"), "needle\n");
    await writeFile(join(sessionCwd, "src", "b.ts"), "no\nneedle\nneedle\n");
    await writeFile(join(sessionCwd, "src", "a.ts"), "needle\n");
    await writeFile(join(sessionCwd, "src", "deep", "c.ts"), "needle\n");

    const lines = listingOf(await tool.execute({ pattern: "needle" })).sort();
    expect(lines).toEqual([
      ".dotfile:1: needle",
      "src/a.ts:1: needle",
      "src/b.ts:2: needle",
      "src/b.ts:3: needle",
      "src/deep/c.ts:1: needle",
      "top.ts:1: needle",
    ]);
  });

  it("filters files with glob", async () => {
    await mkdir(join(sessionCwd, "pkg", "src"), { recursive: true });
    await writeFile(join(sessionCwd, "pkg", "notes.md"), "needle\n");
    await writeFile(join(sessionCwd, "pkg", "src", "a.ts"), "needle\n");
    await writeFile(join(sessionCwd, "root.ts"), "needle\n");

    expect(
      listingOf(await tool.execute({ pattern: "needle", glob: "*.ts" })).sort(),
    ).toEqual(["pkg/src/a.ts:1: needle", "root.ts:1: needle"]);
    expect(
      listingOf(
        await tool.execute({ pattern: "needle", glob: "**/pkg/**/*.ts" }),
      ).sort(),
    ).toEqual(["pkg/src/a.ts:1: needle"]);
    expect(textOf(await tool.execute({ pattern: "needle", glob: "*.rs" }))).toBe(
      "No matches found",
    );
  });

  it("respects .gitignore and still searches hidden files", async () => {
    expect(spawnSync("git", ["init"], { cwd: sessionCwd }).status).toBe(0);
    await writeFile(join(sessionCwd, ".gitignore"), "*.log\n/root-only.ts\nbuild/\n");
    await mkdir(join(sessionCwd, "build"));
    await mkdir(join(sessionCwd, "pkg"));
    await writeFile(join(sessionCwd, ".git", "HEAD"), "needle\n");
    await writeFile(join(sessionCwd, "build", "out.ts"), "needle\n");
    await writeFile(join(sessionCwd, "root-only.ts"), "needle\n");
    await writeFile(join(sessionCwd, "pkg", "root-only.ts"), "needle\n");
    await writeFile(join(sessionCwd, "keep.ts"), "needle\n");
    await writeFile(join(sessionCwd, "drop.log"), "needle\n");
    await writeFile(join(sessionCwd, "pkg", ".gitignore"), "*.ts\n!keep.ts\n");
    await writeFile(join(sessionCwd, "pkg", "keep.ts"), "needle\n");
    await writeFile(join(sessionCwd, "pkg", "other.ts"), "needle\n");

    expect(
      listingOf(await tool.execute({ pattern: "needle" })).sort(),
    ).toEqual([
      ".git/HEAD:1: needle",
      "keep.ts:1: needle",
      "pkg/keep.ts:1: needle",
    ]);
  });

  it("skips symlinked files and directories found while walking", async () => {
    await mkdir(join(sessionCwd, "real"));
    await writeFile(join(sessionCwd, "real", "a.ts"), "needle\n");
    await symlink(
      join(sessionCwd, "real", "a.ts"),
      join(sessionCwd, "file-link.ts"),
      process.platform === "win32" ? "file" : undefined,
    );
    await symlink(
      join(sessionCwd, "real"),
      join(sessionCwd, "dir-link"),
      process.platform === "win32" ? "dir" : undefined,
    );

    expect(listingOf(await tool.execute({ pattern: "needle" }))).toEqual([
      "real/a.ts:1: needle",
    ]);
  });

  it("searches an explicit symlink by basename", async () => {
    await writeFile(join(sessionCwd, "real.ts"), "needle\n");
    await symlink(
      join(sessionCwd, "real.ts"),
      join(sessionCwd, "alias.ts"),
      process.platform === "win32" ? "file" : undefined,
    );

    expect(
      textOf(await tool.execute({ pattern: "needle", path: "alias.ts" })),
    ).toBe("alias.ts:1: needle");
  });

  it("returns No matches found when nothing hits", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "nothing here\n");
    await mkdir(join(sessionCwd, "empty"));

    await expect(tool.execute({ pattern: "zzz" })).resolves.toMatchObject({
      content: [{ type: "text", text: "No matches found" }],
      details: undefined,
    });
    await expect(
      tool.execute({ pattern: "nothing", path: "empty" }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "No matches found" }],
      details: undefined,
    });
  });

  it("returns unified context clipped at file boundaries", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "hit\nfiller\nhit\nlast\n");

    expect(
      listingOf(
        await tool.execute({ pattern: "hit", path: "a.txt", context: 2 }),
      ),
    ).toEqual([
      "a.txt:1: hit",
      "a.txt-2- filler",
      "a.txt-3- hit",
      "a.txt-1- hit",
      "a.txt-2- filler",
      "a.txt:3: hit",
      "a.txt-4- last",
      "a.txt-5- ",
    ]);
  });

  it("appends the Pi match-limit notice and doubles the suggested limit", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "hit 1\nhit 2\nhit 3\n");

    const result = await tool.execute({ pattern: "hit", limit: 2 });
    expect(listingOf(result)).toEqual(["a.txt:1: hit 1", "a.txt:2: hit 2"]);
    expect(noticeOf(result)).toBe(
      "[2 matches limit reached. Use limit=4 for more, or refine pattern]",
    );
    expect(result.details).toMatchObject({ matchLimitReached: 2 });
    expect(result.details?.truncation).toBeUndefined();
  });

  it("truncates long lines to 500 chars and notes the read tool", async () => {
    const wide = "a".repeat(600);
    await writeFile(join(sessionCwd, "wide.txt"), `hit ${wide}\n`);

    const result = await tool.execute({ pattern: "hit", path: "wide.txt" });
    expect(listingOf(result)[0]).toBe(
      `wide.txt:1: ${`hit ${wide}`.slice(0, 500)}... [truncated]`,
    );
    expect(noticeOf(result)).toBe(
      "[Some lines truncated to 500 chars. Use read tool to see full lines]",
    );
    expect(result.details).toMatchObject({ linesTruncated: true });
  });

  it("truncates by 50KB and appends the size-limit notice", async () => {
    const line = `hit ${"x".repeat(400)}`;
    const lines = Array.from({ length: 200 }, () => line);
    await writeFile(join(sessionCwd, "big.txt"), `${lines.join("\n")}\n`);

    const result = await tool.execute({
      pattern: "hit",
      path: "big.txt",
      limit: 200,
    });
    expect(noticeOf(result)).toContain("50.0KB limit reached");
    expect(result.details?.truncation?.truncated).toBe(true);
    expect(result.details?.truncation?.truncatedBy).toBe("bytes");
    expect(listingOf(result).length).toBeGreaterThan(0);
    expect(listingOf(result).length).toBeLessThan(200);
  });

  it("skips binary files instead of returning diagnostics", async () => {
    await writeFile(join(sessionCwd, "keep.ts"), "needle\n");
    await writeFile(join(sessionCwd, "bin.dat"), Buffer.from([0x00, 0x01]));

    const result = await tool.execute({ pattern: "needle" });
    expect(listingOf(result)).toEqual(["keep.ts:1: needle"]);
    expect(result.details).toBeUndefined();
  });

  it("rejects a missing path with the Pi message", async () => {
    await expect(tool.execute({ pattern: "a", path: "missing" })).rejects.toThrow(
      `Path not found: ${join(sessionCwd, "missing")}`,
    );
  });

  it("resolves a relative path against Session cwd, not process cwd", async () => {
    await writeFile(join(sessionCwd, "here.ts"), "needle\n");
    const other = await mkdtemp(join(tmpdir(), "susan-grep-other-"));
    const previous = process.cwd();
    try {
      process.chdir(other);
      await writeFile(join(other, "here.ts"), "needle\nwrong\n");
      expect(textOf(await tool.execute({ pattern: "needle", path: "here.ts" })))
        .toBe("here.ts:1: needle");
    } finally {
      process.chdir(previous);
      await rm(other, { force: true, recursive: true });
    }
  });

  it("searches an absolute path outside Session cwd", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-grep-outside-"));
    try {
      await writeFile(join(outside, "a.ts"), "needle\n");
      expect(
        listingOf(await tool.execute({ pattern: "needle", path: outside })).sort(),
      ).toEqual(["a.ts:1: needle"]);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("maps an already-aborted signal to Operation aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute({ pattern: "a" }, controller.signal)).rejects.toThrow(
      "Operation aborted",
    );
  });

  it("uses custom readFile for context lines", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "hit\n");
    const operations: GrepOperations = {
      isDirectory: async () => false,
      readFile: async () => {
        throw new Error("unavailable");
      },
    };
    const isolated = createGrepTool({ sessionCwd, operations });
    expect(
      textOf(
        await isolated.execute({ pattern: "hit", path: "a.txt", context: 1 }),
      ),
    ).toBe("a.txt:1: (unable to read file)");
  });

  it("fails when rg cannot be resolved", async () => {
    const isolatedBin = await mkdtemp(join(tmpdir(), "susan-grep-norg-"));
    const previousPath = process.env.PATH;
    const previousBin = process.env.SUSAN_BIN_DIR;
    const previousOffline = process.env.SUSAN_OFFLINE;
    process.env.PATH = "/nonexistent";
    process.env.SUSAN_BIN_DIR = isolatedBin;
    process.env.SUSAN_OFFLINE = "1";
    try {
      await expect(tool.execute({ pattern: "a" })).rejects.toThrow(
        "ripgrep (rg) is not available and could not be downloaded",
      );
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousBin === undefined) {
        delete process.env.SUSAN_BIN_DIR;
      } else {
        process.env.SUSAN_BIN_DIR = previousBin;
      }
      if (previousOffline === undefined) {
        delete process.env.SUSAN_OFFLINE;
      } else {
        process.env.SUSAN_OFFLINE = previousOffline;
      }
      await rm(isolatedBin, { force: true, recursive: true });
    }
  });
});
