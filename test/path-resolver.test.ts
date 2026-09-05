import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionPathResolver,
  type SessionPathResolver,
} from "../src/index.js";

describe("Session cwd path resolver", () => {
  let sessionCwd: string;
  let resolver: SessionPathResolver;

  beforeEach(async () => {
    sessionCwd = await mkdtemp(join(tmpdir(), "susan-path-resolver-"));
    const created = await createSessionPathResolver(sessionCwd);
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    resolver = created.value;
  });

  afterEach(async () => {
    await rm(sessionCwd, { force: true, recursive: true });
  });

  it("requires an absolute Session cwd", async () => {
    await expect(createSessionPathResolver("relative/session-cwd")).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_PATH" },
    });
  });

  it("requires Session cwd to be an existing directory", async () => {
    const file = join(sessionCwd, "not-a-directory.txt");
    await writeFile(file, "file\n");

    await expect(createSessionPathResolver(file)).resolves.toMatchObject({
      ok: false,
      error: { code: "EINVAL_PATH" },
    });
  });

  it("resolves a relative existing path against the stable Session cwd", async () => {
    await mkdir(join(sessionCwd, "src"));
    await writeFile(join(sessionCwd, "src", "index.ts"), "export {};\n");

    const result = await resolver.resolve("src//./nested/../index.ts", {
      existence: "required",
      symlinks: "follow",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        resolvedPath: join(sessionCwd, "src", "index.ts"),
        realTargetPath: join(resolver.canonicalSessionCwd, "src", "index.ts"),
        cwdRelation: "inside",
      },
    });
  });

  it("rejects empty, NUL, URL, and foreign-platform path syntax", async () => {
    const invalidPaths = process.platform === "win32"
      ? ["", "bad\0path", "https://example.com/a", "C:relative", "\\rooted", "\\\\?\\C:\\device", "//?/C:/device", "//./C:/device"]
      : ["", "bad\0path", "https://example.com/a", "C:\\foreign", "\\\\server\\share", "//?/C:/device", "//./C:/device"];

    for (const path of invalidPaths) {
      await expect(resolver.resolve(path, {
        existence: "required",
        symlinks: "follow",
      })).resolves.toMatchObject({
        ok: false,
        error: { code: "EINVAL_PATH" },
      });
    }
  });

  it("lets a Tool select follow, no-follow, or reject-final symlink behavior", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-path-outside-"));
    try {
      const target = join(outside, "target.txt");
      const entry = join(sessionCwd, "entry.txt");
      await writeFile(target, "outside\n");
      const canonicalTarget = await realpath(target);
      await symlink(target, entry, process.platform === "win32" ? "file" : undefined);
      await expect(resolver.resolve("entry.txt", {
        existence: "required",
        symlinks: "follow",
      })).resolves.toMatchObject({
        ok: true,
        value: { realTargetPath: canonicalTarget, cwdRelation: "outside" },
      });
      await expect(resolver.resolve("entry.txt", {
        existence: "required",
        symlinks: "no-follow",
      })).resolves.toEqual({
        ok: true,
        value: {
          resolvedPath: entry,
          realTargetPath: join(resolver.canonicalSessionCwd, "entry.txt"),
          cwdRelation: "inside",
        },
      });
      await expect(resolver.resolve("entry.txt", {
        existence: "required",
        symlinks: "reject-final",
      })).resolves.toMatchObject({
        ok: false,
        error: {
          code: "ESYMLINK",
          details: { resolvedPath: entry, cwdRelation: "inside" },
        },
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("canonicalizes the nearest existing ancestor for a creation target", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-create-outside-"));
    try {
      await symlink(outside, join(sessionCwd, "parent"), process.platform === "win32" ? "junction" : undefined);
      const result = await resolver.resolve("parent/new/deep/file.txt", {
        existence: "allow-missing",
        symlinks: "reject-final",
      });

      expect(result).toEqual({
        ok: true,
        value: {
          resolvedPath: join(sessionCwd, "parent", "new", "deep", "file.txt"),
          realTargetPath: join(await realpath(outside), "new", "deep", "file.txt"),
          cwdRelation: "outside",
        },
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("does not treat dangling symlinks as missing creation components", async () => {
    const dangling = join(sessionCwd, "missing-target");
    await symlink(dangling, join(sessionCwd, "dangling"), process.platform === "win32" ? "junction" : undefined);
    await expect(resolver.resolve("dangling", {
      existence: "allow-missing",
      symlinks: "reject-final",
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "ESYMLINK" },
    });
    await expect(resolver.resolve("dangling/child.txt", {
      existence: "allow-missing",
      symlinks: "reject-final",
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "ENOENT" },
    });
  });

  it("returns every reliably known path fact when a required target is missing", async () => {
    await expect(resolver.resolve("missing/deep/file.txt", {
      existence: "required",
      symlinks: "follow",
    })).resolves.toEqual({
      ok: false,
      error: {
        code: "ENOENT",
        message: "Path does not exist",
        details: {
          resolvedPath: join(sessionCwd, "missing", "deep", "file.txt"),
          realTargetPath: join(resolver.canonicalSessionCwd, "missing", "deep", "file.txt"),
          cwdRelation: "inside",
        },
      },
    });
  });

  it("does not classify a same-prefix sibling directory as inside cwd", async () => {
    const sibling = `${sessionCwd}-sibling`;
    await mkdir(sibling);
    try {
      const file = join(sibling, "file.txt");
      await writeFile(file, "outside\n");
      await expect(resolver.resolve(file, {
        existence: "required",
        symlinks: "follow",
      })).resolves.toMatchObject({
        ok: true,
        value: { cwdRelation: "outside" },
      });
    } finally {
      await rm(sibling, { force: true, recursive: true });
    }
  });

  it("maps a followed symlink loop to ELOOP", async () => {
    await symlink("second", join(sessionCwd, "first"), process.platform === "win32" ? "file" : undefined);
    await symlink("first", join(sessionCwd, "second"), process.platform === "win32" ? "file" : undefined);
    await expect(resolver.resolve("first", {
      existence: "required",
      symlinks: "follow",
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "ELOOP" },
    });
  });

  it("returns a path-classification snapshot across a later symlink change", async () => {
    const firstTarget = join(sessionCwd, "first.txt");
    const secondTarget = join(sessionCwd, "second.txt");
    const entry = join(sessionCwd, "current.txt");
    await writeFile(firstTarget, "first\n");
    await writeFile(secondTarget, "second\n");
    await symlink(firstTarget, entry, process.platform === "win32" ? "file" : undefined);
    const beforeChange = await resolver.resolve(entry, {
      existence: "required",
      symlinks: "follow",
    });
    await rm(entry);
    await symlink(secondTarget, entry, process.platform === "win32" ? "file" : undefined);
    const afterChange = await resolver.resolve(entry, {
      existence: "required",
      symlinks: "follow",
    });

    expect(beforeChange).toMatchObject({
      ok: true,
      value: { realTargetPath: await realpath(firstTarget) },
    });
    expect(afterChange).toMatchObject({
      ok: true,
      value: { realTargetPath: await realpath(secondTarget) },
    });
  });

  it.skipIf(process.platform === "win32")("maps inaccessible traversal to EACCES", async () => {
    const directory = join(sessionCwd, "private");
    await mkdir(directory);
    await writeFile(join(directory, "file.txt"), "private\n");
    await chmod(directory, 0o000);
    try {
      await expect(resolver.resolve("private/file.txt", {
        existence: "required",
        symlinks: "follow",
      })).resolves.toMatchObject({
        ok: false,
        error: { code: "EACCES" },
      });
    } finally {
      await chmod(directory, 0o700);
    }
  });
});
