import type { Stats } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  observeReplacementTarget,
  replaceFile,
  type FileReplacementIdentity,
} from "../src/index.js";

const POSIX = process.platform !== "win32";

function identityFrom(stats: Stats): FileReplacementIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    nlink: stats.nlink,
    mode: stats.mode,
  };
}

describe("file replacement", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "susan-file-replacement-"));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("observes a missing path as a create baseline", async () => {
    await expect(
      observeReplacementTarget(join(directory, "missing.txt")),
    ).resolves.toEqual({
      ok: true,
      value: { exists: false },
    });
  });

  it("observes a regular file identity for overwrite", async () => {
    const targetPath = join(directory, "existing.txt");
    await writeFile(targetPath, "present\n");
    const before = await stat(targetPath);

    await expect(observeReplacementTarget(targetPath)).resolves.toEqual({
      ok: true,
      value: {
        exists: true,
        identity: identityFrom(before),
      },
    });
  });

  it("rejects a directory target when observing", async () => {
    const targetPath = join(directory, "folder");
    await mkdir(targetPath);

    await expect(observeReplacementTarget(targetPath)).resolves.toMatchObject({
      ok: false,
      error: { code: "EISDIR" },
    });
  });

  it("lets write create and edit overwrite through the same commit", async () => {
    const createdPath = join(directory, "created.txt");
    const editedPath = join(directory, "edited.txt");
    await writeFile(editedPath, "before-edit\n");

    const createdBaseline = await observeReplacementTarget(createdPath);
    if (!createdBaseline.ok) {
      throw new Error(createdBaseline.error.message);
    }
    const created = await replaceFile({
      targetPath: createdPath,
      contents: Buffer.from("write-created\n", "utf8"),
      baseline: createdBaseline.value,
    });
    const observed = await observeReplacementTarget(editedPath);
    if (!observed.ok) {
      throw new Error(observed.error.message);
    }
    const edited = await replaceFile({
      targetPath: editedPath,
      contents: Buffer.from("edit-applied\n", "utf8"),
      baseline: observed.value,
    });

    expect(created).toMatchObject({ ok: true, value: { operation: "created" } });
    expect(edited).toMatchObject({
      ok: true,
      value: { operation: "overwritten", detachedHardLinks: false },
    });
    await expect(readFile(createdPath, "utf8")).resolves.toBe("write-created\n");
    await expect(readFile(editedPath, "utf8")).resolves.toBe("edit-applied\n");
  });

  it("creates a new file with the exact bytes and leaves no temporary file", async () => {
    const targetPath = join(directory, "notes.txt");
    const contents = Buffer.from("hello\n", "utf8");

    const result = await replaceFile({
      targetPath,
      contents,
      baseline: { exists: false },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        operation: "created",
        bytesWritten: 6,
        detachedHardLinks: false,
      },
    });
    await expect(readFile(targetPath)).resolves.toEqual(contents);
    await expect(readdir(directory)).resolves.toEqual(["notes.txt"]);
  });

  it("overwrites an existing file and reports the original hard-link state", async () => {
    const targetPath = join(directory, "notes.txt");
    await writeFile(targetPath, "old\n");
    const before = await stat(targetPath);

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("new\n", "utf8"),
      baseline: {
        exists: true,
        identity: identityFrom(before),
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        operation: "overwritten",
        bytesWritten: 4,
        detachedHardLinks: false,
      },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("new\n");
  });

  it.skipIf(!POSIX)("creates a new file with 0666 masked by umask", async () => {
    const probePath = join(directory, "probe.txt");
    await writeFile(probePath, "x", { mode: 0o666 });
    const expectedMode = (await stat(probePath)).mode & 0o777;
    const targetPath = join(directory, "created.txt");

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("created\n", "utf8"),
      baseline: { exists: false },
    });

    expect(result).toMatchObject({ ok: true, value: { operation: "created" } });
    expect((await stat(targetPath)).mode & 0o777).toBe(expectedMode);
  });

  it.skipIf(!POSIX)("preserves ordinary permission bits when overwriting", async () => {
    const targetPath = join(directory, "executable.sh");
    await writeFile(targetPath, "old\n", { mode: 0o755 });
    await chmod(targetPath, 0o755);
    const before = await stat(targetPath);

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("new\n", "utf8"),
      baseline: {
        exists: true,
        identity: identityFrom(before),
      },
    });

    expect(result).toMatchObject({ ok: true, value: { operation: "overwritten" } });
    expect((await stat(targetPath)).mode & 0o777).toBe(0o755);
  });

  it("detaches other hard links and reports detachedHardLinks", async () => {
    const targetPath = join(directory, "shared.txt");
    const otherPath = join(directory, "other.txt");
    await writeFile(targetPath, "shared-old\n");
    await link(targetPath, otherPath);
    const before = await stat(targetPath);
    expect(before.nlink).toBeGreaterThan(1);

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("shared-new\n", "utf8"),
      baseline: {
        exists: true,
        identity: identityFrom(before),
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        operation: "overwritten",
        bytesWritten: 11,
        detachedHardLinks: true,
      },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("shared-new\n");
    await expect(readFile(otherPath, "utf8")).resolves.toBe("shared-old\n");
    expect((await stat(targetPath)).ino).not.toBe(before.ino);
    expect((await stat(otherPath)).ino).toBe(before.ino);
  });

  it("returns ECONFLICT and leaves the target unchanged when its identity changes before commit", async () => {
    const targetPath = join(directory, "raced.txt");
    await writeFile(targetPath, "original\n");
    const before = await stat(targetPath);

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("replacement\n", "utf8"),
      baseline: {
        exists: true,
        identity: identityFrom(before),
      },
      hooks: {
        afterFlush: async () => {
          await writeFile(targetPath, "external\n");
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ECONFLICT" },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("external\n");
    await expect(readdir(directory)).resolves.toEqual(["raced.txt"]);
  });

  it("returns ECONFLICT when a missing target appears before commit", async () => {
    const targetPath = join(directory, "appeared.txt");

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("created\n", "utf8"),
      baseline: { exists: false },
      hooks: {
        afterFlush: async () => {
          await writeFile(targetPath, "sneaked-in\n");
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ECONFLICT" },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("sneaked-in\n");
  });

  it("returns ECONFLICT when an existing target disappears before commit", async () => {
    const targetPath = join(directory, "deleted.txt");
    await writeFile(targetPath, "doomed\n");
    const before = await stat(targetPath);

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("late\n", "utf8"),
      baseline: {
        exists: true,
        identity: identityFrom(before),
      },
      hooks: {
        afterFlush: async () => {
          await rm(targetPath);
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ECONFLICT" },
    });
    await expect(stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the target unchanged and removes the temporary file when cancelled before commit", async () => {
    const targetPath = join(directory, "kept.txt");
    await writeFile(targetPath, "keep\n");
    const before = await stat(targetPath);
    const controller = new AbortController();

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("cancelled\n", "utf8"),
      baseline: {
        exists: true,
        identity: identityFrom(before),
      },
      signal: controller.signal,
      hooks: {
        afterFlush: async () => {
          controller.abort();
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ETOOL" },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("keep\n");
    await expect(readdir(directory)).resolves.toEqual(["kept.txt"]);
  });

  it("returns ETIMEDOUT when the abort reason is a timeout", async () => {
    const targetPath = join(directory, "slow.txt");
    const signal = AbortSignal.timeout(1);
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("late\n", "utf8"),
      baseline: { exists: false },
      signal,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ETIMEDOUT" },
    });
    await expect(stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns success and does not roll back after a successful replace", async () => {
    const targetPath = join(directory, "committed.txt");
    const controller = new AbortController();

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("committed\n", "utf8"),
      baseline: { exists: false },
      signal: controller.signal,
      hooks: {
        afterReplace: async () => {
          controller.abort();
        },
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        operation: "created",
        bytesWritten: 10,
        detachedHardLinks: false,
      },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("committed\n");
  });

  it("keeps the original error and reports temporaryResidue when cleanup fails", async () => {
    const targetPath = join(directory, "residue.txt");
    await writeFile(targetPath, "original\n");
    const before = await stat(targetPath);
    let leftover: string | undefined;

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("lost\n", "utf8"),
      baseline: {
        exists: true,
        identity: identityFrom(before),
      },
      hooks: {
        afterFlush: async () => {
          await writeFile(targetPath, "external\n");
        },
        unlinkTemporary: async (temporaryPath) => {
          leftover = temporaryPath;
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "ECONFLICT",
        details: {
          temporaryResidue: true,
          temporaryPath: leftover,
        },
      },
    });
    expect(leftover).toEqual(expect.stringMatching(/\.susan-[0-9a-f]{16}\.tmp$/));
    await expect(readFile(targetPath, "utf8")).resolves.toBe("external\n");
    await expect(readFile(leftover!, "utf8")).resolves.toBe("lost\n");
  });

  it("returns a Result when the parent directory is missing", async () => {
    const targetPath = join(directory, "missing-parent", "notes.txt");

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("orphan\n", "utf8"),
      baseline: { exists: false },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ENOENT" },
    });
  });

  it("returns success when a hook fails after replace", async () => {
    const targetPath = join(directory, "post-commit.txt");

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("kept\n", "utf8"),
      baseline: { exists: false },
      hooks: {
        afterReplace: async () => {
          throw new Error("observer failed");
        },
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        operation: "created",
        bytesWritten: 5,
        detachedHardLinks: false,
      },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("kept\n");
  });

  it.skipIf(!POSIX)("POSIX rename does not unlink the destination before commit", async () => {
    const targetPath = join(directory, "posix.txt");
    await writeFile(targetPath, "old\n");
    const before = await stat(targetPath);
    let unlinked = false;

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("new\n", "utf8"),
      baseline: {
        exists: true,
        identity: identityFrom(before),
      },
      platform: "darwin",
      hooks: {
        afterUnlinkDestination: async () => {
          unlinked = true;
          throw Object.assign(new Error("should not run"), { code: "EIO" });
        },
      },
    });

    expect(unlinked).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      value: { operation: "overwritten" },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("new\n");
  });

  it.skipIf(!POSIX)("keeps the old file when POSIX replace fails before commit", async () => {
    const targetPath = join(directory, "atomic.txt");
    await writeFile(targetPath, "old-or-new\n");
    const before = await stat(targetPath);

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("replacement\n", "utf8"),
      baseline: {
        exists: true,
        identity: identityFrom(before),
      },
      platform: "darwin",
      hooks: {
        replace: async () => {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "EIO" },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("old-or-new\n");
    await expect(readdir(directory)).resolves.toEqual(["atomic.txt"]);
  });

  it("uses Windows best-effort replacement that can lose the destination after unlink", async () => {
    const targetPath = join(directory, "windows.txt");
    await writeFile(targetPath, "windows-old\n");
    const before = await stat(targetPath);

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("windows-new\n", "utf8"),
      baseline: {
        exists: true,
        identity: identityFrom(before),
      },
      platform: "win32",
      hooks: {
        afterUnlinkDestination: async () => {
          throw Object.assign(new Error("interrupted"), { code: "EIO" });
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "EIO" },
    });
    await expect(stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("replaces an existing file on the Windows best-effort path", async () => {
    const targetPath = join(directory, "win-ok.txt");
    await writeFile(targetPath, "before\n");
    const before = await stat(targetPath);

    const result = await replaceFile({
      targetPath,
      contents: Buffer.from("after\n", "utf8"),
      baseline: {
        exists: true,
        identity: identityFrom(before),
      },
      platform: "win32",
    });

    expect(result).toMatchObject({
      ok: true,
      value: { operation: "overwritten", bytesWritten: 6 },
    });
    await expect(readFile(targetPath, "utf8")).resolves.toBe("after\n");
  });
});
