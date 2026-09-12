import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WRITE_PROMPT_GUIDELINES,
  WRITE_PROMPT_SNIPPET,
  createWriteTool,
  type ToolResult,
  type WriteTool,
} from "../src/index";

const POSIX = process.platform !== "win32";

const WRITE_DESCRIPTION =
  "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.";

function textOf(result: ToolResult): string {
  const block = result.content[0];
  if (block === undefined || block.type !== "text") {
    throw new Error("expected a text content block");
  }
  return block.text;
}

describe("Write Tool", () => {
  let sessionCwd: string;
  let tool: WriteTool;

  beforeEach(async () => {
    sessionCwd = await mkdtemp(join(tmpdir(), "susan-write-"));
    tool = createWriteTool({ sessionCwd });
  });

  afterEach(async () => {
    await rm(sessionCwd, { force: true, recursive: true });
  });

  it("exposes the Pi write definition", () => {
    expect(tool).toMatchObject({
      name: "write",
      description: WRITE_DESCRIPTION,
      promptSnippet: WRITE_PROMPT_SNIPPET,
      promptGuidelines: WRITE_PROMPT_GUIDELINES,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Path to the file to write (relative or absolute)",
          },
          content: {
            type: "string",
            description: "Content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    });
    expect(WRITE_PROMPT_SNIPPET).toBe("Create or overwrite files");
    expect(WRITE_PROMPT_GUIDELINES).toEqual([
      "Use write only for new files or complete rewrites.",
    ]);
  });

  it("creates a UTF-8 file with the exact content and reports the input path", async () => {
    const path = join(sessionCwd, "notes.txt");

    const result = await tool.execute({ path, content: "first\nsecond" });

    expect(result).toEqual({
      content: [{ type: "text", text: `Successfully wrote to ${path}` }],
      details: undefined,
    });
    await expect(readFile(path, "utf8")).resolves.toBe("first\nsecond");
  });

  it("writes empty content and a missing trailing newline as-is", async () => {
    const empty = join(sessionCwd, "empty.txt");
    const none = join(sessionCwd, "none.txt");

    expect(textOf(await tool.execute({ path: empty, content: "" }))).toBe(
      `Successfully wrote to ${empty}`,
    );
    expect(textOf(await tool.execute({ path: none, content: "a\nb" }))).toBe(
      `Successfully wrote to ${none}`,
    );
    await expect(readFile(empty)).resolves.toEqual(Buffer.alloc(0));
    await expect(readFile(none, "utf8")).resolves.toBe("a\nb");
  });

  it("writes BOM, LF, CRLF, and mixed endings without rewriting them", async () => {
    const cases = [
      ["bom.txt", "\uFEFFhello\r\n"],
      ["lf.txt", "a\nb\n"],
      ["crlf.txt", "a\r\nb\r\n"],
      ["mixed.txt", "a\r\nb\n"],
    ] as const;

    for (const [name, content] of cases) {
      const path = join(sessionCwd, name);
      await tool.execute({ path, content });
      await expect(readFile(path)).resolves.toEqual(Buffer.from(content, "utf8"));
    }
  });

  it("recursively creates missing parents and resolves paths against Session cwd", async () => {
    const previous = process.cwd();
    const processCwd = await mkdtemp(join(tmpdir(), "susan-write-process-"));
    try {
      process.chdir(processCwd);

      const result = await tool.execute({
        path: "nested/deep/notes.txt",
        content: "nested",
      });

      expect(result).toEqual({
        content: [{
          type: "text",
          text: "Successfully wrote to nested/deep/notes.txt",
        }],
        details: undefined,
      });
      await expect(
        readFile(join(sessionCwd, "nested/deep/notes.txt"), "utf8"),
      ).resolves.toBe("nested");
    } finally {
      process.chdir(previous);
      await rm(processCwd, { force: true, recursive: true });
    }
  });

  it.skipIf(!POSIX)("uses umask for new parents and files", async () => {
    const probeDirectory = join(sessionCwd, "probe-directory");
    const probeFile = join(sessionCwd, "probe-file");
    await mkdir(probeDirectory, { mode: 0o777 });
    await writeFile(probeFile, "", { mode: 0o666 });
    const expectedDirectoryMode = (await stat(probeDirectory)).mode & 0o777;
    const expectedFileMode = (await stat(probeFile)).mode & 0o777;

    await tool.execute({
      path: "new-parent/new-file",
      content: "created",
    });

    expect((await stat(join(sessionCwd, "new-parent"))).mode & 0o777).toBe(
      expectedDirectoryMode,
    );
    expect((await stat(join(sessionCwd, "new-parent/new-file"))).mode & 0o777).toBe(
      expectedFileMode,
    );
  });

  it.skipIf(!POSIX)("overwrites in place and keeps hard links sharing content", async () => {
    const path = join(sessionCwd, "script.sh");
    const otherPath = join(sessionCwd, "other.sh");
    await writeFile(path, "old\n", { mode: 0o755 });
    await chmod(path, 0o755);
    await link(path, otherPath);
    const before = await stat(path);

    const result = await tool.execute({ path, content: "new\n" });

    expect(result).toEqual({
      content: [{ type: "text", text: `Successfully wrote to ${path}` }],
      details: undefined,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o755);
    expect((await stat(path)).ino).toBe(before.ino);
    expect((await stat(otherPath)).ino).toBe(before.ino);
    await expect(readFile(path, "utf8")).resolves.toBe("new\n");
    await expect(readFile(otherPath, "utf8")).resolves.toBe("new\n");
  });

  it("writes outside cwd and follows an existing parent symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-write-outside-"));
    try {
      const linkedParent = join(sessionCwd, "linked");
      await symlink(
        outside,
        linkedParent,
        process.platform === "win32" ? "junction" : undefined,
      );

      const result = await tool.execute({
        path: "linked/created.txt",
        content: "outside",
      });

      expect(result).toEqual({
        content: [{
          type: "text",
          text: "Successfully wrote to linked/created.txt",
        }],
        details: undefined,
      });
      await expect(readFile(join(outside, "created.txt"), "utf8")).resolves.toBe(
        "outside",
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("follows a final symlink and overwrites the target", async () => {
    const target = join(sessionCwd, "target.txt");
    const linked = join(sessionCwd, "linked.txt");
    await writeFile(target, "kept");
    await symlink(
      target,
      linked,
      process.platform === "win32" ? "file" : undefined,
    );

    const result = await tool.execute({ path: linked, content: "replaced" });

    expect(result).toEqual({
      content: [{ type: "text", text: `Successfully wrote to ${linked}` }],
      details: undefined,
    });
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe("replaced");
    await expect(readFile(linked, "utf8")).resolves.toBe("replaced");
  });

  it("follows a dangling symlink and creates the target file", async () => {
    const target = join(sessionCwd, "missing.txt");
    const dangling = join(sessionCwd, "dangling.txt");
    await symlink(
      target,
      dangling,
      process.platform === "win32" ? "file" : undefined,
    );

    await tool.execute({ path: dangling, content: "created" });

    expect((await lstat(dangling)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, "utf8")).resolves.toBe("created");
  });

  it("strips a leading @ from the path", async () => {
    const result = await tool.execute({ path: "@at.txt", content: "at-file" });
    expect(textOf(result)).toBe("Successfully wrote to @at.txt");
    await expect(readFile(join(sessionCwd, "at.txt"), "utf8")).resolves.toBe(
      "at-file",
    );
  });

  it("normalizes unicode spaces in the path", async () => {
    await tool.execute({ path: "file\u00A0name.txt", content: "spaced" });
    await expect(
      readFile(join(sessionCwd, "file name.txt"), "utf8"),
    ).resolves.toBe("spaced");
  });

  it("writes content larger than 10 MiB", async () => {
    const path = join(sessionCwd, "large.txt");
    const content = "a".repeat(10 * 1024 * 1024 + 1);

    const result = await tool.execute({ path, content });

    expect(result).toEqual({
      content: [{ type: "text", text: `Successfully wrote to ${path}` }],
      details: undefined,
    });
    await expect(readFile(path, "utf8")).resolves.toBe(content);
  });

  it("serializes concurrent writes to the same path", async () => {
    const path = join(sessionCwd, "raced.txt");

    await Promise.all([
      tool.execute({ path, content: "first" }),
      tool.execute({ path, content: "second" }),
    ]);

    const written = await readFile(path, "utf8");
    expect(written === "first" || written === "second").toBe(true);
  });

  it("rejects unknown fields and illegal argument types", async () => {
    await expect(tool.execute("nope")).rejects.toThrow("Invalid write arguments.");
    await expect(tool.execute({ path: 1, content: "x" })).rejects.toThrow(
      "Invalid write arguments.",
    );
    await expect(tool.execute({ path: "a.txt" })).rejects.toThrow(
      "Invalid write arguments.",
    );
    await expect(
      tool.execute({ path: "a.txt", content: "x", extra: true }),
    ).rejects.toThrow("Invalid write arguments.");
  });

  it("throws Node errors for directory and non-directory parent paths", async () => {
    const directory = join(sessionCwd, "directory");
    const parent = join(sessionCwd, "file-parent");
    await mkdir(directory);
    await writeFile(parent, "not a directory");

    await expect(
      tool.execute({ path: directory, content: "nope" }),
    ).rejects.toMatchObject({ code: "EISDIR" });
    await expect(
      tool.execute({ path: join(parent, "child.txt"), content: "nope" }),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("maps an already-aborted signal to Operation aborted", async () => {
    const path = join(sessionCwd, "abort.txt");
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool.execute({ path, content: "nope" }, controller.signal),
    ).rejects.toThrow("Operation aborted");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
