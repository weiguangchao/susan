import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  READ_PROMPT_GUIDELINES,
  READ_PROMPT_SNIPPET,
  createReadTool,
  type ReadTool,
  type ToolResult,
} from "../src/index.js";
import * as susan from "../src/index.js";

const POSIX = process.platform !== "win32";

const READ_DESCRIPTION =
  "Read the contents of a file. Output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.";

function textOf(result: ToolResult): string {
  const block = result.content[0];
  if (block === undefined || block.type !== "text") {
    throw new Error("expected a text content block");
  }
  return block.text;
}

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

  it("exposes the Pi read definition without a read_file alias", () => {
    expect(tool).toMatchObject({
      name: "read",
      description: READ_DESCRIPTION,
      promptSnippet: READ_PROMPT_SNIPPET,
      promptGuidelines: READ_PROMPT_GUIDELINES,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Path to the file to read (relative or absolute)",
          },
          offset: {
            type: "number",
            description: "Line number to start reading from (1-indexed)",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read",
          },
        },
        required: ["path"],
      },
    });
    expect(READ_PROMPT_SNIPPET).toBe("Read file contents");
    expect(READ_PROMPT_GUIDELINES).toEqual([
      "Use read to examine files instead of cat or sed.",
    ]);
    expect("readFileTool" in susan).toBe(false);
    expect(tool.name).not.toBe("read_file");
  });

  it("reads a file as plain text without line numbers or file metadata", async () => {
    const path = join(sessionCwd, "notes.txt");
    await writeFile(path, "first\nsecond\nthird\n", "utf8");

    const result = await tool.execute({ path });

    expect(result).toEqual({
      content: [{ type: "text", text: "first\nsecond\nthird\n" }],
      details: undefined,
    });
  });

  it("succeeds on an empty file", async () => {
    const path = join(sessionCwd, "empty.txt");
    await writeFile(path, Buffer.alloc(0));

    await expect(tool.execute({ path })).resolves.toEqual({
      content: [{ type: "text", text: "" }],
      details: undefined,
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
      expect(result).toEqual({
        content: [{ type: "text", text: "session\n" }],
        details: undefined,
      });
    } finally {
      process.chdir(previous);
      await rm(other, { force: true, recursive: true });
    }
  });

  it("keeps a UTF-8 BOM in the returned text", async () => {
    const path = join(sessionCwd, "bom.txt");
    await writeFile(path, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("hello\n", "utf8"),
    ]));

    expect(textOf(await tool.execute({ path }))).toBe("\uFEFFhello\n");
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

    expect(textOf(await tool.execute({ path: lf }))).toBe("a\nb\n");
    expect(textOf(await tool.execute({ path: crlf }))).toBe("a\r\nb\r\n");
    expect(textOf(await tool.execute({ path: mixed }))).toBe("a\r\nb\n");
    expect(textOf(await tool.execute({ path: none }))).toBe("a\nb");
  });

  it("pages from a 1-based offset and appends a remaining-lines note", async () => {
    const path = join(sessionCwd, "lines.txt");
    const lines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
    await writeFile(path, lines.join("\n"), "utf8");

    const result = await tool.execute({ path, offset: 4, limit: 3 });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "line-4\nline-5\nline-6\n\n[6 more lines in file. Use offset=7 to continue.]",
        },
      ],
      details: undefined,
    });
  });

  it("reads the full file when it fits and does not default limit to 2000", async () => {
    const path = join(sessionCwd, "fits.txt");
    await writeFile(path, "one\ntwo\n", "utf8");

    const result = await tool.execute({ path });
    expect(result.content).toEqual([{ type: "text", text: "one\ntwo\n" }]);
    expect(result.details).toBeUndefined();
  });

  it("truncates at 2000 lines and tells the model the next offset", async () => {
    const path = join(sessionCwd, "many-lines.txt");
    const lines = Array.from(
      { length: 2001 },
      (_, index) => `line-${index + 1}`,
    );
    await writeFile(path, lines.join("\n"), "utf8");

    const result = await tool.execute({ path });
    expect(textOf(result)).toBe(
      `${lines.slice(0, 2000).join("\n")}\n\n[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]`,
    );
    expect(result.details?.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "lines",
      outputLines: 2000,
      firstLineExceedsLimit: false,
      maxLines: DEFAULT_MAX_LINES,
    });
  });

  it("truncates at 50KB on whole lines and tells the model the byte limit", async () => {
    const path = join(sessionCwd, "wide.txt");
    const line = "x".repeat(10_000);
    const lines = Array.from({ length: 6 }, () => line);
    await writeFile(path, lines.join("\n"), "utf8");

    const result = await tool.execute({ path });
    expect(textOf(result)).toBe(
      `${lines.slice(0, 5).join("\n")}\n\n[Showing lines 1-5 of 6 (50.0KB limit). Use offset=6 to continue.]`,
    );
    expect(result.details?.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "bytes",
      outputLines: 5,
      maxBytes: DEFAULT_MAX_BYTES,
    });
  });

  it("rejects a first line that exceeds 50KB and points at a bash fallback", async () => {
    const relative = "huge-line.txt";
    const path = join(sessionCwd, relative);
    await writeFile(path, "y".repeat(51 * 1024), "utf8");

    const result = await tool.execute({ path: relative });
    expect(textOf(result)).toBe(
      `[Line 1 is 51.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' ${relative} | head -c ${DEFAULT_MAX_BYTES}]`,
    );
    expect(result.details?.truncation).toMatchObject({
      truncated: true,
      truncatedBy: "bytes",
      outputLines: 0,
      firstLineExceedsLimit: true,
    });
  });

  it("clamps a non-positive offset to the first line", async () => {
    const path = join(sessionCwd, "clamp.txt");
    await writeFile(path, "alpha\nbeta\n", "utf8");

    expect(textOf(await tool.execute({ path, offset: 0 }))).toBe("alpha\nbeta\n");
    expect(textOf(await tool.execute({ path, offset: -3 }))).toBe(
      "alpha\nbeta\n",
    );
  });

  it("throws when offset is beyond the end of the file", async () => {
    const path = join(sessionCwd, "short.txt");
    await writeFile(path, "one\ntwo", "utf8");

    await expect(tool.execute({ path, offset: 3 })).rejects.toThrow(
      "Offset 3 is beyond end of file (2 lines total)",
    );
  });

  it("decodes invalid UTF-8 with replacement characters instead of failing", async () => {
    const path = join(sessionCwd, "binary.txt");
    await writeFile(path, Buffer.from([0x61, 0x00, 0xff, 0x62]));

    expect(textOf(await tool.execute({ path }))).toBe("a\u0000\uFFFD" + "b");
  });

  it("follows an entry symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-read-outside-"));
    try {
      const target = join(outside, "target.txt");
      await writeFile(target, "outside\n", "utf8");
      await symlink(
        target,
        join(sessionCwd, "link.txt"),
        process.platform === "win32" ? "file" : undefined,
      );

      expect(await tool.execute({ path: "link.txt" })).toEqual({
        content: [{ type: "text", text: "outside\n" }],
        details: undefined,
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("reads an absolute path outside Session cwd", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-read-abs-"));
    try {
      const path = join(outside, "abs.txt");
      await writeFile(path, "abs\n", "utf8");
      expect(await tool.execute({ path })).toEqual({
        content: [{ type: "text", text: "abs\n" }],
        details: undefined,
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("strips a leading @ from the path", async () => {
    await writeFile(join(sessionCwd, "at.txt"), "at-file\n", "utf8");
    expect(textOf(await tool.execute({ path: "@at.txt" }))).toBe("at-file\n");
  });

  it("normalizes unicode spaces in the path", async () => {
    await writeFile(join(sessionCwd, "file name.txt"), "spaced\n", "utf8");
    expect(textOf(await tool.execute({ path: "file\u00A0name.txt" }))).toBe(
      "spaced\n",
    );
  });

  it("falls back to a curly-quote filename variant", async () => {
    await writeFile(join(sessionCwd, "Capture d\u2019cran.txt"), "quote\n", "utf8");
    expect(textOf(await tool.execute({ path: "Capture d'cran.txt" }))).toBe(
      "quote\n",
    );
  });

  it("falls back to a macOS screenshot AM/PM narrow no-break space", async () => {
    const onDisk = "Screenshot 2024-01-01 at 10.00.00\u202FAM.png";
    await writeFile(join(sessionCwd, onDisk), "shot\n", "utf8");
    expect(
      textOf(
        await tool.execute({
          path: "Screenshot 2024-01-01 at 10.00.00 AM.png",
        }),
      ),
    ).toBe("shot\n");
  });

  it("resolves a tilde-prefixed filename against Session cwd", async () => {
    await writeFile(join(sessionCwd, "~draft.md"), "draft\n", "utf8");
    expect(textOf(await tool.execute({ path: "~draft.md" }))).toBe("draft\n");
  });

  it("rejects unknown fields and illegal argument types", async () => {
    await expect(tool.execute("nope")).rejects.toThrow("Invalid read arguments.");
    await expect(tool.execute({ path: 1 })).rejects.toThrow("Invalid read arguments.");
    await expect(tool.execute({ path: "a.txt", extra: 1 })).rejects.toThrow(
      "Invalid read arguments.",
    );
    await expect(tool.execute({ path: "a.txt", offset: "1" })).rejects.toThrow(
      "Invalid read arguments.",
    );
    await expect(tool.execute({ path: "a.txt", limit: Number.NaN })).rejects.toThrow(
      "Invalid read arguments.",
    );
  });

  it("throws Node errors for missing, directory, and unreadable paths", async () => {
    const missing = join(sessionCwd, "missing.txt");
    const directory = join(sessionCwd, "directory");
    await mkdir(directory);

    await expect(tool.execute({ path: missing })).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(tool.execute({ path: directory })).rejects.toMatchObject({
      code: "EISDIR",
    });

    if (POSIX) {
      const forbidden = join(sessionCwd, "forbidden.txt");
      await writeFile(forbidden, "secret\n", "utf8");
      await chmod(forbidden, 0o000);
      await expect(tool.execute({ path: forbidden })).rejects.toMatchObject({
        code: "EACCES",
      });
      await chmod(forbidden, 0o644);
    }
  });

  it("maps an already-aborted signal to Operation aborted", async () => {
    const path = join(sessionCwd, "abort.txt");
    await writeFile(path, "ok\n", "utf8");
    const controller = new AbortController();
    controller.abort();

    await expect(tool.execute({ path }, controller.signal)).rejects.toThrow(
      "Operation aborted",
    );
  });
});
