import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WRITE_MAX_CONTENT_BYTES,
  createWriteTool,
  type WriteTool,
} from "../src/index.js";

const POSIX = process.platform !== "win32";

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

  it("creates a UTF-8 regular file with the exact content", async () => {
    const path = join(sessionCwd, "notes.txt");

    const result = await tool.execute({ path, content: "first\nsecond" });

    expect(result).toEqual({
      ok: true,
      result: {
        resolvedPath: path,
        realTargetPath: await realpath(path),
        cwdRelation: "inside",
        operation: "created",
        bytesWritten: 12,
        bom: false,
        lineEnding: "lf",
        detachedHardLinks: false,
      },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("first\nsecond");
  });

  it("exposes a strict write({ path, content }) definition", () => {
    expect(tool).toMatchObject({
      name: "write",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    });
  });

  it("writes BOM only from a leading U+FEFF and reports line endings", async () => {
    const cases = [
      ["empty.txt", "", false, "none"],
      ["bom.txt", "\uFEFFhello\r\n", true, "crlf"],
      ["embedded.txt", `a\uFEFFb\n`, false, "lf"],
      ["mixed.txt", "a\r\nb\n", false, "mixed"],
    ] as const;

    for (const [name, content, bom, lineEnding] of cases) {
      const path = join(sessionCwd, name);
      const result = await tool.execute({ path, content });

      expect(result).toMatchObject({
        ok: true,
        result: {
          bytesWritten: Buffer.byteLength(content, "utf8"),
          bom,
          lineEnding,
        },
      });
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

      expect(result).toMatchObject({
        ok: true,
        result: {
          resolvedPath: join(sessionCwd, "nested/deep/notes.txt"),
          cwdRelation: "inside",
          operation: "created",
        },
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

    const result = await tool.execute({
      path: "new-parent/new-file",
      content: "created",
    });

    expect(result).toMatchObject({ ok: true });
    expect((await stat(join(sessionCwd, "new-parent"))).mode & 0o777).toBe(
      expectedDirectoryMode,
    );
    expect((await stat(join(sessionCwd, "new-parent/new-file"))).mode & 0o777).toBe(
      expectedFileMode,
    );
  });

  it.skipIf(!POSIX)("preserves mode and detaches hard links on overwrite", async () => {
    const path = join(sessionCwd, "script.sh");
    const otherPath = join(sessionCwd, "other.sh");
    await writeFile(path, "old\n", { mode: 0o755 });
    await chmod(path, 0o755);
    await link(path, otherPath);
    const before = await stat(path);

    const result = await tool.execute({ path, content: "new\n" });

    expect(result).toMatchObject({
      ok: true,
      result: {
        operation: "overwritten",
        bytesWritten: 4,
        detachedHardLinks: true,
      },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o755);
    expect((await stat(path)).ino).not.toBe(before.ino);
    expect((await stat(otherPath)).ino).toBe(before.ino);
    await expect(readFile(path, "utf8")).resolves.toBe("new\n");
    await expect(readFile(otherPath, "utf8")).resolves.toBe("old\n");
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

      expect(result).toMatchObject({
        ok: true,
        result: {
          resolvedPath: join(linkedParent, "created.txt"),
          realTargetPath: join(await realpath(outside), "created.txt"),
          cwdRelation: "outside",
        },
      });
      await expect(readFile(join(outside, "created.txt"), "utf8")).resolves.toBe(
        "outside",
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("rejects final symlinks, including dangling symlinks", async () => {
    const target = join(sessionCwd, "target.txt");
    const linked = join(sessionCwd, "linked.txt");
    const dangling = join(sessionCwd, "dangling.txt");
    await writeFile(target, "kept");
    await symlink(
      target,
      linked,
      process.platform === "win32" ? "file" : undefined,
    );
    await symlink(
      join(sessionCwd, "missing.txt"),
      dangling,
      process.platform === "win32" ? "file" : undefined,
    );

    await expect(tool.execute({ path: linked, content: "nope" })).resolves.toMatchObject({
      ok: false,
      error: { code: "ESYMLINK", details: { resolvedPath: linked } },
    });
    await expect(
      tool.execute({ path: dangling, content: "nope" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "ESYMLINK", details: { resolvedPath: dangling } },
    });
    await expect(readFile(target, "utf8")).resolves.toBe("kept");
    expect((await lstat(dangling)).isSymbolicLink()).toBe(true);
  });

  it("returns a path error when an existing parent component is not a directory", async () => {
    const parent = join(sessionCwd, "file-parent");
    await writeFile(parent, "not a directory");

    await expect(
      tool.execute({ path: join(parent, "child.txt"), content: "nope" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_PATH" },
    });
  });

  it("uses stable schema, path, type, size, and binary errors in precedence order", async () => {
    const directory = join(sessionCwd, "directory");
    await mkdir(directory);
    const oversizedBinary = `\0${"a".repeat(WRITE_MAX_CONTENT_BYTES)}`;

    await expect(
      tool.execute({ path: directory, content: oversizedBinary, extra: true }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL", details: { field: "extra" } },
    });
    await expect(
      tool.execute({ path: "", content: oversizedBinary }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_PATH" },
    });
    await expect(
      tool.execute({ path: directory, content: oversizedBinary }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EISDIR" },
    });
    await expect(
      tool.execute({ path: "large.txt", content: oversizedBinary }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: "EFILE_TOO_LARGE",
        details: {
          actualBytes: WRITE_MAX_CONTENT_BYTES + 1,
          limitBytes: WRITE_MAX_CONTENT_BYTES,
        },
      },
    });
    await expect(
      tool.execute({ path: "binary.txt", content: "a\0b" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EBINARY" },
    });
    await expect(
      tool.execute({ path: "invalid-unicode.txt", content: "\uD800" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EBINARY" },
    });
  });

  it.skipIf(!POSIX)("rejects special-file targets", async () => {
    await expect(
      tool.execute({ path: "/dev/null", content: "nope" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "EUNSUPPORTED", details: { cwdRelation: "outside" } },
    });
  });

  it("detects a target conflict before commit and leaves external content", async () => {
    const path = join(sessionCwd, "raced.txt");
    await writeFile(path, "original");
    tool = createWriteTool({
      sessionCwd,
      replacementHooks: {
        afterFlush: async () => {
          await writeFile(path, "external");
        },
      },
    });

    const result = await tool.execute({ path, content: "replacement" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ECONFLICT", details: { resolvedPath: path } },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("external");
  });

  it("cancels before commit without changing the target or leaving a temporary file", async () => {
    const path = join(sessionCwd, "cancelled.txt");
    await writeFile(path, "original");
    const controller = new AbortController();
    tool = createWriteTool({
      sessionCwd,
      replacementHooks: {
        afterFlush: async () => {
          controller.abort();
        },
      },
    });

    const result = await tool.execute(
      { path, content: "replacement" },
      controller.signal,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ETOOL", details: { resolvedPath: path } },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("original");
    await expect(readdir(sessionCwd)).resolves.toEqual(["cancelled.txt"]);
  });

  it("times out before commit without changing the target", async () => {
    const path = join(sessionCwd, "timeout.txt");
    await writeFile(path, "original");
    tool = createWriteTool({
      sessionCwd,
      timeoutMs: 250,
      replacementHooks: {
        afterFlush: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
        },
      },
    });

    const result = await tool.execute({ path, content: "replacement" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ETIMEDOUT", details: { resolvedPath: path } },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("original");
  });

  it("reports success when cancellation arrives after the replace commit", async () => {
    const path = join(sessionCwd, "committed.txt");
    const controller = new AbortController();
    tool = createWriteTool({
      sessionCwd,
      replacementHooks: {
        afterReplace: async () => {
          controller.abort();
        },
      },
    });

    const result = await tool.execute(
      { path, content: "committed" },
      controller.signal,
    );

    expect(result).toMatchObject({
      ok: true,
      result: { operation: "created", bytesWritten: 9 },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("committed");
  });

  it("preserves the primary error and reports temporary residue", async () => {
    const path = join(sessionCwd, "residue.txt");
    await writeFile(path, "original");
    let temporaryPath: string | undefined;
    tool = createWriteTool({
      sessionCwd,
      replacementHooks: {
        afterFlush: async () => {
          await writeFile(path, "external");
        },
        unlinkTemporary: async (pathToRemove) => {
          temporaryPath = pathToRemove;
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
      },
    });

    const result = await tool.execute({ path, content: "replacement" });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ECONFLICT",
        details: {
          resolvedPath: path,
          temporaryResidue: true,
          temporaryPath,
        },
      },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("external");
    await expect(readFile(temporaryPath!, "utf8")).resolves.toBe("replacement");
  });
});
