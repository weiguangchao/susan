import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileTool } from "../src/index.js";

describe("read file tool", () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "susan-read-file-"));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempRoot, { force: true, recursive: true });
  });

  it("exposes the read_file tool definition", () => {
    expect(readFileTool).toMatchObject({
      name: "read_file",
      description: "Read a UTF-8 text file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 2000 },
        },
        required: ["path"],
      },
    });
  });

  it("reads a file by absolute path with default offset and limit", async () => {
    const filePath = join(tempRoot, "input.txt");
    await writeFile(filePath, "first\nsecond\nthird\n", "utf8");

    const result = await readFileTool.execute({ path: filePath });

    expect(result).toMatchObject({
      ok: true,
      result: {
        path: filePath,
        startLine: 1,
        endLine: 3,
        truncated: false,
        truncatedBy: null,
        nextOffset: null,
        truncatedLineCount: 0,
        content: "first\nsecond\nthird\n",
      },
    });
  });

  it("resolves a relative path against the process cwd", async () => {
    process.chdir(tempRoot);
    await writeFile("relative.txt", "relative\n", "utf8");

    const result = await readFileTool.execute({ path: "relative.txt" });

    expect(result).toMatchObject({
      ok: true,
      result: {
        path: join(process.cwd(), "relative.txt"),
        content: "relative\n",
      },
    });
  });

  it("pages by offset and limit and reports the next offset", async () => {
    const filePath = join(tempRoot, "lines.txt");
    const lines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

    const result = await readFileTool.execute({
      path: filePath,
      offset: 4,
      limit: 3,
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        startLine: 4,
        endLine: 6,
        truncated: true,
        truncatedBy: "lines",
        nextOffset: 7,
        truncatedLineCount: 0,
        content: "line-4\nline-5\nline-6\n",
      },
    });
  });

  it("stops before a line that would exceed the 50 KiB byte budget", async () => {
    const filePath = join(tempRoot, "byte-budget.txt");
    const lines = Array.from({ length: 33 }, () => "a".repeat(1599));
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

    const result = await readFileTool.execute({ path: filePath });

    expect(result).toMatchObject({
      ok: true,
      result: {
        endLine: 32,
        truncated: true,
        truncatedBy: "bytes",
        nextOffset: 33,
        truncatedLineCount: 0,
        content: `${lines.slice(0, 32).join("\n")}\n`,
      },
    });
    if (result.ok) {
      expect(Buffer.byteLength(result.result.content, "utf8")).toBe(50 * 1024);
    }
  });

  it("uses 2000 lines as the default limit", async () => {
    const filePath = join(tempRoot, "default-limit.txt");
    const lines = Array.from({ length: 2001 }, (_, index) => `${index + 1}`);
    await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

    const result = await readFileTool.execute({ path: filePath });

    expect(result).toMatchObject({
      ok: true,
      result: {
        endLine: 2000,
        truncated: true,
        truncatedBy: "lines",
        nextOffset: 2001,
        truncatedLineCount: 0,
        content: `${lines.slice(0, 2000).join("\n")}\n`,
      },
    });
  });

  it("truncates lines longer than 2000 characters", async () => {
    const filePath = join(tempRoot, "long-line.txt");
    await writeFile(filePath, `${"a".repeat(2500)}\nnext\n`, "utf8");

    const result = await readFileTool.execute({ path: filePath });

    expect(result).toMatchObject({
      ok: true,
      result: {
        endLine: 2,
        truncated: true,
        truncatedBy: "lineLength",
        nextOffset: 3,
        truncatedLineCount: 1,
        content: `${"a".repeat(2000)}\nnext\n`,
      },
    });
  });

  it("reports typed file-system errors without throwing", async () => {
    const missing = join(tempRoot, "missing.txt");
    const directory = join(tempRoot, "directory");
    await mkdir(directory);
    const forbidden = join(tempRoot, "forbidden.txt");
    await writeFile(forbidden, "secret\n", "utf8");
    await chmod(forbidden, 0o000);

    expect(await readFileTool.execute({ path: missing })).toMatchObject({
      ok: false,
      error: { code: "ENOENT", path: missing },
    });
    expect(await readFileTool.execute({ path: directory })).toMatchObject({
      ok: false,
      error: { code: "EISDIR", path: directory },
    });

    if (process.platform !== "win32") {
      expect(await readFileTool.execute({ path: forbidden })).toMatchObject({
        ok: false,
        error: { code: "EACCES", path: forbidden },
      });
    }
  });

  it("rejects binary and invalid UTF-8 content", async () => {
    const nulPath = join(tempRoot, "nul.txt");
    await writeFile(nulPath, Buffer.from([0x61, 0x00, 0x62]));
    const invalidPath = join(tempRoot, "invalid-utf8.txt");
    await writeFile(invalidPath, Buffer.from([0x61, 0xff, 0x62]));

    expect(await readFileTool.execute({ path: nulPath })).toMatchObject({
      ok: false,
      error: { code: "EBINARY", path: nulPath },
    });
    expect(await readFileTool.execute({ path: invalidPath })).toMatchObject({
      ok: false,
      error: { code: "EBINARY", path: invalidPath },
    });
  });

  it("rejects invalid paths, offsets, and limits", async () => {
    const filePath = join(tempRoot, "validation.txt");
    await writeFile(filePath, "one\n", "utf8");

    expect(await readFileTool.execute({ path: "" })).toMatchObject({
      ok: false,
      error: { code: "EINVAL_PATH" },
    });
    expect(await readFileTool.execute({ path: 1 })).toMatchObject({
      ok: false,
      error: { code: "EINVAL_PATH" },
    });
    expect(
      await readFileTool.execute({ path: filePath, offset: 0 }),
    ).toMatchObject({ ok: false, error: { code: "EINVAL_OFFSET" } });
    expect(
      await readFileTool.execute({ path: filePath, offset: 1.5 }),
    ).toMatchObject({ ok: false, error: { code: "EINVAL_OFFSET" } });
    expect(
      await readFileTool.execute({ path: filePath, offset: 2 }),
    ).toMatchObject({ ok: false, error: { code: "EINVAL_OFFSET" } });
    expect(
      await readFileTool.execute({ path: filePath, limit: 0 }),
    ).toMatchObject({ ok: false, error: { code: "EINVAL_LIMIT" } });
    expect(
      await readFileTool.execute({ path: filePath, limit: 2001 }),
    ).toMatchObject({ ok: false, error: { code: "EINVAL_LIMIT" } });
    expect(
      await readFileTool.execute({ path: filePath, limit: 1.5 }),
    ).toMatchObject({ ok: false, error: { code: "EINVAL_LIMIT" } });
  });
});
