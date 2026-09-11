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

  it("reads a UTF-8 regular file and returns text content with file details", async () => {
    const path = join(sessionCwd, "notes.txt");
    await writeFile(path, "first\nsecond\nthird\n", "utf8");

    const result = await tool.execute({ path });

    expect(result).toEqual({
      content: [{ type: "text", text: "first\nsecond\nthird\n" }],
      details: {
        resolvedPath: path,
        realTargetPath: await realpath(path),
        cwdRelation: "inside",
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
      content: [{ type: "text", text: "" }],
      details: {
        resolvedPath: path,
        realTargetPath: await realpath(path),
        cwdRelation: "inside",
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
        content: [{ type: "text", text: "session\n" }],
        details: {
          resolvedPath: join(sessionCwd, "relative.txt"),
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
      content: [{ type: "text", text: "hello\n" }],
      details: {
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
      content: [{ type: "text", text: "a\nb\n" }],
      details: { lineEnding: "lf" },
    });
    await expect(tool.execute({ path: crlf })).resolves.toMatchObject({
      content: [{ type: "text", text: "a\r\nb\r\n" }],
      details: { lineEnding: "crlf" },
    });
    await expect(tool.execute({ path: mixed })).resolves.toMatchObject({
      content: [{ type: "text", text: "a\r\nb\n" }],
      details: { lineEnding: "mixed" },
    });
    await expect(tool.execute({ path: none })).resolves.toMatchObject({
      content: [{ type: "text", text: "a\nb" }],
      details: { lineEnding: "lf" },
    });
  });

  it("pages from a 1-based offset and appends a Pi-style continuation note", async () => {
    const path = join(sessionCwd, "lines.txt");
    const lines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");

    const result = await tool.execute({ path, offset: 4, limit: 3 });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "line-4\nline-5\nline-6\n\n[6 more lines in file. Use offset=7 to continue.]",
        },
      ],
      details: {
        resolvedPath: path,
        realTargetPath: await realpath(path),
        cwdRelation: "inside",
        range: { startLine: 4, endLine: 6 },
        totalLines: 12,
        sizeBytes: Buffer.byteLength(`${lines.join("\n")}\n`, "utf8"),
        bom: false,
        lineEnding: "lf",
        truncation: {
          truncatedBy: "lines",
          totalLines: 9,
          outputLines: 3,
          nextOffset: 7,
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
      content: [
        {
          type: "text",
          text: `${lines.slice(0, 2000).join("\n")}\n\n[1 more lines in file. Use offset=2001 to continue.]`,
        },
      ],
      details: {
        range: { startLine: 1, endLine: 2000 },
        totalLines: 2001,
        truncation: {
          truncatedBy: "lines",
          outputLines: 2000,
          nextOffset: 2001,
        },
      },
    });
  });

  it("returns the full file without a truncation note when it fits the limit", async () => {
    const path = join(sessionCwd, "fits.txt");
    await writeFile(path, "one\ntwo\n", "utf8");

    const result = await tool.execute({ path });
    expect(result.content).toEqual([{ type: "text", text: "one\ntwo\n" }]);
    expect(result.details?.truncation).toBeUndefined();
  });

  it("rejects unknown fields and illegal argument types", async () => {
    await expect(tool.execute("nope")).rejects.toThrow("Invalid read arguments.");
    await expect(tool.execute({ path: 1 })).rejects.toThrow("Invalid read arguments.");
    await expect(tool.execute({ path: "a.txt", extra: 1 })).rejects.toThrow(
      "Invalid read arguments.",
    );
    await expect(tool.execute({ path: "a.txt", offset: 1.5 })).rejects.toThrow(
      "Invalid read arguments.",
    );
    await expect(tool.execute({ path: "a.txt", limit: Number.NaN })).rejects.toThrow(
      "Invalid read arguments.",
    );
  });

  it("rejects out-of-range integers", async () => {
    const path = join(sessionCwd, "range.txt");
    await writeFile(path, "one\n", "utf8");

    await expect(tool.execute({ path, offset: 0 })).rejects.toThrow(
      "offset must be a positive integer.",
    );
    await expect(tool.execute({ path, limit: 0 })).rejects.toThrow(
      `limit must be an integer between 1 and ${READ_MAX_LINES}.`,
    );
    await expect(tool.execute({ path, limit: 2001 })).rejects.toThrow(
      `limit must be an integer between 1 and ${READ_MAX_LINES}.`,
    );
    await expect(tool.execute({ path, offset: 2 })).rejects.toThrow(
      "offset is beyond the end of the file.",
    );
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
        content: [{ type: "text", text: "outside\n" }],
        details: {
          resolvedPath: entry,
          realTargetPath: await realpath(target),
          cwdRelation: "outside",
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
        content: [{ type: "text", text: "abs\n" }],
        details: {
          resolvedPath: path,
          realTargetPath: await realpath(path),
          cwdRelation: "outside",
        },
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("throws free-text path, file-type, size, and UTF-8 errors", async () => {
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

    await expect(tool.execute({ path: missing })).rejects.toThrow(
      "Path does not exist.",
    );
    await expect(tool.execute({ path: directory })).rejects.toThrow(
      "Path is a directory.",
    );
    await expect(tool.execute({ path: nulPath })).rejects.toThrow(
      "File is not valid UTF-8 text.",
    );
    await expect(tool.execute({ path: invalidPath })).rejects.toThrow(
      "File is not valid UTF-8 text.",
    );
    await expect(tool.execute({ path: huge })).rejects.toThrow(
      "File exceeds the 100 MiB size limit.",
    );
    await expect(tool.execute({ path: "" })).rejects.toThrow(
      "Path syntax is invalid.",
    );

    if (POSIX) {
      const forbidden = join(sessionCwd, "forbidden.txt");
      await writeFile(forbidden, "secret\n", "utf8");
      await chmod(forbidden, 0o000);
      await expect(tool.execute({ path: forbidden })).rejects.toThrow(
        "File cannot be read.",
      );
      await chmod(forbidden, 0o644);

      await expect(tool.execute({ path: "/dev/null" })).rejects.toThrow(
        "Path is not a regular file.",
      );
    }
  });

  it("applies error precedence from schema through conflict", async () => {
    const directory = join(sessionCwd, "dir");
    await mkdir(directory);
    const hugeBinary = join(sessionCwd, "huge-binary.txt");
    await writeFile(hugeBinary, Buffer.from([0x00]));
    await truncate(hugeBinary, READ_MAX_FILE_BYTES + 1);

    await expect(
      tool.execute({ path: directory, extra: true }),
    ).rejects.toThrow("Invalid read arguments.");
    await expect(
      tool.execute({ path: directory, offset: 99 }),
    ).rejects.toThrow("Path is a directory.");
    await expect(tool.execute({ path: hugeBinary })).rejects.toThrow(
      "File exceeds the 100 MiB size limit.",
    );
  });

  it("maps an already-aborted timeout signal to a timeout error", async () => {
    const path = join(sessionCwd, "timeout.txt");
    await writeFile(path, "ok\n", "utf8");
    const signal = AbortSignal.timeout(0);
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(tool.execute({ path }, signal)).rejects.toThrow("Read timed out.");
  });

  it("maps a cancelled AbortSignal to a tool failure", async () => {
    const path = join(sessionCwd, "cancel.txt");
    await writeFile(path, "ok\n", "utf8");
    const controller = new AbortController();
    controller.abort();

    await expect(tool.execute({ path }, controller.signal)).rejects.toThrow(
      "Tool execution failed.",
    );
  });
});
