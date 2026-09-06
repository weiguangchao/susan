import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileGlob, traverse } from "../src/index.js";

describe("compileGlob", () => {
  it("rejects an empty pattern", () => {
    expect(compileGlob("")).toMatchObject({
      ok: false,
      error: { code: "EINVAL_GLOB" },
    });
  });

  it("matches a slash-free pattern against the basename at any depth", () => {
    const compiled = compileGlob("*.ts");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.value.test("a.ts")).toBe(true);
    expect(compiled.value.test("src/a.ts")).toBe(true);
    expect(compiled.value.test("a/b/c.ts")).toBe(true);
    expect(compiled.value.test("a.js")).toBe(false);
    expect(compiled.value.test("a.ts.bak")).toBe(false);
    expect(compiled.value.test("ts")).toBe(false);
  });

  it("matches ? as exactly one character in a path segment", () => {
    const compiled = compileGlob("?.ts");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.value.test("a.ts")).toBe(true);
    expect(compiled.value.test("ab.ts")).toBe(false);
    expect(compiled.value.test(".ts")).toBe(false);
  });

  it("matches a pattern containing / against the full relative path", () => {
    const compiled = compileGlob("src/*.ts");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.value.test("src/a.ts")).toBe(true);
    expect(compiled.value.test("src/b.ts")).toBe(true);
    expect(compiled.value.test("a.ts")).toBe(false);
    expect(compiled.value.test("lib/a.ts")).toBe(false);
    expect(compiled.value.test("src/nested/a.ts")).toBe(false);
  });

  it("lets ** cross directories as a whole path segment", () => {
    const compiled = compileGlob("src/**/*.ts");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.value.test("src/a.ts")).toBe(true);
    expect(compiled.value.test("src/nested/a.ts")).toBe(true);
    expect(compiled.value.test("src/a/b/c.ts")).toBe(true);
    expect(compiled.value.test("lib/a.ts")).toBe(false);
    expect(compiled.value.test("src/a.js")).toBe(false);
  });

  it("matches character classes, ranges, and negation", () => {
    const compiled = compileGlob("src/[ab].ts");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.value.test("src/a.ts")).toBe(true);
    expect(compiled.value.test("src/b.ts")).toBe(true);
    expect(compiled.value.test("src/c.ts")).toBe(false);

    const range = compileGlob("[a-c].ts");
    expect(range.ok).toBe(true);
    if (!range.ok) {
      return;
    }
    expect(range.value.test("b.ts")).toBe(true);
    expect(range.value.test("d.ts")).toBe(false);

    const negated = compileGlob("[!a].ts");
    expect(negated.ok).toBe(true);
    if (!negated.ok) {
      return;
    }
    expect(negated.value.test("b.ts")).toBe(true);
    expect(negated.value.test("a.ts")).toBe(false);
  });

  it("treats a backslash as an escape of the next glob character", () => {
    const compiled = compileGlob("\\*.ts");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.value.test("*.ts")).toBe(true);
    expect(compiled.value.test("a.ts")).toBe(false);
  });

  it("rejects brace expansion, extglob, leading !, and incomplete syntax", () => {
    for (const pattern of ["{a,b}", "!(a)", "+(a)", "@(a)", "!(foo)", "!hidden", "[abc", "\\"]) {
      expect(compileGlob(pattern)).toMatchObject({
        ok: false,
        error: { code: "EINVAL_GLOB" },
      });
    }
  });

  it("is case-sensitive and lets wildcards match dot-prefixed names", () => {
    const compiled = compileGlob("*.ts");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.value.test("A.TS")).toBe(false);
    expect(compiled.value.test(".ts")).toBe(true);
    expect(compiled.value.test(".hidden.ts")).toBe(true);
  });

  it("treats a leading / as a Search Root-relative path pattern", () => {
    const compiled = compileGlob("/src/*.ts");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.value.test("src/a.ts")).toBe(true);
    expect(compiled.value.test("lib/src/a.ts")).toBe(false);
  });

  it("lets a trailing ** match descendants but not the prefix itself", () => {
    const compiled = compileGlob("src/**");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.value.test("src")).toBe(false);
    expect(compiled.value.test("src/a.ts")).toBe(true);
    expect(compiled.value.test("src/a/b.ts")).toBe(true);
  });

  it("allows a literal comma in a single glob pattern", () => {
    const compiled = compileGlob("foo,bar.txt");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) {
      return;
    }
    expect(compiled.value.test("foo,bar.txt")).toBe(true);
    expect(compiled.value.test("foo.txt")).toBe(false);
  });
});

describe("traverse", () => {
  let searchRoot: string;

  beforeEach(async () => {
    searchRoot = await mkdtemp(join(tmpdir(), "susan-traverse-"));
  });

  afterEach(async () => {
    await rm(searchRoot, { force: true, recursive: true });
  });

  it("returns an empty candidate set for an empty Search Root", async () => {
    await expect(traverse({ searchRoot })).resolves.toEqual({
      ok: true,
      value: { entries: [], diagnostics: [] },
    });
  });

  it("returns hidden descendants in UTF-16 ordinal order and omits Search Root", async () => {
    await mkdir(join(searchRoot, "src"));
    await writeFile(join(searchRoot, "README.md"), "hi\n");
    await writeFile(join(searchRoot, ".hidden"), "secret\n");
    await writeFile(join(searchRoot, "src", "index.ts"), "export {}\n");
    await writeFile(join(searchRoot, "src", "a.ts"), "export {}\n");

    await expect(traverse({ searchRoot })).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          { path: ".hidden", type: "file" },
          { path: "README.md", type: "file" },
          { path: "src", type: "directory" },
          { path: "src/a.ts", type: "file" },
          { path: "src/index.ts", type: "file" },
        ],
        diagnostics: [],
      },
    });
  });

  it("includes symlink entries and does not follow them", async () => {
    await mkdir(join(searchRoot, "src"));
    await writeFile(join(searchRoot, "src", "index.ts"), "export {}\n");
    await symlink(
      join(searchRoot, "src"),
      join(searchRoot, "link"),
      process.platform === "win32" ? "dir" : undefined,
    );

    await expect(traverse({ searchRoot })).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          { path: "link", type: "symlink" },
          { path: "src", type: "directory" },
          { path: "src/index.ts", type: "file" },
        ],
        diagnostics: [],
      },
    });
  });

  it("ignores .git directories by default", async () => {
    await mkdir(join(searchRoot, ".git"));
    await writeFile(join(searchRoot, ".git", "HEAD"), "ref: refs/heads/dev\n");
    await writeFile(join(searchRoot, "README.md"), "hi\n");

    await expect(traverse({ searchRoot })).resolves.toEqual({
      ok: true,
      value: {
        entries: [{ path: "README.md", type: "file" }],
        diagnostics: [],
      },
    });
  });

  it("applies Search Root .gitignore patterns without reading ancestor files", async () => {
    await writeFile(join(searchRoot, ".gitignore"), "*.log\n");
    await writeFile(join(searchRoot, "keep.ts"), "export {}\n");
    await writeFile(join(searchRoot, "drop.log"), "noise\n");
    await mkdir(join(searchRoot, "src"));
    await writeFile(join(searchRoot, "src", "nested.log"), "noise\n");
    await writeFile(join(searchRoot, "src", "main.ts"), "export {}\n");

    await expect(traverse({ searchRoot })).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          { path: ".gitignore", type: "file" },
          { path: "keep.ts", type: "file" },
          { path: "src", type: "directory" },
          { path: "src/main.ts", type: "file" },
        ],
        diagnostics: [],
      },
    });
  });

  it("applies nested .gitignore negation after parent rules", async () => {
    await writeFile(join(searchRoot, ".gitignore"), "*.log\n");
    await mkdir(join(searchRoot, "src"));
    await writeFile(join(searchRoot, "src", ".gitignore"), "!keep.log\n");
    await writeFile(join(searchRoot, "src", "keep.log"), "keep\n");
    await writeFile(join(searchRoot, "src", "drop.log"), "drop\n");

    await expect(traverse({ searchRoot })).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          { path: ".gitignore", type: "file" },
          { path: "src", type: "directory" },
          { path: "src/.gitignore", type: "file" },
          { path: "src/keep.log", type: "file" },
        ],
        diagnostics: [],
      },
    });
  });

  it("anchors gitignore patterns with a leading slash to the ignore file directory", async () => {
    await writeFile(join(searchRoot, ".gitignore"), "/root-only.txt\nbuild/\n");
    await writeFile(join(searchRoot, "root-only.txt"), "secret\n");
    await mkdir(join(searchRoot, "src"));
    await writeFile(join(searchRoot, "src", "root-only.txt"), "visible\n");
    await mkdir(join(searchRoot, "build"));
    await writeFile(join(searchRoot, "build", "out.js"), "built\n");

    await expect(traverse({ searchRoot })).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          { path: ".gitignore", type: "file" },
          { path: "src", type: "directory" },
          { path: "src/root-only.txt", type: "file" },
        ],
        diagnostics: [],
      },
    });
  });

  it("does not read .gitignore or ignore .git when includeIgnored is true", async () => {
    await writeFile(join(searchRoot, ".gitignore"), "*.log\n");
    await mkdir(join(searchRoot, ".git"));
    await writeFile(join(searchRoot, ".git", "HEAD"), "ref\n");
    await writeFile(join(searchRoot, "drop.log"), "noise\n");

    await expect(traverse({ searchRoot, includeIgnored: true })).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          { path: ".git", type: "directory" },
          { path: ".git/HEAD", type: "file" },
          { path: ".gitignore", type: "file" },
          { path: "drop.log", type: "file" },
        ],
        diagnostics: [],
      },
    });
  });

  it("filters returned entries by glob without pruning directory traversal", async () => {
    await mkdir(join(searchRoot, "src", "nested"), { recursive: true });
    await writeFile(join(searchRoot, "src", "a.ts"), "export {}\n");
    await writeFile(join(searchRoot, "src", "nested", "b.ts"), "export {}\n");
    await writeFile(join(searchRoot, "src", "a.js"), "ok\n");

    await expect(traverse({ searchRoot, glob: "**/*.ts" })).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          { path: "src/a.ts", type: "file" },
          { path: "src/nested/b.ts", type: "file" },
        ],
        diagnostics: [],
      },
    });
  });

  it("limits descent to maxDepth 1 as direct children only", async () => {
    await mkdir(join(searchRoot, "src", "nested"), { recursive: true });
    await writeFile(join(searchRoot, "README.md"), "hi\n");
    await writeFile(join(searchRoot, "src", "a.ts"), "export {}\n");
    await writeFile(join(searchRoot, "src", "nested", "b.ts"), "export {}\n");

    await expect(traverse({ searchRoot, maxDepth: 1 })).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          { path: "README.md", type: "file" },
          { path: "src", type: "directory" },
        ],
        diagnostics: [],
      },
    });
  });

  it("fails the call when Search Root is missing or not a directory", async () => {
    await expect(traverse({ searchRoot: join(searchRoot, "missing") })).resolves.toMatchObject({
      ok: false,
      error: { code: "ENOENT" },
    });

    const file = join(searchRoot, "file.txt");
    await writeFile(file, "not a dir\n");
    await expect(traverse({ searchRoot: file })).resolves.toMatchObject({
      ok: false,
      error: { code: "ENOTDIR" },
    });
  });

  it.skipIf(process.platform === "win32")(
    "returns a Traversal Diagnostic for a locally unreadable directory",
    async () => {
      await mkdir(join(searchRoot, "ok"));
      await writeFile(join(searchRoot, "ok", "a.ts"), "export {}\n");
      const locked = join(searchRoot, "locked");
      await mkdir(locked);
      await writeFile(join(locked, "secret.ts"), "secret\n");
      await chmod(locked, 0o000);
      try {
        await expect(traverse({ searchRoot })).resolves.toEqual({
          ok: true,
          value: {
            entries: [
              { path: "locked", type: "directory" },
              { path: "ok", type: "directory" },
              { path: "ok/a.ts", type: "file" },
            ],
            diagnostics: [
              { path: "locked", operation: "read-directory", code: "EACCES" },
            ],
          },
        });
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );

  it("records a Traversal Diagnostic for an invalid UTF-8 .gitignore and continues", async () => {
    await writeFile(join(searchRoot, ".gitignore"), Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFile(join(searchRoot, "keep.ts"), "export {}\n");

    await expect(traverse({ searchRoot })).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          { path: ".gitignore", type: "file" },
          { path: "keep.ts", type: "file" },
        ],
        diagnostics: [
          { path: ".gitignore", operation: "read-file", code: "EBINARY" },
        ],
      },
    });
  });

  it.skipIf(process.platform === "win32")("does not diagnose an ignored special file", async () => {
    await writeFile(join(searchRoot, ".gitignore"), "pipe\n");
    const created = spawnSync("mkfifo", [join(searchRoot, "pipe")]);
    expect(created.status).toBe(0);
    await writeFile(join(searchRoot, "keep.ts"), "export {}\n");

    await expect(traverse({ searchRoot })).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          { path: ".gitignore", type: "file" },
          { path: "keep.ts", type: "file" },
        ],
        diagnostics: [],
      },
    });
  });

  it.skipIf(process.platform === "win32")(
    "skips special files with an EUNSUPPORTED Traversal Diagnostic",
    async () => {
      const fifo = join(searchRoot, "pipe");
      const created = spawnSync("mkfifo", [fifo]);
      expect(created.status).toBe(0);
      await writeFile(join(searchRoot, "keep.ts"), "export {}\n");

      await expect(traverse({ searchRoot })).resolves.toEqual({
        ok: true,
        value: {
          entries: [{ path: "keep.ts", type: "file" }],
          diagnostics: [
            { path: "pipe", operation: "read-metadata", code: "EUNSUPPORTED" },
          ],
        },
      });
    },
  );

  it("fails the entire query when the entry budget is exceeded", async () => {
    await writeFile(join(searchRoot, "a.ts"), "export {}\n");
    await writeFile(join(searchRoot, "b.ts"), "export {}\n");
    await writeFile(join(searchRoot, "c.ts"), "export {}\n");

    await expect(traverse({ searchRoot, maxEntries: 2 })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "EQUERY_TOO_LARGE",
        details: { visitedEntries: 3 },
      },
    });
  });

  it("fails the entire query when the time budget is exceeded", async () => {
    await writeFile(join(searchRoot, "a.ts"), "export {}\n");
    let nowMs = 0;
    const now = () => {
      nowMs += 1;
      return nowMs === 1 ? 0 : 20_000;
    };

    await expect(traverse({ searchRoot, timeoutMs: 10, now })).resolves.toMatchObject({
      ok: false,
      error: { code: "ETIMEDOUT" },
    });
  });

  it("rejects invalid glob and maxDepth before walking", async () => {
    await writeFile(join(searchRoot, "a.ts"), "export {}\n");
    await expect(traverse({ searchRoot, glob: "{a,b}" })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_GLOB" },
    });
    await expect(traverse({ searchRoot, maxDepth: 0 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_DEPTH" },
    });
  });

  it("treats brace characters in .gitignore as literals", async () => {
    await writeFile(join(searchRoot, ".gitignore"), "{draft}.md\n");
    await writeFile(join(searchRoot, "{draft}.md"), "draft\n");
    await writeFile(join(searchRoot, "keep.md"), "keep\n");

    await expect(traverse({ searchRoot })).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          { path: ".gitignore", type: "file" },
          { path: "keep.md", type: "file" },
        ],
        diagnostics: [],
      },
    });
  });

  it("does not read ancestor .gitignore files above Search Root", async () => {
    await writeFile(join(searchRoot, ".gitignore"), "*.ts\n");
    const nested = join(searchRoot, "project");
    await mkdir(nested);
    await writeFile(join(nested, "keep.ts"), "export {}\n");

    await expect(traverse({ searchRoot: nested })).resolves.toEqual({
      ok: true,
      value: {
        entries: [{ path: "keep.ts", type: "file" }],
        diagnostics: [],
      },
    });
  });

  it("produces the same canonical traversal facts for a shared fixture tree", async () => {
    await mkdir(join(searchRoot, ".git"));
    await writeFile(join(searchRoot, ".git", "HEAD"), "ref\n");
    await writeFile(join(searchRoot, ".gitignore"), "build/\n*.log\n");
    await writeFile(join(searchRoot, ".hidden"), "secret\n");
    await writeFile(join(searchRoot, "README.md"), "hi\n");
    await mkdir(join(searchRoot, "src"));
    await writeFile(join(searchRoot, "src", "index.ts"), "export {}\n");
    await writeFile(join(searchRoot, "src", "skip.log"), "noise\n");
    await mkdir(join(searchRoot, "build"));
    await writeFile(join(searchRoot, "build", "out.js"), "built\n");
    await symlink(
      join(searchRoot, "src"),
      join(searchRoot, "link"),
      process.platform === "win32" ? "dir" : undefined,
    );

    await expect(traverse({ searchRoot })).resolves.toEqual({
      ok: true,
      value: {
        entries: [
          { path: ".gitignore", type: "file" },
          { path: ".hidden", type: "file" },
          { path: "README.md", type: "file" },
          { path: "link", type: "symlink" },
          { path: "src", type: "directory" },
          { path: "src/index.ts", type: "file" },
        ],
        diagnostics: [],
      },
    });
  });

  it.skipIf(process.platform !== "linux")(
    "records EUNSUPPORTED_NAME for a filename that is not valid UTF-8",
    async () => {
      await writeFile(
        Buffer.concat([Buffer.from(`${searchRoot}/`), Buffer.from([0xff])]),
        "x",
      );

      const result = await traverse({ searchRoot });
      expect(result).toMatchObject({
        ok: true,
        value: {
          entries: [],
          diagnostics: [{ operation: "read-metadata", code: "EUNSUPPORTED_NAME" }],
        },
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps at most 100 Traversal Diagnostics in ordinal order",
    async () => {
      for (let index = 0; index < 101; index += 1) {
        const created = spawnSync("mkfifo", [
          join(searchRoot, `pipe-${String(index).padStart(3, "0")}`),
        ]);
        expect(created.status).toBe(0);
      }

      const result = await traverse({ searchRoot });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.diagnostics).toHaveLength(100);
      expect(result.value.diagnostics[0]).toEqual({
        path: "pipe-000",
        operation: "read-metadata",
        code: "EUNSUPPORTED",
      });
      expect(result.value.diagnostics[99]).toEqual({
        path: "pipe-099",
        operation: "read-metadata",
        code: "EUNSUPPORTED",
      });
      expect(result.value.entries).toEqual([]);
    },
  );
});
