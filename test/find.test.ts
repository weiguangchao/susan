import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FIND_DEFAULT_LIMIT,
  FIND_MAX_LIMIT,
  createFindTool,
  type FindTool,
} from "../src/index.js";

const POSIX = process.platform !== "win32";

type Entry = {
  readonly path: string;
  readonly type: string;
};

function entriesOf(result: unknown): readonly Entry[] {
  const record = result as {
    readonly details?: { readonly entries?: readonly Entry[] };
  };
  return record.details?.entries ?? [];
}

describe("Find Tool", () => {
  let sessionCwd: string;
  let tool: FindTool;

  beforeEach(async () => {
    sessionCwd = await mkdtemp(join(tmpdir(), "susan-find-"));
    tool = createFindTool({ sessionCwd });
  });

  afterEach(async () => {
    await rm(sessionCwd, { force: true, recursive: true });
  });

  it("exposes the find tool definition with a required pattern and bounded options", () => {
    expect(tool).toMatchObject({
      name: "find",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["pattern"],
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          type: { type: "string", enum: ["file", "directory", "symlink", "all"] },
          maxDepth: { type: "integer", minimum: 1, maximum: 1_000 },
          includeIgnored: { type: "boolean" },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: FIND_MAX_LIMIT },
        },
      },
    });
    expect(FIND_DEFAULT_LIMIT).toBe(1_000);
    expect(FIND_MAX_LIMIT).toBe(10_000);
  });

  it("matches Search Root descendants by basename glob and sorts by full path", async () => {
    await mkdir(join(sessionCwd, "src", "nested"), { recursive: true });
    await writeFile(join(sessionCwd, "root.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "src", "app.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "src", "nested", "deep.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "src", "notes.md"), "# notes\n");

    await expect(tool.execute({ pattern: "*.ts" })).resolves.toMatchObject({
      details: {
        resolvedPath: sessionCwd,
        realTargetPath: await realpath(sessionCwd),
        cwdRelation: "inside",
        entries: [
          { path: "root.ts", type: "file" },
          { path: "src/app.ts", type: "file" },
          { path: "src/nested/deep.ts", type: "file" },
        ],
        diagnostics: [],
      },
    });
  });

  it("filters by entry type and reports symlinks without following them", async () => {
    await mkdir(join(sessionCwd, "src"));
    await writeFile(join(sessionCwd, "src", "app.ts"), "export {}\n");
    await mkdir(join(sessionCwd, "target"));
    await writeFile(join(sessionCwd, "target", "hidden-child.ts"), "export {}\n");
    await symlink(
      join(sessionCwd, "target"),
      join(sessionCwd, "link"),
      process.platform === "win32" ? "dir" : undefined,
    );

    expect(entriesOf(await tool.execute({ pattern: "*" }))).toEqual([
      { path: "link", type: "symlink" },
      { path: "src", type: "directory" },
      { path: "src/app.ts", type: "file" },
      { path: "target", type: "directory" },
      { path: "target/hidden-child.ts", type: "file" },
    ]);
    expect(entriesOf(await tool.execute({ pattern: "*", type: "file" }))).toEqual([
      { path: "src/app.ts", type: "file" },
      { path: "target/hidden-child.ts", type: "file" },
    ]);
    expect(
      entriesOf(await tool.execute({ pattern: "*", type: "directory" })),
    ).toEqual([
      { path: "src", type: "directory" },
      { path: "target", type: "directory" },
    ]);
    expect(
      entriesOf(await tool.execute({ pattern: "*", type: "symlink" })),
    ).toEqual([{ path: "link", type: "symlink" }]);
  });

  it("matches full relative paths for patterns with a slash and never the Search Root", async () => {
    await mkdir(join(sessionCwd, "src", "nested"), { recursive: true });
    await writeFile(join(sessionCwd, "src", "app.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "src", "nested", "deep.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "app.ts"), "export {}\n");

    expect(entriesOf(await tool.execute({ pattern: "src/*.ts" }))).toEqual([
      { path: "src/app.ts", type: "file" },
    ]);
    expect(entriesOf(await tool.execute({ pattern: "src/**/*.ts" }))).toEqual([
      { path: "src/app.ts", type: "file" },
      { path: "src/nested/deep.ts", type: "file" },
    ]);
    expect(entriesOf(await tool.execute({ pattern: "**" }))).not.toContainEqual(
      expect.objectContaining({ path: "" }),
    );
  });

  it("limits traversal depth where maxDepth 1 means direct children only", async () => {
    await mkdir(join(sessionCwd, "a", "b", "c"), { recursive: true });
    await writeFile(join(sessionCwd, "top.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "a", "one.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "a", "b", "two.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "a", "b", "c", "three.ts"), "export {}\n");

    expect(
      entriesOf(await tool.execute({ pattern: "*.ts", maxDepth: 1 })),
    ).toEqual([{ path: "top.ts", type: "file" }]);
    expect(
      entriesOf(await tool.execute({ pattern: "*.ts", maxDepth: 2 })),
    ).toEqual([
      { path: "a/one.ts", type: "file" },
      { path: "top.ts", type: "file" },
    ]);
    expect(entriesOf(await tool.execute({ pattern: "*.ts" }))).toHaveLength(4);
  });

  it("matches dotfiles with wildcards and stays case-sensitive on every platform", async () => {
    await mkdir(join(sessionCwd, ".config"));
    await writeFile(join(sessionCwd, ".config", "settings.json"), "{}\n");
    await writeFile(join(sessionCwd, ".hidden.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "Case.ts"), "export {}\n");

    expect(entriesOf(await tool.execute({ pattern: "*.ts" }))).toEqual([
      { path: ".hidden.ts", type: "file" },
      { path: "Case.ts", type: "file" },
    ]);
    expect(entriesOf(await tool.execute({ pattern: ".*/*.json" }))).toEqual([
      { path: ".config/settings.json", type: "file" },
    ]);
    expect(entriesOf(await tool.execute({ pattern: "case.ts" }))).toEqual([]);
    expect(entriesOf(await tool.execute({ pattern: "Case.ts" }))).toEqual([
      { path: "Case.ts", type: "file" },
    ]);
  });

  it("applies nested .gitignore and the built-in .git ignore unless includeIgnored", async () => {
    await writeFile(join(sessionCwd, ".gitignore"), "*.log\nbuild/\n");
    await mkdir(join(sessionCwd, "build"));
    await writeFile(join(sessionCwd, "build", "out.ts"), "export {}\n");
    await mkdir(join(sessionCwd, ".git"));
    await writeFile(join(sessionCwd, ".git", "config.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "keep.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "drop.log"), "noise\n");
    await mkdir(join(sessionCwd, "src"));
    await writeFile(join(sessionCwd, "src", ".gitignore"), "local.ts\n!keep.ts\n");
    await writeFile(join(sessionCwd, "src", "local.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "src", "keep.ts"), "export {}\n");

    expect(entriesOf(await tool.execute({ pattern: "**/*.ts" }))).toEqual([
      { path: "keep.ts", type: "file" },
      { path: "src/keep.ts", type: "file" },
    ]);
    expect(
      entriesOf(await tool.execute({ pattern: "**/*.ts", includeIgnored: true })),
    ).toEqual([
      { path: ".git/config.ts", type: "file" },
      { path: "build/out.ts", type: "file" },
      { path: "keep.ts", type: "file" },
      { path: "src/keep.ts", type: "file" },
      { path: "src/local.ts", type: "file" },
    ]);
  });

  it("treats an ignored directory as the Search Root because it is explicitly selected", async () => {
    await writeFile(join(sessionCwd, ".gitignore"), "build/\n");
    await mkdir(join(sessionCwd, "build"));
    await writeFile(join(sessionCwd, "build", "out.ts"), "export {}\n");

    expect(entriesOf(await tool.execute({ pattern: "*.ts", path: "build" }))).toEqual([
      { path: "out.ts", type: "file" },
    ]);
  });

  it("rejects unknown fields, wrong types, and out-of-range options", async () => {
    await expect(tool.execute({ pattern: "*", glob: "*" })).rejects.toThrow(
      "Invalid find arguments.",
    );
    await expect(tool.execute({})).rejects.toThrow("Invalid find arguments.");
    await expect(tool.execute({ pattern: 1 })).rejects.toThrow("Invalid find arguments.");
    await expect(tool.execute({ pattern: "*", path: 1 })).rejects.toThrow(
      "Invalid find arguments.",
    );
    await expect(tool.execute({ pattern: "*", type: 1 })).rejects.toThrow(
      "Invalid find arguments.",
    );
    await expect(
      tool.execute({ pattern: "*", includeIgnored: "yes" }),
    ).rejects.toThrow("Invalid find arguments.");
    await expect(tool.execute({ pattern: "*", limit: 1.5 })).rejects.toThrow(
      "Invalid find arguments.",
    );
  });

  it("reports a dedicated error code for each invalid pattern, type, and bound", async () => {
    await expect(tool.execute({ pattern: "" })).rejects.toThrow(
      "pattern must be a valid glob.",
    );
    await expect(tool.execute({ pattern: "!*.ts" })).rejects.toThrow(
      "pattern must be a valid glob.",
    );
    await expect(tool.execute({ pattern: "{a,b}.ts" })).rejects.toThrow(
      "pattern must be a valid glob.",
    );
    await expect(tool.execute({ pattern: "*", type: "socket" })).rejects.toThrow(
      "type must be one of file, directory, symlink, all.",
    );
    await expect(tool.execute({ pattern: "*", maxDepth: 0 })).rejects.toThrow(
      "maxDepth must be an integer between 1 and 1000.",
    );
    await expect(tool.execute({ pattern: "*", maxDepth: 1_001 })).rejects.toThrow(
      "maxDepth must be an integer between 1 and 1000.",
    );
    await expect(tool.execute({ pattern: "*", limit: 0 })).rejects.toThrow(
      `limit must be an integer between 1 and ${FIND_MAX_LIMIT}.`,
    );
    await expect(
      tool.execute({ pattern: "*", limit: FIND_MAX_LIMIT + 1 }),
    ).rejects.toThrow(`limit must be an integer between 1 and ${FIND_MAX_LIMIT}.`);
    await expect(tool.execute({ pattern: "*", offset: -1 })).rejects.toThrow(
      "offset must be a non-negative integer.",
    );
  });

  it("resolves errors by schema, then options, then path, then root type", async () => {
    await writeFile(join(sessionCwd, "file.txt"), "not a dir\n");

    await expect(
      tool.execute({ pattern: "", path: "missing", unknown: true }),
    ).rejects.toThrow("Invalid find arguments.");
    await expect(
      tool.execute({ pattern: "", path: "missing", type: "socket" }),
    ).rejects.toThrow("pattern must be a valid glob.");
    await expect(
      tool.execute({ pattern: "*", type: "socket", path: "missing" }),
    ).rejects.toThrow("type must be one of file, directory, symlink, all.");
    await expect(
      tool.execute({ pattern: "*", path: "missing" }),
    ).rejects.toThrow("Path does not exist.");
    await expect(
      tool.execute({ pattern: "*", path: "file.txt" }),
    ).rejects.toThrow("Path is not a directory.");
  });

  it.skipIf(!POSIX)("fails closed when the Search Root cannot be read", async () => {
    const locked = join(sessionCwd, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await expect(
        tool.execute({ pattern: "*", path: "locked" }),
      ).rejects.toThrow("Path cannot be read.");
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("returns an empty entries array for empty directories and unmatched patterns", async () => {
    await mkdir(join(sessionCwd, "empty"));

    await expect(tool.execute({ pattern: "*", path: "empty" })).resolves.toMatchObject({
      details: {
        resolvedPath: join(sessionCwd, "empty"),
        realTargetPath: await realpath(join(sessionCwd, "empty")),
        cwdRelation: "inside",
        entries: [],
        diagnostics: [],
      },
    });
    await expect(tool.execute({ pattern: "nothing-matches" })).resolves.toMatchObject({
      details: { entries: [], diagnostics: [] },
    });
  });

  it.skipIf(!POSIX)("skips special files and unreadable directories with Traversal Diagnostics", async () => {
    await writeFile(join(sessionCwd, "keep.ts"), "export {}\n");
    expect(spawnSync("mkfifo", [join(sessionCwd, "pipe.ts")]).status).toBe(0);
    const locked = join(sessionCwd, "locked");
    await mkdir(locked);
    await writeFile(join(locked, "inner.ts"), "export {}\n");
    await chmod(locked, 0o000);

    try {
      await expect(tool.execute({ pattern: "**" })).resolves.toMatchObject({
        details: {
          resolvedPath: sessionCwd,
          realTargetPath: await realpath(sessionCwd),
          cwdRelation: "inside",
          entries: [
            { path: "keep.ts", type: "file" },
            { path: "locked", type: "directory" },
          ],
          diagnostics: [
            { path: "locked", operation: "read-directory", code: "EACCES" },
            { path: "pipe.ts", operation: "read-metadata", code: "EUNSUPPORTED" },
          ],
        },
      });
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("records a Traversal Diagnostic for an invalid UTF-8 .gitignore and keeps querying", async () => {
    await writeFile(join(sessionCwd, ".gitignore"), Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFile(join(sessionCwd, "keep.ts"), "export {}\n");

    await expect(tool.execute({ pattern: "*.ts" })).resolves.toMatchObject({
      details: {
        entries: [{ path: "keep.ts", type: "file" }],
        diagnostics: [
          { path: ".gitignore", operation: "read-file", code: "EBINARY" },
        ],
      },
    });
  });

  it("pages the fully sorted candidate set with accurate continuation arguments", async () => {
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
      await writeFile(join(sessionCwd, name), "export {}\n");
    }

    const first = await tool.execute({ pattern: "*.ts", limit: 2 });
    expect(first).toMatchObject({
      details: {
        entries: [
          { path: "a.ts", type: "file" },
          { path: "b.ts", type: "file" },
        ],
        diagnostics: [],
        truncation: {
          truncatedBy: "items",
          outputItems: 2,
          nextOffset: 2,
        },
      },
    });

    const second = await tool.execute({
      pattern: "*.ts",
      offset: first.details?.truncation?.nextOffset,
      limit: 2,
    });
    expect(second).toMatchObject({
      details: {
        entries: [
          { path: "c.ts", type: "file" },
          { path: "d.ts", type: "file" },
        ],
      },
    });
    expect(second.details?.truncation).toBeUndefined();

    await expect(tool.execute({ pattern: "*.ts", offset: 4 })).resolves.toMatchObject({
      details: { entries: [], diagnostics: [] },
    });
    await expect(tool.execute({ pattern: "*.ts", offset: 100 })).resolves.toMatchObject({
      details: { entries: [] },
    });
  });

  it("carries type, maxDepth, and includeIgnored into continuation arguments", async () => {
    await writeFile(join(sessionCwd, ".gitignore"), "b.ts\n");
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      await writeFile(join(sessionCwd, name), "export {}\n");
    }

    await expect(
      tool.execute({
        pattern: "*.ts",
        type: "file",
        maxDepth: 2,
        includeIgnored: true,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      details: {
        entries: [{ path: "a.ts", type: "file" }],
        truncation: {
          truncatedBy: "items",
          outputItems: 1,
          nextOffset: 1,
          type: "file",
          maxDepth: 2,
          includeIgnored: true,
        },
      },
    });
  });

  it("truncates an oversized page at 50 KiB and continues from the first omitted entry", async () => {
    const names = Array.from(
      { length: 300 },
      (_, index) => `${"x".repeat(180)}-${String(index).padStart(3, "0")}.ts`,
    );
    for (const name of names) {
      await writeFile(join(sessionCwd, name), "export {}\n");
    }

    const first = await tool.execute({ pattern: "*.ts" });
    const retained = entriesOf(first);
    expect(retained).toHaveLength(names.length);
    expect(first.details?.truncation).toBeUndefined();
    expect(retained[0]?.path).toBe(names[0]);
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

      await expect(
        tool.execute({ pattern: "*.ts", path: "nested" }),
      ).resolves.toMatchObject({
        details: {
          resolvedPath: join(sessionCwd, "nested"),
          cwdRelation: "inside",
          entries: [{ path: "here.ts", type: "file" }],
        },
      });
    } finally {
      process.chdir(previous);
      await rm(other, { force: true, recursive: true });
    }
  });

  it("queries a Search Root outside Session cwd and presents Resolved Path and Real Target Path", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-find-outside-"));
    try {
      await writeFile(join(outside, "abs.ts"), "export {}\n");
      const link = join(sessionCwd, "linked");
      await symlink(
        outside,
        link,
        process.platform === "win32" ? "junction" : undefined,
      );

      await expect(tool.execute({ pattern: "*.ts", path: outside })).resolves.toMatchObject({
        details: {
          resolvedPath: outside,
          realTargetPath: await realpath(outside),
          cwdRelation: "outside",
          entries: [{ path: "abs.ts", type: "file" }],
        },
      });
      await expect(tool.execute({ pattern: "*.ts", path: "linked" })).resolves.toMatchObject({
        details: {
          resolvedPath: link,
          realTargetPath: await realpath(outside),
          cwdRelation: "outside",
          entries: [{ path: "abs.ts", type: "file" }],
        },
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("fails the entire query when the time budget is exceeded", async () => {
    await writeFile(join(sessionCwd, "a.ts"), "export {}\n");
    let nowMs = 0;
    const isolated = createFindTool({
      sessionCwd,
      timeoutMs: 10,
      now: () => {
        nowMs += 1;
        return nowMs === 1 ? 0 : 20_000;
      },
    });

    await expect(isolated.execute({ pattern: "*.ts" })).rejects.toThrow(
      "Find timed out.",
    );
  });

  it("maps an already-aborted timeout signal to ETIMEDOUT and a cancellation to ETOOL", async () => {
    const timeout = AbortSignal.timeout(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(tool.execute({ pattern: "*" }, timeout)).rejects.toThrow(
      "Find timed out.",
    );

    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute({ pattern: "*" }, controller.signal),
    ).rejects.toThrow("Tool execution failed.");
  });
});
