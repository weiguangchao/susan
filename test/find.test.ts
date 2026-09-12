import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix, win32, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FIND_PROMPT_GUIDELINES,
  FIND_PROMPT_SNIPPET,
  createFindTool,
  ensureTool,
  relativizeFindResultPath,
  type FindOperations,
  type FindTool,
  type ToolResult,
} from "../src/index";

const FIND_DESCRIPTION =
  "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).";

function textOf(result: ToolResult): string {
  const block = result.content[0];
  if (block === undefined || block.type !== "text") {
    throw new Error("expected a text content block");
  }
  return block.text;
}

function listingOf(result: ToolResult): string[] {
  const text = textOf(result);
  if (text === "No files found matching pattern") {
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

describe("Find Tool", () => {
  let sessionCwd: string;
  let tool: FindTool;

  beforeAll(async () => {
    const fdPath = await ensureTool("fd");
    if (!fdPath) {
      throw new Error("fd is required for find tests");
    }
  }, 120_000);

  beforeEach(async () => {
    sessionCwd = await mkdtemp(join(tmpdir(), "susan-find-"));
    tool = createFindTool({ sessionCwd });
  });

  afterEach(async () => {
    await rm(sessionCwd, { force: true, recursive: true });
  });

  it("exposes the Pi find definition with empty guidelines", () => {
    expect(tool).toMatchObject({
      name: "find",
      description: FIND_DESCRIPTION,
      promptSnippet: FIND_PROMPT_SNIPPET,
      promptGuidelines: FIND_PROMPT_GUIDELINES,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["pattern"],
        properties: {
          pattern: {
            type: "string",
            description:
              "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
          },
          path: {
            type: "string",
            description: "Directory to search in (default: current directory)",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default: 1000)",
          },
        },
      },
    });
    expect(FIND_PROMPT_SNIPPET).toBe(
      "Find files by glob pattern (respects .gitignore)",
    );
    expect(FIND_PROMPT_GUIDELINES).toEqual([]);
  });

  it("rejects extra keys and wrong types", async () => {
    await expect(tool.execute({})).rejects.toThrow("Invalid find arguments.");
    await expect(tool.execute({ pattern: 1 })).rejects.toThrow(
      "Invalid find arguments.",
    );
    await expect(tool.execute({ pattern: "*", path: 1 })).rejects.toThrow(
      "Invalid find arguments.",
    );
    await expect(tool.execute({ pattern: "*", limit: "2" })).rejects.toThrow(
      "Invalid find arguments.",
    );
    await expect(tool.execute({ pattern: "*", limit: Number.NaN })).rejects.toThrow(
      "Invalid find arguments.",
    );
    await expect(tool.execute({ pattern: "*", type: "file" })).rejects.toThrow(
      "Invalid find arguments.",
    );
    await expect(tool.execute({ pattern: "*", maxDepth: 1 })).rejects.toThrow(
      "Invalid find arguments.",
    );
    await expect(
      tool.execute({ pattern: "*", includeIgnored: true }),
    ).rejects.toThrow("Invalid find arguments.");
    await expect(tool.execute({ pattern: "*", offset: 0 })).rejects.toThrow(
      "Invalid find arguments.",
    );
    await expect(tool.execute({ pattern: "*", extra: 1 })).rejects.toThrow(
      "Invalid find arguments.",
    );
  });

  it("matches basename globs at any depth and returns relative paths", async () => {
    await mkdir(join(sessionCwd, "src", "nested"), { recursive: true });
    await writeFile(join(sessionCwd, "root.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "src", "app.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "src", "nested", "deep.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "src", "notes.md"), "# notes\n");

    expect(listingOf(await tool.execute({ pattern: "*.ts" })).sort()).toEqual([
      "root.ts",
      "src/app.ts",
      "src/nested/deep.ts",
    ]);
  });

  it("matches path-containing globs in full-path mode", async () => {
    await mkdir(join(sessionCwd, "some", "parent", "child"), { recursive: true });
    await mkdir(join(sessionCwd, "src", "foo", "bar"), { recursive: true });
    await writeFile(join(sessionCwd, "some", "parent", "child", "file.ext"), "");
    await writeFile(
      join(sessionCwd, "some", "parent", "child", "test.spec.ts"),
      "",
    );
    await writeFile(join(sessionCwd, "src", "foo", "bar", "example.spec.ts"), "");

    expect(listingOf(await tool.execute({ pattern: "*.spec.ts" })).sort()).toEqual([
      "some/parent/child/test.spec.ts",
      "src/foo/bar/example.spec.ts",
    ]);
    const subtree = listingOf(
      await tool.execute({ pattern: "some/parent/child/**" }),
    );
    expect(subtree).toContain("some/parent/child/file.ext");
    expect(subtree).toContain("some/parent/child/test.spec.ts");
    expect(
      listingOf(await tool.execute({ pattern: "**/parent/child/*" })).sort(),
    ).toEqual(
      expect.arrayContaining([
        "some/parent/child/file.ext",
        "some/parent/child/test.spec.ts",
      ]),
    );
    expect(listingOf(await tool.execute({ pattern: "src/**/*.spec.ts" }))).toEqual(
      ["src/foo/bar/example.spec.ts"],
    );
  });

  it("includes hidden files", async () => {
    await mkdir(join(sessionCwd, ".config"));
    await writeFile(join(sessionCwd, ".config", "settings.json"), "{}\n");
    await writeFile(join(sessionCwd, ".hidden.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "Case.ts"), "export {}\n");

    expect(listingOf(await tool.execute({ pattern: "*.ts" })).sort()).toEqual([
      ".hidden.ts",
      "Case.ts",
    ]);
    expect(listingOf(await tool.execute({ pattern: "*.json" }))).toEqual([
      ".config/settings.json",
    ]);
  });

  it("scopes nested .gitignore rules to their own subtrees", async () => {
    await mkdir(join(sessionCwd, "a", "deep"), { recursive: true });
    await mkdir(join(sessionCwd, "b"));
    await writeFile(join(sessionCwd, "a", ".gitignore"), "ignored.txt\n");
    await writeFile(join(sessionCwd, "a", "deep", ".gitignore"), "secret.txt\n");
    await writeFile(join(sessionCwd, "a", "ignored.txt"), "");
    await writeFile(join(sessionCwd, "a", "kept.txt"), "");
    await writeFile(join(sessionCwd, "a", "deep", "ignored.txt"), "");
    await writeFile(join(sessionCwd, "a", "deep", "secret.txt"), "");
    await writeFile(join(sessionCwd, "a", "deep", "kept.txt"), "");
    await writeFile(join(sessionCwd, "b", "ignored.txt"), "");
    await writeFile(join(sessionCwd, "b", "kept.txt"), "");
    await writeFile(join(sessionCwd, "root.txt"), "");

    expect(listingOf(await tool.execute({ pattern: "**/*.txt" })).sort()).toEqual([
      "a/deep/kept.txt",
      "a/kept.txt",
      "b/ignored.txt",
      "b/kept.txt",
      "root.txt",
    ]);
  });

  it("respects .gitignore inside a git repository", async () => {
    expect(spawnSync("git", ["init"], { cwd: sessionCwd }).status).toBe(0);
    await writeFile(join(sessionCwd, ".gitignore"), "*.log\n/root-only.ts\nbuild/\n");
    await mkdir(join(sessionCwd, "build"));
    await mkdir(join(sessionCwd, "pkg"));
    await writeFile(join(sessionCwd, "build", "out.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "root-only.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "pkg", "root-only.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "keep.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "drop.log"), "noise\n");

    expect(listingOf(await tool.execute({ pattern: "*.ts" })).sort()).toEqual([
      "keep.ts",
      "pkg/root-only.ts",
    ]);
  });

  it("searches an explicitly selected ignored directory", async () => {
    await writeFile(join(sessionCwd, ".gitignore"), "build/\n");
    await mkdir(join(sessionCwd, "build"));
    await writeFile(join(sessionCwd, "build", "out.ts"), "export {}\n");

    expect(
      listingOf(await tool.execute({ pattern: "*.ts", path: "build" })),
    ).toEqual(["out.ts"]);
  });

  it("does not follow directory or file symlinks found while walking", async () => {
    await mkdir(join(sessionCwd, "real"));
    await writeFile(join(sessionCwd, "real", "a.ts"), "export {}\n");
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

    expect(listingOf(await tool.execute({ pattern: "*.ts" })).sort()).toEqual([
      "file-link.ts",
      "real/a.ts",
    ]);
    expect(listingOf(await tool.execute({ pattern: "dir-link/**" }))).toEqual([]);
  });

  it("returns No files found matching pattern when nothing hits", async () => {
    await mkdir(join(sessionCwd, "empty"));
    await writeFile(join(sessionCwd, "a.txt"), "nothing here\n");

    await expect(tool.execute({ pattern: "nothing-matches" })).resolves.toMatchObject({
      content: [{ type: "text", text: "No files found matching pattern" }],
      details: undefined,
    });
    await expect(
      tool.execute({ pattern: "*.ts", path: "empty" }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "No files found matching pattern" }],
      details: undefined,
    });
  });

  it("appends the Pi result-limit notice and doubles the suggested limit", async () => {
    await writeFile(join(sessionCwd, "a.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "b.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "c.ts"), "export {}\n");

    const result = await tool.execute({ pattern: "*.ts", limit: 2 });
    expect(listingOf(result)).toHaveLength(2);
    expect(noticeOf(result)).toBe(
      "[2 results limit reached. Use limit=4 for more, or refine pattern]",
    );
    expect(result.details).toMatchObject({ resultLimitReached: 2 });
    expect(result.details?.truncation).toBeUndefined();
  });

  it("truncates by 50KB and appends the size-limit notice", async () => {
    const operations: FindOperations = {
      exists: async () => true,
      glob: async () =>
        Array.from({ length: 20 }, (_, index) => `${"x".repeat(4000)}-${index}.ts`),
    };
    const isolated = createFindTool({ sessionCwd, operations });
    const result = await isolated.execute({ pattern: "*.ts" });
    expect(noticeOf(result)).toContain("50.0KB limit reached");
    expect(result.details?.truncation?.truncated).toBe(true);
    expect(result.details?.truncation?.truncatedBy).toBe("bytes");
    expect(listingOf(result).length).toBeGreaterThan(0);
    expect(listingOf(result).length).toBeLessThan(20);
  });

  it("uses a shorter notice for custom glob when the result limit is hit", async () => {
    const operations: FindOperations = {
      exists: async () => true,
      glob: async () => ["a.ts", "b.ts", "c.ts"],
    };
    const isolated = createFindTool({ sessionCwd, operations });
    const result = await isolated.execute({ pattern: "*.ts", limit: 3 });
    expect(listingOf(result)).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(noticeOf(result)).toBe("[3 results limit reached]");
    expect(result.details).toMatchObject({ resultLimitReached: 3 });
  });

  it("rejects a missing path with the Pi message when using custom glob", async () => {
    const operations: FindOperations = {
      exists: async () => false,
      glob: async () => [],
    };
    const isolated = createFindTool({ sessionCwd, operations });
    await expect(
      isolated.execute({ pattern: "*", path: "missing" }),
    ).rejects.toThrow(`Path not found: ${join(sessionCwd, "missing")}`);
  });

  it("rejects a missing path from fd", async () => {
    await expect(tool.execute({ pattern: "*", path: "missing" })).rejects.toThrow(
      /missing/,
    );
  });

  it("resolves a relative path against Session cwd, not process cwd", async () => {
    await mkdir(join(sessionCwd, "nested"));
    await writeFile(join(sessionCwd, "nested", "here.ts"), "export {}\n");
    const other = await mkdtemp(join(tmpdir(), "susan-find-other-"));
    const previous = process.cwd();
    try {
      process.chdir(other);
      await mkdir(join(other, "nested"));
      await writeFile(join(other, "nested", "wrong.ts"), "export {}\n");
      expect(
        listingOf(await tool.execute({ pattern: "*.ts", path: "nested" })),
      ).toEqual(["here.ts"]);
    } finally {
      process.chdir(previous);
      await rm(other, { force: true, recursive: true });
    }
  });

  it("searches an absolute path outside Session cwd", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-find-outside-"));
    try {
      await writeFile(join(outside, "abs.ts"), "export {}\n");
      expect(
        listingOf(await tool.execute({ pattern: "*.ts", path: outside })),
      ).toEqual(["abs.ts"]);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("maps an already-aborted signal to Operation aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute({ pattern: "*" }, controller.signal)).rejects.toThrow(
      "Operation aborted",
    );
  });

  it("uses custom glob results and relativizes them", async () => {
    const operations: FindOperations = {
      exists: async () => true,
      glob: async () => [join(sessionCwd, "src", "a.ts"), "relative.ts"],
    };
    const isolated = createFindTool({ sessionCwd, operations });
    expect(listingOf(await isolated.execute({ pattern: "*.ts" }))).toEqual([
      "src/a.ts",
      "relative.ts",
    ]);
  });

  it("fails when fd cannot be resolved", async () => {
    const isolatedBin = await mkdtemp(join(tmpdir(), "susan-find-nofd-"));
    const previousPath = process.env.PATH;
    const previousBin = process.env.SUSAN_BIN_DIR;
    const previousOffline = process.env.SUSAN_OFFLINE;
    process.env.PATH = "/nonexistent";
    process.env.SUSAN_BIN_DIR = isolatedBin;
    process.env.SUSAN_OFFLINE = "1";
    try {
      await expect(tool.execute({ pattern: "*" })).rejects.toThrow(
        "fd is not available and could not be downloaded",
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

describe("relativizeFindResultPath", () => {
  describe("Windows drive root", () => {
    const searchRoot = "I:\\";

    it("preserves the first segment and emits one trailing slash for fd directory output", () => {
      expect(
        relativizeFindResultPath("I:\\AI\\Models\\TextGen\\gemma4\\", searchRoot, win32),
      ).toBe("AI/Models/TextGen/gemma4/");
    });

    it("handles fd output that uses forward slashes under a drive root", () => {
      expect(
        relativizeFindResultPath("I:/AI/Models/TextGen/gemma4/", searchRoot, win32),
      ).toBe("AI/Models/TextGen/gemma4/");
    });

    it("keeps deeper search paths unchanged", () => {
      expect(relativizeFindResultPath("I:\\AI\\Models\\", "I:\\AI", win32)).toBe(
        "Models/",
      );
    });

    it("does not relativize a sibling directory that shares a name prefix", () => {
      expect(
        relativizeFindResultPath("I:\\AI\\Models2\\file.txt", "I:\\AI\\Models", win32),
      ).toBe("../Models2/file.txt");
    });

    it("normalizes relative custom-glob results without corrupting them", () => {
      expect(
        relativizeFindResultPath("AI\\Models\\TextGen\\gemma4\\", searchRoot, win32),
      ).toBe("AI/Models/TextGen/gemma4/");
    });
  });

  describe("POSIX root", () => {
    it("preserves the first segment for files under /", () => {
      expect(relativizeFindResultPath("/home/user/file.txt", "/", posix)).toBe(
        "home/user/file.txt",
      );
    });

    it("preserves the first segment and one trailing slash for directories under /", () => {
      expect(relativizeFindResultPath("/home/user/project/", "/", posix)).toBe(
        "home/user/project/",
      );
    });

    it("preserves backslashes in POSIX filenames", () => {
      expect(relativizeFindResultPath("/home/user/file\\", "/home/user", posix)).toBe(
        "file\\",
      );
    });
  });

  it("falls back to path.relative when the absolute paths do not share a prefix", () => {
    expect(
      relativizeFindResultPath("/tmp/results/file.txt", "/workspace/project", posix),
    ).toBe("../../tmp/results/file.txt");
  });

  it("keeps a trailing slash on directories resolved through path.relative", () => {
    expect(
      relativizeFindResultPath("/tmp/results/dir/", "/workspace/project", posix),
    ).toBe("../../tmp/results/dir/");
  });

  it("relativizes custom glob results against a root search path", async () => {
    const isolated = createFindTool({
      sessionCwd: "/",
      operations: {
        exists: () => true,
        glob: () => ["/home/user/project/", "/home/user/project/file.txt"],
      },
    });
    const result = await isolated.execute({ pattern: "**" });
    expect(textOf(result)).toBe("home/user/project/\nhome/user/project/file.txt");
  });
});
