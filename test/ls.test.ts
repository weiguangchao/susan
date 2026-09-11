import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LS_DEFAULT_LIMIT,
  LS_MAX_LIMIT,
  createLsTool,
  type LsTool,
} from "../src/index.js";

const POSIX = process.platform !== "win32";

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

  it("exposes the ls tool definition with optional path and pagination fields", () => {
    expect(tool).toMatchObject({
      name: "ls",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          includeIgnored: { type: "boolean" },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: LS_MAX_LIMIT },
        },
      },
    });
    expect(LS_DEFAULT_LIMIT).toBe(500);
    expect(LS_MAX_LIMIT).toBe(5_000);
  });

  it("lists an empty directory at the default path", async () => {
    const result = await tool.execute({});

    expect(result).toEqual({
      content: [{ type: "text", text: "" }],
      details: {
        resolvedPath: sessionCwd,
        realTargetPath: await realpath(sessionCwd),
        cwdRelation: "inside",
        entries: [],
        diagnostics: [],
      },
    });
  });

  it("lists direct children by UTF-16 name order without recursion or extra metadata", async () => {
    await mkdir(join(sessionCwd, "src", "nested"), { recursive: true });
    await writeFile(join(sessionCwd, "README.md"), "hi\n");
    await writeFile(join(sessionCwd, ".hidden"), "secret\n");
    await writeFile(join(sessionCwd, "src", "index.ts"), "export {}\n");
    await symlink(
      join(sessionCwd, "src"),
      join(sessionCwd, "link"),
      process.platform === "win32" ? "dir" : undefined,
    );

    const result = await tool.execute({ path: "." });

    expect(result).toEqual({
      content: [{ type: "text", text: ".hidden\nREADME.md\nlink@\nsrc/" }],
      details: {
        resolvedPath: sessionCwd,
        realTargetPath: await realpath(sessionCwd),
        cwdRelation: "inside",
        entries: [
          { name: ".hidden", type: "file" },
          { name: "README.md", type: "file" },
          { name: "link", type: "symlink" },
          { name: "src", type: "directory" },
        ],
        diagnostics: [],
      },
    });
  });

  it("applies only the target directory .gitignore and ignores .git unless includeIgnored", async () => {
    await writeFile(join(sessionCwd, ".gitignore"), "*.log\nbuild/\n");
    await writeFile(join(sessionCwd, "keep.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "drop.log"), "noise\n");
    await mkdir(join(sessionCwd, "build"));
    await mkdir(join(sessionCwd, ".git"));
    await writeFile(join(sessionCwd, ".git", "HEAD"), "ref: refs/heads/dev\n");
    await mkdir(join(sessionCwd, "src"));
    await writeFile(join(sessionCwd, "src", ".gitignore"), "keep.ts\n");
    await writeFile(join(sessionCwd, "src", "keep.ts"), "export {}\n");
    await writeFile(join(sessionCwd, "src", "nested.log"), "noise\n");

    await expect(tool.execute({ path: "." })).resolves.toMatchObject({
      details: {
        resolvedPath: sessionCwd,
        realTargetPath: await realpath(sessionCwd),
        cwdRelation: "inside",
        entries: [
          { name: ".gitignore", type: "file" },
          { name: "keep.ts", type: "file" },
          { name: "src", type: "directory" },
        ],
        diagnostics: [],
      },
    });

    await expect(tool.execute({ path: "src" })).resolves.toMatchObject({
      details: {
        entries: [
          { name: ".gitignore", type: "file" },
          { name: "nested.log", type: "file" },
        ],
      },
    });

    await expect(tool.execute({ includeIgnored: true })).resolves.toMatchObject({
      details: {
        entries: [
          { name: ".git", type: "directory" },
          { name: ".gitignore", type: "file" },
          { name: "build", type: "directory" },
          { name: "drop.log", type: "file" },
          { name: "keep.ts", type: "file" },
          { name: "src", type: "directory" },
        ],
      },
    });
  });

  it("rejects unknown fields, wrong types, and out-of-range pagination", async () => {
    await expect(tool.execute({ path: ".", glob: "*" })).rejects.toThrow(
      "Invalid ls arguments.",
    );
    await expect(tool.execute({ path: 1 })).rejects.toThrow("Invalid ls arguments.");
    await expect(tool.execute({ includeIgnored: "yes" })).rejects.toThrow(
      "Invalid ls arguments.",
    );
    await expect(tool.execute({ limit: 1.5 })).rejects.toThrow("Invalid ls arguments.");
    await expect(tool.execute({ limit: 0 })).rejects.toThrow(
      `limit must be an integer between 1 and ${LS_MAX_LIMIT}.`,
    );
    await expect(tool.execute({ limit: LS_MAX_LIMIT + 1 })).rejects.toThrow(
      `limit must be an integer between 1 and ${LS_MAX_LIMIT}.`,
    );
    await expect(tool.execute({ offset: -1 })).rejects.toThrow(
      "offset must be a non-negative integer.",
    );
  });

  it("returns typed failures for missing, non-directory, and unreadable roots", async () => {
    const missing = join(sessionCwd, "missing");
    const file = join(sessionCwd, "file.txt");
    await writeFile(file, "not a dir\n");

    await expect(tool.execute({ path: "missing" })).rejects.toThrow(
      "Path does not exist.",
    );
    await expect(tool.execute({ path: "file.txt" })).rejects.toThrow(
      "Path is not a directory.",
    );
  });

  it.skipIf(!POSIX)("fails closed when the target directory cannot be read", async () => {
    const locked = join(sessionCwd, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await expect(tool.execute({ path: "locked" })).rejects.toThrow(
        "Path cannot be read.",
      );
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("pages sorted entries with limit, offset, and accurate continuation", async () => {
    await writeFile(join(sessionCwd, "a.ts"), "a\n");
    await writeFile(join(sessionCwd, "b.ts"), "b\n");
    await writeFile(join(sessionCwd, "c.ts"), "c\n");
    await writeFile(join(sessionCwd, "d.ts"), "d\n");

    const first = await tool.execute({ limit: 2 });
    expect(first).toMatchObject({
      content: [{
        type: "text",
        text: "a.ts\nb.ts\n\n[2 more entries. Use offset=2 to continue.]",
      }],
      details: {
        entries: [
          { name: "a.ts", type: "file" },
          { name: "b.ts", type: "file" },
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
      offset: first.details?.truncation?.nextOffset,
      limit: 2,
    });
    expect(second).toMatchObject({
      details: {
        entries: [
          { name: "c.ts", type: "file" },
          { name: "d.ts", type: "file" },
        ],
      },
    });
    expect(second.details?.truncation).toBeUndefined();

    await expect(tool.execute({ offset: 4 })).resolves.toMatchObject({
      details: { entries: [], diagnostics: [] },
    });
    await expect(tool.execute({ offset: 100 })).resolves.toMatchObject({
      details: { entries: [] },
    });
  });

  it("records a Traversal Diagnostic for an invalid UTF-8 .gitignore and continues", async () => {
    await writeFile(join(sessionCwd, ".gitignore"), Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFile(join(sessionCwd, "keep.ts"), "export {}\n");

    await expect(tool.execute({})).resolves.toMatchObject({
      details: {
        resolvedPath: sessionCwd,
        realTargetPath: await realpath(sessionCwd),
        cwdRelation: "inside",
        entries: [
          { name: ".gitignore", type: "file" },
          { name: "keep.ts", type: "file" },
        ],
        diagnostics: [
          { path: ".gitignore", operation: "read-file", code: "EBINARY" },
        ],
      },
    });
  });

  it.skipIf(!POSIX)("skips special files with an EUNSUPPORTED Traversal Diagnostic", async () => {
    const fifo = join(sessionCwd, "pipe");
    const created = spawnSync("mkfifo", [fifo]);
    expect(created.status).toBe(0);
    await writeFile(join(sessionCwd, "keep.ts"), "export {}\n");

    await expect(tool.execute({})).resolves.toMatchObject({
      details: {
        resolvedPath: sessionCwd,
        realTargetPath: await realpath(sessionCwd),
        cwdRelation: "inside",
        entries: [{ name: "keep.ts", type: "file" }],
        diagnostics: [
          { path: "pipe", operation: "read-metadata", code: "EUNSUPPORTED" },
        ],
      },
    });
  });

  it("follows an entry symlink to a directory and lists the real target", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-ls-outside-"));
    try {
      await writeFile(join(outside, "remote.ts"), "export {}\n");
      const entry = join(sessionCwd, "linked");
      await symlink(
        outside,
        entry,
        process.platform === "win32" ? "junction" : undefined,
      );

      await expect(tool.execute({ path: "linked" })).resolves.toMatchObject({
        details: {
          resolvedPath: entry,
          realTargetPath: await realpath(outside),
          cwdRelation: "outside",
          entries: [{ name: "remote.ts", type: "file" }],
          diagnostics: [],
        },
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("lists an absolute path outside Session cwd and reports cwdRelation outside", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-ls-abs-"));
    try {
      await writeFile(join(outside, "abs.ts"), "export {}\n");
      await expect(tool.execute({ path: outside })).resolves.toMatchObject({
        details: {
          resolvedPath: outside,
          realTargetPath: await realpath(outside),
          cwdRelation: "outside",
          entries: [{ name: "abs.ts", type: "file" }],
        },
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("returns the full page without a truncation note when it fits the limit", async () => {
    const names = Array.from({ length: 300 }, (_, index) =>
      `${"x".repeat(180)}-${String(index).padStart(3, "0")}`,
    );
    for (const name of names) {
      await writeFile(join(sessionCwd, name), "ok\n");
    }

    const first = await tool.execute({});
    expect(first.details?.entries).toHaveLength(names.length);
    expect(first.details?.truncation).toBeUndefined();
    expect(first.details?.entries[0]?.name).toBe(names[0]);
  });

  it("maps an already-aborted timeout signal to ETIMEDOUT", async () => {
    const signal = AbortSignal.timeout(0);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(tool.execute({}, signal)).rejects.toThrow("Ls timed out.");
  });

  it("resolves a relative path against Session cwd, not process cwd", async () => {
    await mkdir(join(sessionCwd, "nested"));
    await writeFile(join(sessionCwd, "nested", "here.ts"), "export {}\n");
    const other = await mkdtemp(join(tmpdir(), "susan-ls-other-"));
    const previous = process.cwd();
    try {
      process.chdir(other);
      await mkdir(join(other, "nested"));
      await writeFile(join(other, "nested", "here.ts"), "wrong\n");
      const result = await tool.execute({ path: "nested" });
      expect(result).toMatchObject({
        details: {
          resolvedPath: join(sessionCwd, "nested"),
          cwdRelation: "inside",
          entries: [{ name: "here.ts", type: "file" }],
        },
      });
    } finally {
      process.chdir(previous);
      await rm(other, { force: true, recursive: true });
    }
  });

  it("keeps includeIgnored in continuation arguments", async () => {
    await writeFile(join(sessionCwd, ".gitignore"), "drop.log\n");
    await writeFile(join(sessionCwd, "a.ts"), "a\n");
    await writeFile(join(sessionCwd, "drop.log"), "noise\n");
    await writeFile(join(sessionCwd, "z.ts"), "z\n");

    const first = await tool.execute({ includeIgnored: true, limit: 1 });
    expect(first).toMatchObject({
      details: {
        entries: [{ name: ".gitignore", type: "file" }],
        truncation: {
          truncatedBy: "items",
          outputItems: 1,
          nextOffset: 1,
          includeIgnored: true,
        },
      },
    });
  });

  it("fails the entire query when the time budget is exceeded", async () => {
    await writeFile(join(sessionCwd, "a.ts"), "export {}\n");
    let nowMs = 0;
    const isolated = createLsTool({
      sessionCwd,
      timeoutMs: 10,
      now: () => {
        nowMs += 1;
        return nowMs === 1 ? 0 : 20_000;
      },
    });

    await expect(isolated.execute({})).rejects.toThrow("Ls timed out.");
  });

  it("maps a cancelled AbortSignal to ETOOL", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(tool.execute({}, controller.signal)).rejects.toThrow(
      "Tool execution failed.",
    );
  });
});
