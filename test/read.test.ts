import { chmod, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  READ_MAX_FILE_BYTES,
  READ_MAX_LINES,
  createReadTool,
  type ReadTool,
} from "../src/index.js";
import * as susan from "../src/index.js";

const POSIX = process.platform !== "win32";

describe("Read Tool", () => {
  let sessionCwd: string;
  let tool: ReadTool;

  beforeEach(async () => {
    sessionCwd = await mkdtemp(join(tmpdir(), "susan-read-"));
    tool = createReadTool({ sessionCwd });
  });

  afterEach(async () => {
    await rm(sessionCwd, { force: true, recursive: true });
  });

  it("exposes the read tool definition without a read_file alias", () => {
    expect(tool).toMatchObject({
      name: "read",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 2000 },
        },
        required: ["path"],
      },
    });
    expect("readFileTool" in susan).toBe(false);
    expect(tool.name).not.toBe("read_file");
  });

  it("reads a UTF-8 regular file and returns path facts with file facts", async () => {
    const path = join(sessionCwd, "notes.txt");
    await writeFile(path, "first\nsecond\nthird\n", "utf8");

    const result = await tool.execute({ path });

    expect(result).toEqual({
      ok: true,
      result: {
        resolvedPath: path,
        realTargetPath: await realpath(path),
        cwdRelation: "inside",
        content: "first\nsecond\nthird\n",
        range: { startLine: 1, endLine: 3 },
        totalLines: 3,
        sizeBytes: Buffer.byteLength("first\nsecond\nthird\n", "utf8"),
        bom: false,
        lineEnding: "lf",
      },
    });
  });

  it("succeeds on an empty file", async () => {
    const path = join(sessionCwd, "empty.txt");
    await writeFile(path, Buffer.alloc(0));

    await expect(tool.execute({ path })).resolves.toEqual({
      ok: true,
      result: {
        resolvedPath: path,
        realTargetPath: await realpath(path),
        cwdRelation: "inside",
        content: "",
        range: null,
        totalLines: 0,
        sizeBytes: 0,
        bom: false,
        lineEnding: "none",
      },
    });
  });

  it("resolves a relative path against Session cwd, not process cwd", async () => {
    await writeFile(join(sessionCwd, "relative.txt"), "session\n", "utf8");
    const other = await mkdtemp(join(tmpdir(), "susan-read-other-"));
    const previous = process.cwd();
    try {
      process.chdir(other);
      await writeFile(join(other, "relative.txt"), "process\n", "utf8");
      const result = await tool.execute({ path: "relative.txt" });
      expect(result).toMatchObject({
        ok: true,
        result: {
          resolvedPath: join(sessionCwd, "relative.txt"),
          content: "session\n",
          cwdRelation: "inside",
        },
      });
    } finally {
      process.chdir(previous);
      await rm(other, { force: true, recursive: true });
    }
  });

  it("strips a UTF-8 BOM from content and reports bom true", async () => {
    const path = join(sessionCwd, "bom.txt");
    await writeFile(path, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("hello\n", "utf8"),
    ]));

    const result = await tool.execute({ path });
    expect(result).toMatchObject({
      ok: true,
      result: {
        content: "hello\n",
        bom: true,
        sizeBytes: 9,
        totalLines: 1,
        lineEnding: "lf",
      },
    });
  });

  it("preserves LF, CRLF, mixed endings, and a missing final newline", async () => {
    const lf = join(sessionCwd, "lf.txt");
    const crlf = join(sessionCwd, "crlf.txt");
    const mixed = join(sessionCwd, "mixed.txt");
    const none = join(sessionCwd, "none.txt");
    await writeFile(lf, "a\nb\n");
    await writeFile(crlf, "a\r\nb\r\n");
    await writeFile(mixed, "a\r\nb\n");
    await writeFile(none, "a\nb");

    await expect(tool.execute({ path: lf })).resolves.toMatchObject({
      ok: true,
      result: { content: "a\nb\n", lineEnding: "lf", totalLines: 2 },
    });
    await expect(tool.execute({ path: crlf })).resolves.toMatchObject({
      ok: true,
      result: { content: "a\r\nb\r\n", lineEnding: "crlf", totalLines: 2 },
    });
    await expect(tool.execute({ path: mixed })).resolves.toMatchObject({
      ok: true,
      result: { content: "a\r\nb\n", lineEnding: "mixed", totalLines: 2 },
    });
    await expect(tool.execute({ path: none })).resolves.toMatchObject({
      ok: true,
      result: { content: "a\nb", lineEnding: "lf", totalLines: 2, range: { startLine: 1, endLine: 2 } },
    });
  });

  it("pages from a 1-based offset and offers complete nextArguments", async () => {
    const path = join(sessionCwd, "lines.txt");
    const lines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");

    const result = await tool.execute({ path, offset: 4, limit: 3 });
    const page = "line-4\nline-5\nline-6\n";
    expect(result).toMatchObject({
      ok: true,
      result: {
        resolvedPath: path,
        realTargetPath: await realpath(path),
        cwdRelation: "inside",
        content: page,
        range: { startLine: 4, endLine: 6 },
        totalLines: 12,
        sizeBytes: Buffer.byteLength(`${lines.join("\n")}\n`, "utf8"),
        bom: false,
        lineEnding: "lf",
      },
      meta: {
        truncation: {
          reasons: ["lines"],
          strategy: "head",
          fields: ["content"],
          retained: {
            bytes: Buffer.byteLength(JSON.stringify(page), "utf8"),
            lines: 3,
          },
          nextArguments: { path, offset: 7, limit: 3 },
        },
      },
    });
  });

  it("uses 2000 lines as the default and maximum page", async () => {
    const path = join(sessionCwd, "default-limit.txt");
    const lines = Array.from({ length: 2001 }, (_, index) => `${index + 1}`);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");

    const result = await tool.execute({ path });
    expect(result).toMatchObject({
      ok: true,
      result: {
        range: { startLine: 1, endLine: 2000 },
        totalLines: 2001,
        content: `${lines.slice(0, 2000).join("\n")}\n`,
      },
      meta: {
        truncation: {
          reasons: ["lines"],
          nextArguments: { path, offset: 2001, limit: READ_MAX_LINES },
        },
      },
    });
  });

  it("stops at the 50 KiB JSON-byte budget and continues from the next complete line", async () => {
    const path = join(sessionCwd, "bytes.txt");
    const line = `${"a".repeat(100)}\n`;
    await writeFile(path, line.repeat(600));

    const result = await tool.execute({ path });
    expect(result).toMatchObject({
      ok: true,
      result: {
        content: line.repeat(501),
        range: { startLine: 1, endLine: 501 },
        totalLines: 600,
      },
      meta: {
        truncation: {
          reasons: ["bytes"],
          strategy: "head",
          fields: ["content"],
          nextArguments: { path, offset: 502, limit: 2000 },
        },
      },
    });
  });

  it("clips an oversized line with line-length and does not invent continuation", async () => {
    const path = join(sessionCwd, "long-line.txt");
    await writeFile(path, `${"a".repeat(60_000)}\n`);

    const result = await tool.execute({ path });
    expect(result).toMatchObject({
      ok: true,
      result: {
        content: "a".repeat(51_198),
        range: { startLine: 1, endLine: 1 },
        totalLines: 1,
      },
      meta: {
        truncation: {
          reasons: ["bytes", "line-length"],
          strategy: "head",
          fields: ["content"],
        },
      },
    });
    if (result.ok) {
      expect(result.meta?.truncation?.nextArguments).toBeUndefined();
    }
  });

  it("rejects unknown fields and illegal argument types with EINVAL", async () => {
    await expect(tool.execute("nope")).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "path" } },
    });
    await expect(tool.execute({ path: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "path" } },
    });
    await expect(tool.execute({ path: "a.txt", extra: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "extra" } },
    });
    await expect(tool.execute({ path: "a.txt", offset: 1.5 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "offset" } },
    });
    await expect(tool.execute({ path: "a.txt", limit: Number.NaN })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "limit" } },
    });
  });

  it("rejects out-of-range integers with EINVAL_OFFSET and EINVAL_LIMIT", async () => {
    const path = join(sessionCwd, "range.txt");
    await writeFile(path, "one\n", "utf8");

    await expect(tool.execute({ path, offset: 0 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_OFFSET", details: { field: "offset" } },
    });
    await expect(tool.execute({ path, limit: 0 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_LIMIT", details: { field: "limit" } },
    });
    await expect(tool.execute({ path, limit: 2001 })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_LIMIT", details: { field: "limit" } },
    });
    await expect(tool.execute({ path, offset: 2 })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "EINVAL_OFFSET",
        details: {
          resolvedPath: path,
          realTargetPath: await realpath(path),
          cwdRelation: "inside",
          totalLines: 1,
        },
      },
    });
  });

  it("follows an entry symlink and marks a Real Target Path outside Session cwd", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-read-outside-"));
    try {
      const target = join(outside, "target.txt");
      await writeFile(target, "outside\n", "utf8");
      const entry = join(sessionCwd, "link.txt");
      await symlink(target, entry, process.platform === "win32" ? "file" : undefined);

      const result = await tool.execute({ path: "link.txt" });
      expect(result).toMatchObject({
        ok: true,
        result: {
          resolvedPath: entry,
          realTargetPath: await realpath(target),
          cwdRelation: "outside",
          content: "outside\n",
        },
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("reads an absolute path outside Session cwd and reports cwdRelation outside", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-read-abs-"));
    try {
      const path = join(outside, "abs.txt");
      await writeFile(path, "abs\n", "utf8");
      const result = await tool.execute({ path });
      expect(result).toMatchObject({
        ok: true,
        result: {
          resolvedPath: path,
          realTargetPath: await realpath(path),
          cwdRelation: "outside",
          content: "abs\n",
        },
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("returns typed path, file-type, size, and UTF-8 errors", async () => {
    const missing = join(sessionCwd, "missing.txt");
    const directory = join(sessionCwd, "directory");
    await mkdir(directory);
    const nulPath = join(sessionCwd, "nul.txt");
    await writeFile(nulPath, Buffer.from([0x61, 0x00, 0x62]));
    const invalidPath = join(sessionCwd, "invalid-utf8.txt");
    await writeFile(invalidPath, Buffer.from([0x61, 0xff, 0x62]));
    const huge = join(sessionCwd, "huge.txt");
    await writeFile(huge, Buffer.alloc(0));
    await truncate(huge, READ_MAX_FILE_BYTES + 1);

    await expect(tool.execute({ path: missing })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "ENOENT",
        details: { resolvedPath: missing, cwdRelation: "inside" },
      },
    });
    await expect(tool.execute({ path: directory })).resolves.toMatchObject({
      ok: false,
      error: { code: "EISDIR", details: { resolvedPath: directory } },
    });
    await expect(tool.execute({ path: nulPath })).resolves.toMatchObject({
      ok: false,
      error: { code: "EBINARY", details: { resolvedPath: nulPath } },
    });
    await expect(tool.execute({ path: invalidPath })).resolves.toMatchObject({
      ok: false,
      error: { code: "EBINARY", details: { resolvedPath: invalidPath } },
    });
    await expect(tool.execute({ path: huge })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "EFILE_TOO_LARGE",
        details: {
          resolvedPath: huge,
          actualBytes: READ_MAX_FILE_BYTES + 1,
          limitBytes: READ_MAX_FILE_BYTES,
        },
      },
    });
    await expect(tool.execute({ path: "" })).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_PATH" },
    });

    if (POSIX) {
      const forbidden = join(sessionCwd, "forbidden.txt");
      await writeFile(forbidden, "secret\n", "utf8");
      await chmod(forbidden, 0o000);
      await expect(tool.execute({ path: forbidden })).resolves.toMatchObject({
        ok: false,
        error: { code: "EACCES", details: { resolvedPath: forbidden } },
      });
      await chmod(forbidden, 0o644);

      await expect(tool.execute({ path: "/dev/null" })).resolves.toMatchObject({
        ok: false,
        error: { code: "EUNSUPPORTED" },
      });
    }
  });

  it("applies typed-error precedence from schema through conflict", async () => {
    const directory = join(sessionCwd, "dir");
    await mkdir(directory);
    const hugeBinary = join(sessionCwd, "huge-binary.txt");
    await writeFile(hugeBinary, Buffer.from([0x00]));
    await truncate(hugeBinary, READ_MAX_FILE_BYTES + 1);

    await expect(
      tool.execute({ path: directory, extra: true }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "extra" } },
    });
    await expect(
      tool.execute({ path: directory, offset: 99 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EISDIR" },
    });
    await expect(tool.execute({ path: hugeBinary })).resolves.toMatchObject({
      ok: false,
      error: { code: "EFILE_TOO_LARGE" },
    });
  });

  it("maps an already-aborted timeout signal to ETIMEDOUT", async () => {
    const path = join(sessionCwd, "timeout.txt");
    await writeFile(path, "ok\n", "utf8");
    const signal = AbortSignal.timeout(0);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(tool.execute({ path }, signal)).resolves.toMatchObject({
      ok: false,
      error: { code: "ETIMEDOUT" },
    });
  });

  it("maps a cancelled AbortSignal to ETOOL", async () => {
    const path = join(sessionCwd, "cancel.txt");
    await writeFile(path, "ok\n", "utf8");
    const controller = new AbortController();
    controller.abort();

    await expect(tool.execute({ path }, controller.signal)).resolves.toMatchObject({
      ok: false,
      error: { code: "ETOOL" },
    });
  });
});
