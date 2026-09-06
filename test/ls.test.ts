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
      ok: true,
      result: {
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
      ok: true,
      result: {
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

    await expect(tool.execute({ path: "." })).resolves.toEqual({
      ok: true,
      result: {
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
      ok: true,
      result: {
        entries: [
          { name: ".gitignore", type: "file" },
          { name: "nested.log", type: "file" },
        ],
      },
    });

    await expect(tool.execute({ includeIgnored: true })).resolves.toMatchObject({
      ok: true,
      result: {
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
    await expect(tool.execute({ path: ".", glob: "*" })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "glob" } },
    });
    await expect(tool.execute({ path: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "path" } },
    });
    await expect(tool.execute({ includeIgnored: "yes" })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "includeIgnored" } },
    });
    await expect(tool.execute({ limit: 1.5 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "limit" } },
    });
    await expect(tool.execute({ limit: 0 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_LIMIT", details: { field: "limit" } },
    });
    await expect(tool.execute({ limit: LS_MAX_LIMIT + 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_LIMIT", details: { field: "limit" } },
    });
    await expect(tool.execute({ offset: -1 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_OFFSET", details: { field: "offset" } },
    });
  });

  it("returns typed failures for missing, non-directory, and unreadable roots", async () => {
    const missing = join(sessionCwd, "missing");
    const file = join(sessionCwd, "file.txt");
    await writeFile(file, "not a dir\n");

    await expect(tool.execute({ path: "missing" })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "ENOENT",
        details: { resolvedPath: missing, cwdRelation: "inside" },
      },
    });
    await expect(tool.execute({ path: "file.txt" })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "ENOTDIR",
        details: {
          resolvedPath: file,
          realTargetPath: await realpath(file),
          cwdRelation: "inside",
        },
      },
    });
  });

  it.skipIf(!POSIX)("fails closed when the target directory cannot be read", async () => {
    const locked = join(sessionCwd, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      await expect(tool.execute({ path: "locked" })).resolves.toMatchObject({
        ok: false,
        error: {
          code: "EACCES",
          details: {
            resolvedPath: locked,
            cwdRelation: "inside",
          },
        },
      });
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
      ok: true,
      result: {
        entries: [
          { name: "a.ts", type: "file" },
          { name: "b.ts", type: "file" },
        ],
        diagnostics: [],
      },
      meta: {
        truncation: {
          reasons: ["items"],
          strategy: "head",
          fields: ["entries"],
          retained: { items: 2 },
          total: { items: 4 },
          nextArguments: { path: ".", offset: 2, limit: 2 },
        },
      },
    });

    const second = await tool.execute(
      first.ok ? first.meta?.truncation?.nextArguments : undefined,
    );
    expect(second).toMatchObject({
      ok: true,
      result: {
        entries: [
          { name: "c.ts", type: "file" },
          { name: "d.ts", type: "file" },
        ],
      },
    });
    expect(second.ok && second.meta?.truncation).toBeUndefined();

    await expect(tool.execute({ offset: 4 })).resolves.toMatchObject({
      ok: true,
      result: { entries: [], diagnostics: [] },
    });
    await expect(tool.execute({ offset: 100 })).resolves.toMatchObject({
      ok: true,
      result: { entries: [] },
    });
  });

  it("records a Traversal Diagnostic for an invalid UTF-8 .gitignore and continues", async () => {
    await writeFile(join(sessionCwd, ".gitignore"), Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFile(join(sessionCwd, "keep.ts"), "export {}\n");

    await expect(tool.execute({})).resolves.toEqual({
      ok: true,
      result: {
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

    await expect(tool.execute({})).resolves.toEqual({
      ok: true,
      result: {
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

      await expect(tool.execute({ path: "linked" })).resolves.toEqual({
        ok: true,
        result: {
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
        ok: true,
        result: {
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

  it("truncates oversized pages at 50 KiB and continues from the first omitted entry", async () => {
    const names = Array.from({ length: 300 }, (_, index) =>
      `${"x".repeat(180)}-${String(index).padStart(3, "0")}`,
    );
    for (const name of names) {
      await writeFile(join(sessionCwd, name), "ok\n");
    }

    const first = await tool.execute({});
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.meta?.truncation?.reasons).toContain("bytes");
    expect(first.meta?.truncation?.fields).toContain("entries");
    expect(first.meta?.truncation?.nextArguments).toMatchObject({
      path: ".",
      limit: LS_DEFAULT_LIMIT,
    });
    const retained = first.result.entries as readonly { readonly name: string }[];
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(names.length);
    expect(retained[0]?.name).toBe(names[0]);

    const nextOffset = first.meta?.truncation?.nextArguments?.offset;
    expect(nextOffset).toBe(retained.length);

    const second = await tool.execute(first.meta?.truncation?.nextArguments);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    const next = second.result.entries as readonly { readonly name: string }[];
    expect(next[0]?.name).toBe(names[retained.length]);
  });

  it("maps an already-aborted timeout signal to ETIMEDOUT", async () => {
    const signal = AbortSignal.timeout(0);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(tool.execute({}, signal)).resolves.toMatchObject({
      ok: false,
      error: { code: "ETIMEDOUT" },
    });
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
        ok: true,
        result: {
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
      ok: true,
      result: { entries: [{ name: ".gitignore", type: "file" }] },
      meta: {
        truncation: {
          nextArguments: {
            path: ".",
            offset: 1,
            limit: 1,
            includeIgnored: true,
          },
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

    await expect(isolated.execute({})).resolves.toMatchObject({
      ok: false,
      error: { code: "ETIMEDOUT" },
    });
  });

  it("maps a cancelled AbortSignal to ETOOL", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(tool.execute({}, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: "ETOOL" },
    });
  });
});
