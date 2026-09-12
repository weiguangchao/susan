import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LS_PROMPT_GUIDELINES,
  LS_PROMPT_SNIPPET,
  createLsTool,
  type LsOperations,
  type LsTool,
  type ToolResult,
} from "../src/index";

const POSIX = process.platform !== "win32";

const LS_DESCRIPTION =
  "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).";

function textOf(result: ToolResult): string {
  const block = result.content[0];
  if (block === undefined || block.type !== "text") {
    throw new Error("expected a text content block");
  }
  return block.text;
}

describe("Ls Tool", () => {
  let sessionCwd: string;
  let tool: LsTool;

  beforeEach(async () => {
    sessionCwd = await mkdtemp(join(tmpdir(), "susan-ls-"));
    tool = createLsTool({ sessionCwd });
  });

  afterEach(async () => {
    await rm(sessionCwd, { force: true, recursive: true });
  });

  it("exposes the Pi ls definition with empty guidelines", () => {
    expect(tool).toMatchObject({
      name: "ls",
      description: LS_DESCRIPTION,
      promptSnippet: LS_PROMPT_SNIPPET,
      promptGuidelines: LS_PROMPT_GUIDELINES,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Directory to list (default: current directory)",
          },
          limit: {
            type: "number",
            description: "Maximum number of entries to return (default: 500)",
          },
        },
      },
    });
    expect(LS_PROMPT_SNIPPET).toBe("List directory contents");
    expect(LS_PROMPT_GUIDELINES).toEqual([]);
  });

  it("rejects extra keys and wrong types", async () => {
    await expect(tool.execute({ path: 1 })).rejects.toThrow("Invalid ls arguments.");
    await expect(tool.execute({ limit: "2" })).rejects.toThrow(
      "Invalid ls arguments.",
    );
    await expect(tool.execute({ includeIgnored: true })).rejects.toThrow(
      "Invalid ls arguments.",
    );
    await expect(tool.execute({ offset: 0 })).rejects.toThrow(
      "Invalid ls arguments.",
    );
    await expect(tool.execute({ path: ".", extra: 1 })).rejects.toThrow(
      "Invalid ls arguments.",
    );
    await expect(tool.execute({ limit: Number.NaN })).rejects.toThrow(
      "Invalid ls arguments.",
    );
  });

  it("lists an empty directory as (empty directory)", async () => {
    const result = await tool.execute({});
    expect(textOf(result)).toBe("(empty directory)");
    expect(result.details).toBeUndefined();
  });

  it("lists direct children with directory suffixes, dotfiles, and case-insensitive order", async () => {
    await mkdir(join(sessionCwd, "src", "nested"), { recursive: true });
    await writeFile(join(sessionCwd, "README.md"), "hi\n");
    await writeFile(join(sessionCwd, ".hidden"), "secret\n");
    await writeFile(join(sessionCwd, "src", "index.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "alpha.ts"), "a\n");
    await writeFile(join(sessionCwd, "Zed.ts"), "z\n");
    await symlink(
      join(sessionCwd, "src"),
      join(sessionCwd, "link"),
      process.platform === "win32" ? "dir" : undefined,
    );

    const result = await tool.execute({ path: "." });
    expect(textOf(result)).toBe(".hidden\nalpha.ts\nlink/\nREADME.md\nsrc/\nZed.ts");
    expect(result.details).toBeUndefined();
  });

  it("does not recurse into child directories", async () => {
    await mkdir(join(sessionCwd, "src"));
    await writeFile(join(sessionCwd, "src", "index.ts"), "export {}\n");
    const result = await tool.execute({});
    expect(textOf(result)).toBe("src/");
    expect(textOf(result)).not.toContain("index.ts");
  });

  it("includes gitignored files, .git, and dotfiles", async () => {
    await writeFile(join(sessionCwd, ".gitignore"), "*.log\n");
    await writeFile(join(sessionCwd, "keep.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "drop.log"), "noise\n");
    await mkdir(join(sessionCwd, ".git"));
    await writeFile(join(sessionCwd, ".git", "HEAD"), "ref: refs/heads/dev\n");

    const result = await tool.execute({});
    expect(textOf(result).split("\n")).toEqual([
      ".git/",
      ".gitignore",
      "drop.log",
      "keep.ts",
    ]);
  });

  it("follows a directory symlink and suffixes it with /", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-ls-outside-"));
    try {
      await writeFile(join(outside, "remote.ts"), "export {}\n");
      await symlink(
        outside,
        join(sessionCwd, "linked"),
        process.platform === "win32" ? "junction" : undefined,
      );

      const listing = await tool.execute({});
      expect(textOf(listing)).toBe("linked/");

      const inside = await tool.execute({ path: "linked" });
      expect(textOf(inside)).toBe("remote.ts");
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("rejects missing and non-directory paths with Pi messages", async () => {
    await writeFile(join(sessionCwd, "file.txt"), "not a dir\n");
    await expect(tool.execute({ path: "missing" })).rejects.toThrow(
      `Path not found: ${join(sessionCwd, "missing")}`,
    );
    await expect(tool.execute({ path: "file.txt" })).rejects.toThrow(
      `Not a directory: ${join(sessionCwd, "file.txt")}`,
    );
  });

  it.skipIf(!POSIX)("fails when the target directory cannot be read", async () => {
    const locked = join(sessionCwd, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await expect(tool.execute({ path: "locked" })).rejects.toThrow(
        /^Cannot read directory: /,
      );
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("appends the Pi entry-limit notice and doubles the suggested limit", async () => {
    await writeFile(join(sessionCwd, "a.ts"), "a\n");
    await writeFile(join(sessionCwd, "b.ts"), "b\n");
    await writeFile(join(sessionCwd, "c.ts"), "c\n");

    const result = await tool.execute({ limit: 2 });
    expect(textOf(result)).toBe(
      "a.ts\nb.ts\n\n[2 entries limit reached. Use limit=4 for more]",
    );
    expect(result.details).toMatchObject({ entryLimitReached: 2 });
    expect(result.details?.truncation).toBeUndefined();
  });

  it("truncates by 50KB and appends the size-limit notice", async () => {
    const names = Array.from({ length: 12 }, (_, index) => `n${index}`);
    const operations: LsOperations = {
      exists: async () => true,
      stat: async (absolutePath) => ({
        isDirectory: () => absolutePath === sessionCwd,
      }),
      readdir: async () => names,
    };
    const isolated = createLsTool({ sessionCwd, operations });
    const longNameOps: LsOperations = {
      exists: async () => true,
      stat: async (absolutePath) => ({
        isDirectory: () => absolutePath === sessionCwd,
      }),
      readdir: async () =>
        Array.from({ length: 20 }, (_, index) => `${"x".repeat(4000)}-${index}`),
    };
    const longTool = createLsTool({ sessionCwd, operations: longNameOps });
    const result = await longTool.execute({});
    expect(textOf(result)).toContain("[50.0KB limit reached]");
    expect(result.details?.truncation?.truncated).toBe(true);
    expect(result.details?.truncation?.truncatedBy).toBe("bytes");
    expect(textOf(await isolated.execute({}))).toBe(names.join("\n"));
  });

  it("can hit the entry limit and the byte limit together", async () => {
    const operations: LsOperations = {
      exists: async () => true,
      stat: async (absolutePath) => ({
        isDirectory: () => absolutePath === sessionCwd,
      }),
      readdir: async () =>
        Array.from({ length: 8 }, (_, index) => `${"y".repeat(9000)}-${index}`),
    };
    const isolated = createLsTool({ sessionCwd, operations });
    const result = await isolated.execute({ limit: 6 });
    expect(textOf(result)).toContain(
      "6 entries limit reached. Use limit=12 for more. 50.0KB limit reached",
    );
    expect(result.details).toMatchObject({
      entryLimitReached: 6,
    });
    expect(result.details?.truncation?.truncatedBy).toBe("bytes");
  });

  it("resolves a relative path against Session cwd, not process cwd", async () => {
    await mkdir(join(sessionCwd, "nested"));
    await writeFile(join(sessionCwd, "nested", "here.ts"), "export {}\n");
    const other = await mkdtemp(join(tmpdir(), "susan-ls-other-"));
    const previous = process.cwd();
    try {
      process.chdir(other);
      await mkdir(join(other, "nested"));
      await writeFile(join(other, "nested", "wrong.ts"), "wrong\n");
      const result = await tool.execute({ path: "nested" });
      expect(textOf(result)).toBe("here.ts");
    } finally {
      process.chdir(previous);
      await rm(other, { force: true, recursive: true });
    }
  });

  it("lists an absolute path outside Session cwd", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-ls-abs-"));
    try {
      await writeFile(join(outside, "abs.ts"), "export {}\n");
      const result = await tool.execute({ path: outside });
      expect(textOf(result)).toBe("abs.ts");
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("skips entries that cannot be stated", async () => {
    const operations: LsOperations = {
      exists: async () => true,
      stat: async (absolutePath) => {
        if (absolutePath === sessionCwd) {
          return { isDirectory: () => true };
        }
        if (absolutePath.endsWith("gone.ts")) {
          throw new Error("ENOENT");
        }
        return { isDirectory: () => false };
      },
      readdir: async () => ["gone.ts", "keep.ts"],
    };
    const isolated = createLsTool({ sessionCwd, operations });
    const result = await isolated.execute({});
    expect(textOf(result)).toBe("keep.ts");
  });

  it("maps an already-aborted signal to Operation aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute({}, controller.signal)).rejects.toThrow(
      "Operation aborted",
    );
  });
});
