import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GREP_DEFAULT_LIMIT,
  GREP_MAX_CONTEXT,
  GREP_MAX_FILE_BYTES,
  GREP_MAX_LIMIT,
  GREP_MAX_LINE_TEXT_BYTES,
  createGrepTool,
  type GrepTool,
} from "../src/index.js";

const POSIX = process.platform !== "win32";

type Match = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly before: readonly { readonly line: number; readonly text: string }[];
  readonly after: readonly { readonly line: number; readonly text: string }[];
};

type Diagnostic = {
  readonly path: string;
  readonly operation: string;
  readonly code: string;
};

function matchesOf(result: unknown): readonly Match[] {
  const record = result as { readonly result?: { readonly matches?: readonly Match[] } };
  return record.result?.matches ?? [];
}

function diagnosticsOf(result: unknown): readonly Diagnostic[] {
  const record = result as {
    readonly result?: { readonly diagnostics?: readonly Diagnostic[] };
  };
  return record.result?.diagnostics ?? [];
}

describe("Grep Tool", () => {
  let sessionCwd: string;
  let tool: GrepTool;

  beforeEach(async () => {
    sessionCwd = await mkdtemp(join(tmpdir(), "susan-grep-"));
    tool = createGrepTool({ sessionCwd });
  });

  afterEach(async () => {
    await rm(sessionCwd, { force: true, recursive: true });
  });

  it("exposes the grep tool definition with a required pattern and bounded options", () => {
    expect(tool).toMatchObject({
      name: "grep",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["pattern"],
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          literal: { type: "boolean" },
          ignoreCase: { type: "boolean" },
          context: { type: "integer", minimum: 0, maximum: GREP_MAX_CONTEXT },
          maxDepth: { type: "integer", minimum: 1 },
          includeIgnored: { type: "boolean" },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: GREP_MAX_LIMIT },
        },
      },
    });
    expect(GREP_DEFAULT_LIMIT).toBe(100);
    expect(GREP_MAX_LIMIT).toBe(1_000);
    expect(GREP_MAX_CONTEXT).toBe(10);
    expect(GREP_MAX_LINE_TEXT_BYTES).toBe(1_000);
    expect(GREP_MAX_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("searches a single file by ECMAScript regex and reports its basename", async () => {
    await writeFile(
      join(sessionCwd, "app.ts"),
      "const a = 1;\nexport const total = 2;\nconst b = 3;\n",
    );

    await expect(tool.execute({ pattern: "^export", path: "app.ts" })).resolves.toEqual({
      ok: true,
      result: {
        resolvedPath: join(sessionCwd, "app.ts"),
        realTargetPath: await realpath(join(sessionCwd, "app.ts")),
        cwdRelation: "inside",
        matches: [
          {
            path: "app.ts",
            line: 2,
            text: "export const total = 2;",
            before: [],
            after: [],
          },
        ],
        diagnostics: [],
      },
    });
  });

  it("counts a line with several hits as one logical match", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "aa aa aa\nbb\n");

    expect(matchesOf(await tool.execute({ pattern: "a", path: "a.txt" }))).toEqual([
      { path: "a.txt", line: 1, text: "aa aa aa", before: [], after: [] },
    ]);
  });

  it("treats the pattern literally with literal and folds case with ignoreCase", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "a.c\nabc\nABC\n");

    expect(
      matchesOf(await tool.execute({ pattern: "a.c", path: "a.txt" })).map((m) => m.line),
    ).toEqual([1, 2]);
    expect(
      matchesOf(
        await tool.execute({ pattern: "a.c", path: "a.txt", literal: true }),
      ).map((m) => m.line),
    ).toEqual([1]);
    expect(
      matchesOf(
        await tool.execute({ pattern: "abc", path: "a.txt", ignoreCase: true }),
      ).map((m) => m.line),
    ).toEqual([2, 3]);
    expect(
      matchesOf(
        await tool.execute({
          pattern: "A.C",
          path: "a.txt",
          literal: true,
          ignoreCase: true,
        }),
      ).map((m) => m.line),
    ).toEqual([1]);
  });

  it("matches Unicode regex escapes and never matches across logical lines", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "café\nfirst\nsecond\n");

    expect(
      matchesOf(await tool.execute({ pattern: "\\p{L}+é", path: "a.txt" })).map(
        (m) => m.text,
      ),
    ).toEqual(["café"]);
    expect(matchesOf(await tool.execute({ pattern: "first\\nsecond", path: "a.txt" })))
      .toEqual([]);
  });

  it("rejects unknown fields and wrong types before any other validation", async () => {
    await expect(tool.execute({ pattern: "a", depth: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "depth" } },
    });
    await expect(tool.execute({})).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "pattern" } },
    });
    await expect(tool.execute({ pattern: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "pattern" } },
    });
    await expect(tool.execute({ pattern: "a", path: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "path" } },
    });
    await expect(tool.execute({ pattern: "a", glob: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "glob" } },
    });
    await expect(tool.execute({ pattern: "a", literal: "yes" })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "literal" } },
    });
    await expect(tool.execute({ pattern: "a", context: 1.5 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "context" } },
    });
    await expect(tool.execute({ pattern: "(", limit: 0 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_PATTERN", details: { field: "pattern" } },
    });
  });

  it("orders pattern, glob, and option failures ahead of path failures", async () => {
    await expect(
      tool.execute({ pattern: "(", glob: "{a,b}", path: "missing" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_PATTERN", details: { field: "pattern" } },
    });
    await expect(tool.execute({ pattern: "", path: "missing" })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_PATTERN", details: { field: "pattern" } },
    });
    await expect(
      tool.execute({ pattern: "a", glob: "{a,b}", limit: 0 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_GLOB", details: { field: "glob" } },
    });
    await expect(
      tool.execute({ pattern: "a", limit: GREP_MAX_LIMIT + 1, offset: -1 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_LIMIT", details: { field: "limit" } },
    });
    await expect(
      tool.execute({ pattern: "a", offset: -1, maxDepth: 0 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_OFFSET", details: { field: "offset" } },
    });
    await expect(
      tool.execute({ pattern: "a", maxDepth: 1_001, context: 11 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_DEPTH", details: { field: "maxDepth" } },
    });
    await expect(
      tool.execute({ pattern: "a", context: GREP_MAX_CONTEXT + 1, path: "missing" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_CONTEXT", details: { field: "context" } },
    });
  });

  it("rejects directory-only options when the target is a single file", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "hit\n");

    await expect(
      tool.execute({ pattern: "hit", path: "a.txt", glob: "*.txt" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "glob" } },
    });
    await expect(
      tool.execute({ pattern: "hit", path: "a.txt", maxDepth: 2 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "maxDepth" } },
    });
    await expect(
      tool.execute({ pattern: "hit", path: "a.txt", includeIgnored: true }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "includeIgnored" } },
    });
    await expect(
      tool.execute({ pattern: "hit", path: "a.txt", context: 1, offset: 0, limit: 5 }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      tool.execute({
        pattern: "hit",
        path: "a.txt",
        glob: undefined,
        maxDepth: undefined,
        includeIgnored: undefined,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("recurses a Search Root and sorts matches by path then line", async () => {
    await mkdir(join(sessionCwd, "src", "deep"), { recursive: true });
    await writeFile(join(sessionCwd, "top.ts"), "needle\n");
    await writeFile(join(sessionCwd, ".dotfile"), "needle\n");
    await writeFile(join(sessionCwd, "src", "b.ts"), "no\nneedle\nneedle\n");
    await writeFile(join(sessionCwd, "src", "a.ts"), "needle\n");
    await writeFile(join(sessionCwd, "src", "deep", "c.ts"), "needle\n");
    await writeFile(join(sessionCwd, "src", "Case.ts"), "Needle\n");

    const result = await tool.execute({ pattern: "needle" });

    expect(result).toMatchObject({
      ok: true,
      result: {
        resolvedPath: sessionCwd,
        realTargetPath: await realpath(sessionCwd),
        cwdRelation: "inside",
        diagnostics: [],
      },
    });
    expect(matchesOf(result).map((m) => [m.path, m.line])).toEqual([
      [".dotfile", 1],
      ["src/a.ts", 1],
      ["src/b.ts", 2],
      ["src/b.ts", 3],
      ["src/deep/c.ts", 1],
      ["top.ts", 1],
    ]);
  });

  it("filters candidate files with glob while still descending every directory", async () => {
    await mkdir(join(sessionCwd, "pkg", "src"), { recursive: true });
    await writeFile(join(sessionCwd, "pkg", "notes.md"), "needle\n");
    await writeFile(join(sessionCwd, "pkg", "src", "a.ts"), "needle\n");
    await writeFile(join(sessionCwd, "root.ts"), "needle\n");

    expect(
      matchesOf(await tool.execute({ pattern: "needle", glob: "*.ts" })).map(
        (m) => m.path,
      ),
    ).toEqual(["pkg/src/a.ts", "root.ts"]);
    expect(
      matchesOf(await tool.execute({ pattern: "needle", glob: "pkg/**/*.ts" })).map(
        (m) => m.path,
      ),
    ).toEqual(["pkg/src/a.ts"]);
    expect(
      matchesOf(await tool.execute({ pattern: "needle", glob: "*.rs" })),
    ).toEqual([]);
  });

  it("limits recursion depth with maxDepth", async () => {
    await mkdir(join(sessionCwd, "a", "b"), { recursive: true });
    await writeFile(join(sessionCwd, "top.ts"), "needle\n");
    await writeFile(join(sessionCwd, "a", "mid.ts"), "needle\n");
    await writeFile(join(sessionCwd, "a", "b", "deep.ts"), "needle\n");

    expect(
      matchesOf(await tool.execute({ pattern: "needle", maxDepth: 1 })).map(
        (m) => m.path,
      ),
    ).toEqual(["top.ts"]);
    expect(
      matchesOf(await tool.execute({ pattern: "needle", maxDepth: 2 })).map(
        (m) => m.path,
      ),
    ).toEqual(["a/mid.ts", "top.ts"]);
  });

  it("applies nested .gitignore anchoring and negation unless includeIgnored", async () => {
    await writeFile(join(sessionCwd, ".gitignore"), "*.log\n/root-only.ts\nbuild/\n");
    await mkdir(join(sessionCwd, "build"));
    await mkdir(join(sessionCwd, "pkg"));
    await mkdir(join(sessionCwd, ".git"));
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
      matchesOf(await tool.execute({ pattern: "needle" })).map((m) => m.path),
    ).toEqual(["keep.ts", "pkg/keep.ts"]);

    expect(
      matchesOf(await tool.execute({ pattern: "needle", includeIgnored: true })).map(
        (m) => m.path,
      ),
    ).toEqual([
      ".git/HEAD",
      "build/out.ts",
      "drop.log",
      "keep.ts",
      "pkg/keep.ts",
      "pkg/other.ts",
      "pkg/root-only.ts",
      "root-only.ts",
    ]);
  });

  it("skips symlinked files and directories found by traversal", async () => {
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

    expect(
      matchesOf(await tool.execute({ pattern: "needle" })).map((m) => m.path),
    ).toEqual(["real/a.ts"]);
  });

  it("follows an explicit symlink entry to its real target", async () => {
    await writeFile(join(sessionCwd, "real.ts"), "needle\n");
    await symlink(
      join(sessionCwd, "real.ts"),
      join(sessionCwd, "alias.ts"),
      process.platform === "win32" ? "file" : undefined,
    );

    await expect(
      tool.execute({ pattern: "needle", path: "alias.ts" }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        resolvedPath: join(sessionCwd, "alias.ts"),
        realTargetPath: await realpath(join(sessionCwd, "real.ts")),
        matches: [{ path: "alias.ts", line: 1 }],
      },
    });
  });

  it("keeps BOM out of matching and treats LF and CRLF as logical lines", async () => {
    await writeFile(
      join(sessionCwd, "bom.txt"),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("first\r\nsecond\nthird\r\n", "utf8"),
      ]),
    );

    expect(matchesOf(await tool.execute({ pattern: "^first$", path: "bom.txt" })))
      .toEqual([
        { path: "bom.txt", line: 1, text: "first", before: [], after: [] },
      ]);
    expect(
      matchesOf(
        await tool.execute({ pattern: ".", path: "bom.txt", context: 0 }),
      ).map((m) => [m.line, m.text]),
    ).toEqual([
      [1, "first"],
      [2, "second"],
      [3, "third"],
    ]);
  });

  it("returns typed failures for binary, oversized, and special explicit targets", async () => {
    await writeFile(join(sessionCwd, "bin"), Buffer.from([0x68, 0x00, 0x69]));
    await writeFile(join(sessionCwd, "bad-utf8"), Buffer.from([0xff, 0xfe, 0xfd]));

    await expect(
      tool.execute({ pattern: "h", path: "bin" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EBINARY", details: { resolvedPath: join(sessionCwd, "bin") } },
    });
    await expect(
      tool.execute({ pattern: "h", path: "bad-utf8" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EBINARY" },
    });
  });

  it.skipIf(!POSIX)("fails with EUNSUPPORTED for an explicit special file", async () => {
    const fifo = join(sessionCwd, "pipe");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

    await expect(tool.execute({ pattern: "a", path: "pipe" })).resolves.toMatchObject({
      ok: false,
      error: { code: "EUNSUPPORTED", details: { resolvedPath: fifo } },
    });
  });

  it("turns undecodable and special files found by traversal into diagnostics", async () => {
    await writeFile(join(sessionCwd, "keep.ts"), "needle\n");
    await writeFile(join(sessionCwd, "bin.dat"), Buffer.from([0x00, 0x01]));
    if (POSIX) {
      expect(spawnSync("mkfifo", [join(sessionCwd, "pipe")]).status).toBe(0);
    }

    const result = await tool.execute({ pattern: "needle" });

    expect(matchesOf(result).map((m) => m.path)).toEqual(["keep.ts"]);
    expect(result).toMatchObject({
      ok: true,
      result: {
        diagnostics: [
          { path: "bin.dat", operation: "read-file", code: "EBINARY" },
          ...(POSIX
            ? [{ path: "pipe", operation: "read-metadata", code: "EUNSUPPORTED" }]
            : []),
        ],
      },
    });
  });

  it("caps diagnostics at 100 in path order without dropping matches", async () => {
    await writeFile(join(sessionCwd, "keep.ts"), "needle\n");
    for (let index = 0; index < 105; index += 1) {
      await writeFile(
        join(sessionCwd, `bin-${String(index).padStart(3, "0")}.dat`),
        Buffer.from([0x00, 0x01]),
      );
    }

    const result = await tool.execute({ pattern: "needle" });

    expect(matchesOf(result).map((m) => m.path)).toEqual(["keep.ts"]);
    const diagnostics = diagnosticsOf(result);
    expect(diagnostics).toHaveLength(100);
    expect(diagnostics[0]).toEqual({
      path: "bin-000.dat",
      operation: "read-file",
      code: "EBINARY",
    });
    expect(diagnostics[99]?.path).toBe("bin-099.dat");
  });

  it("returns unified context clipped at file boundaries and kept per match", async () => {
    await writeFile(
      join(sessionCwd, "a.txt"),
      "hit\nfiller\nhit\nlast\n",
    );

    expect(matchesOf(await tool.execute({ pattern: "hit", path: "a.txt", context: 2 })))
      .toEqual([
        {
          path: "a.txt",
          line: 1,
          text: "hit",
          before: [],
          after: [
            { line: 2, text: "filler" },
            { line: 3, text: "hit" },
          ],
        },
        {
          path: "a.txt",
          line: 3,
          text: "hit",
          before: [
            { line: 1, text: "hit" },
            { line: 2, text: "filler" },
          ],
          after: [{ line: 4, text: "last" }],
        },
      ]);
  });

  it("returns successful empty results for no match, empty tree, and out-of-range offset", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "nothing here\n");
    await mkdir(join(sessionCwd, "empty"));

    await expect(tool.execute({ pattern: "zzz" })).resolves.toEqual({
      ok: true,
      result: {
        resolvedPath: sessionCwd,
        realTargetPath: await realpath(sessionCwd),
        cwdRelation: "inside",
        matches: [],
        diagnostics: [],
      },
    });
    await expect(tool.execute({ pattern: "nothing", path: "empty" })).resolves
      .toMatchObject({ ok: true, result: { matches: [] } });
    await expect(tool.execute({ pattern: "nothing", offset: 5 })).resolves
      .toMatchObject({ ok: true, result: { matches: [] } });
  });

  it("pages sorted matches with limit, offset, and accurate continuation", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "hit 1\nhit 2\nhit 3\n");
    await writeFile(join(sessionCwd, "b.txt"), "hit 4\n");

    const first = await tool.execute({ pattern: "hit", limit: 2, context: 1 });
    expect(first).toMatchObject({
      ok: true,
      meta: {
        truncation: {
          reasons: ["items"],
          strategy: "head",
          fields: ["matches"],
          retained: { items: 2 },
          total: { items: 4 },
          nextArguments: { pattern: "hit", path: ".", offset: 2, limit: 2, context: 1 },
        },
      },
    });
    expect(matchesOf(first).map((m) => [m.path, m.line])).toEqual([
      ["a.txt", 1],
      ["a.txt", 2],
    ]);

    const second = await tool.execute(
      first.ok ? first.meta?.truncation?.nextArguments : undefined,
    );
    expect(matchesOf(second).map((m) => [m.path, m.line])).toEqual([
      ["a.txt", 3],
      ["b.txt", 1],
    ]);
    expect(second.ok && second.meta?.truncation).toBeUndefined();
  });

  it("counts only logical matches in offset, never context lines", async () => {
    await writeFile(join(sessionCwd, "a.txt"), "hit\nx\nhit\ny\nhit\n");

    expect(
      matchesOf(
        await tool.execute({ pattern: "hit", path: "a.txt", context: 1, offset: 1 }),
      ),
    ).toEqual([
      {
        path: "a.txt",
        line: 3,
        text: "hit",
        before: [{ line: 2, text: "x" }],
        after: [{ line: 4, text: "y" }],
      },
      {
        path: "a.txt",
        line: 5,
        text: "hit",
        before: [{ line: 4, text: "y" }],
        after: [],
      },
    ]);
  });

  it("clips every line text to 1,000 UTF-8 bytes and reports line-length", async () => {
    const wide = "中".repeat(400);
    await writeFile(join(sessionCwd, "wide.txt"), `${wide}\nhit ${wide}\n`);

    const result = await tool.execute({ pattern: "hit", path: "wide.txt", context: 1 });
    const [match] = matchesOf(result);
    expect(match?.line).toBe(2);
    expect(match?.text).toBe(`hit ${"中".repeat(332)}`);
    expect(Buffer.byteLength(match?.text ?? "", "utf8")).toBe(1_000);
    expect(match?.before[0]?.text).toBe("中".repeat(333));
    expect(Buffer.byteLength(match?.before[0]?.text ?? "", "utf8")).toBe(999);
    expect(result).toMatchObject({
      ok: true,
      meta: {
        truncation: {
          reasons: ["line-length"],
          strategy: "head",
          fields: ["matches"],
        },
      },
    });
    expect(result.ok && result.meta?.truncation?.nextArguments).toBeUndefined();
  });

  it("keeps short lines untouched and preserves valid UTF-8 when clipping", async () => {
    await writeFile(join(sessionCwd, "a.txt"), `${"a".repeat(1_000)}\n`);

    const exact = await tool.execute({ pattern: "a", path: "a.txt" });
    expect(matchesOf(exact)[0]?.text).toHaveLength(1_000);
    expect(exact.ok && exact.meta?.truncation).toBeUndefined();

    await writeFile(join(sessionCwd, "b.txt"), `${"a".repeat(1_001)}\n`);
    const clipped = await tool.execute({ pattern: "a", path: "b.txt" });
    expect(matchesOf(clipped)[0]?.text).toHaveLength(1_000);
    expect(clipped.ok && clipped.meta?.truncation?.reasons).toEqual(["line-length"]);
  });

  it("applies the 50 KiB budget after sorting and continues from the first omitted match", async () => {
    const filler = "x".repeat(240);
    const lines = Array.from({ length: 400 }, (_, index) => `hit-${index} ${filler}`);
    await writeFile(join(sessionCwd, "big.txt"), `${lines.join("\n")}\n`);

    const first = await tool.execute({
      pattern: "hit",
      path: "big.txt",
      limit: GREP_MAX_LIMIT,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.meta?.truncation?.reasons).toContain("bytes");
    expect(first.meta?.truncation?.fields).toContain("matches");
    const retained = matchesOf(first);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(lines.length);
    expect(retained[0]?.line).toBe(1);
    expect(first.meta?.truncation?.nextArguments).toEqual({
      pattern: "hit",
      path: "big.txt",
      offset: retained.length,
      limit: GREP_MAX_LIMIT,
    });

    const second = await tool.execute(first.meta?.truncation?.nextArguments);
    expect(matchesOf(second)[0]?.line).toBe(retained.length + 1);
  });

  it("keeps every non-default option in continuation arguments", async () => {
    await writeFile(join(sessionCwd, ".gitignore"), "a.txt\n");
    await writeFile(join(sessionCwd, "a.txt"), "hit\nhit\n");

    await expect(
      tool.execute({
        pattern: "hit",
        glob: "*.txt",
        literal: true,
        ignoreCase: true,
        context: 1,
        maxDepth: 1,
        includeIgnored: true,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      ok: true,
      meta: {
        truncation: {
          nextArguments: {
            pattern: "hit",
            path: ".",
            offset: 1,
            limit: 1,
            glob: "*.txt",
            literal: true,
            ignoreCase: true,
            context: 1,
            maxDepth: 1,
            includeIgnored: true,
          },
        },
      },
    });
  });

  it("fails the whole call for missing and unreadable roots", async () => {
    await expect(tool.execute({ pattern: "a", path: "missing" })).resolves
      .toMatchObject({
        ok: false,
        error: {
          code: "ENOENT",
          details: { resolvedPath: join(sessionCwd, "missing"), cwdRelation: "inside" },
        },
      });
  });

  it.skipIf(!POSIX)("fails closed when an explicit target cannot be read", async () => {
    const locked = join(sessionCwd, "locked.txt");
    await writeFile(locked, "needle\n");
    await chmod(locked, 0o000);
    try {
      await expect(tool.execute({ pattern: "needle", path: "locked.txt" })).resolves
        .toMatchObject({ ok: false, error: { code: "EACCES" } });
    } finally {
      await chmod(locked, 0o600);
    }
  });

  it.skipIf(!POSIX)("records a diagnostic when a discovered file cannot be read", async () => {
    await writeFile(join(sessionCwd, "keep.ts"), "needle\n");
    const locked = join(sessionCwd, "locked.ts");
    await writeFile(locked, "needle\n");
    await chmod(locked, 0o000);
    try {
      const result = await tool.execute({ pattern: "needle" });
      expect(matchesOf(result).map((m) => m.path)).toEqual(["keep.ts"]);
      expect(result).toMatchObject({
        ok: true,
        result: {
          diagnostics: [
            { path: "locked.ts", operation: "read-file", code: "EACCES" },
          ],
        },
      });
    } finally {
      await chmod(locked, 0o600);
    }
  });

  it("searches an absolute path outside Session cwd and reports cwdRelation outside", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-grep-outside-"));
    try {
      await writeFile(join(outside, "a.ts"), "needle\n");
      await expect(tool.execute({ pattern: "needle", path: outside })).resolves
        .toMatchObject({
          ok: true,
          result: {
            resolvedPath: outside,
            realTargetPath: await realpath(outside),
            cwdRelation: "outside",
            matches: [{ path: "a.ts", line: 1 }],
          },
        });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("resolves a relative path against Session cwd, not process cwd", async () => {
    await writeFile(join(sessionCwd, "here.ts"), "needle\n");
    const other = await mkdtemp(join(tmpdir(), "susan-grep-other-"));
    const previous = process.cwd();
    try {
      process.chdir(other);
      await writeFile(join(other, "here.ts"), "needle\n");
      await expect(tool.execute({ pattern: "needle", path: "here.ts" })).resolves
        .toMatchObject({
          ok: true,
          result: { resolvedPath: join(sessionCwd, "here.ts") },
        });
    } finally {
      process.chdir(previous);
      await rm(other, { force: true, recursive: true });
    }
  });

  it("fails the entire query when the time budget is exceeded", async () => {
    await writeFile(join(sessionCwd, "a.ts"), "needle\n");
    let calls = 0;
    const isolated = createGrepTool({
      sessionCwd,
      timeoutMs: 10,
      now: () => {
        calls += 1;
        return calls === 1 ? 0 : 20_000;
      },
    });

    await expect(isolated.execute({ pattern: "needle" })).resolves.toMatchObject({
      ok: false,
      error: { code: "ETIMEDOUT" },
    });
  });

  it("maps an already-aborted timeout signal to ETIMEDOUT and cancellation to ETOOL", async () => {
    const timeout = AbortSignal.timeout(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(tool.execute({ pattern: "a" }, timeout)).resolves.toMatchObject({
      ok: false,
      error: { code: "ETIMEDOUT" },
    });

    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute({ pattern: "a" }, controller.signal)).resolves
      .toMatchObject({ ok: false, error: { code: "ETOOL" } });
  });
});
