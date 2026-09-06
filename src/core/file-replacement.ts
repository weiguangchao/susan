import { randomBytes } from "node:crypto";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { platform as hostPlatform } from "node:process";
import type { Stats } from "node:fs";

export type FileReplacementIdentity = {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly nlink: number;
  readonly mode: number;
};

export type FileReplacementBaseline =
  | { readonly exists: false }
  | { readonly exists: true; readonly identity: FileReplacementIdentity };

export type FileReplacementSuccess = {
  readonly operation: "created" | "overwritten";
  readonly bytesWritten: number;
  readonly detachedHardLinks: boolean;
};

export type FileReplacementErrorCode =
  | "ECONFLICT"
  | "ENOENT"
  | "EACCES"
  | "EISDIR"
  | "EUNSUPPORTED"
  | "EIO"
  | "ETIMEDOUT"
  | "ETOOL";

export type FileReplacementError = {
  readonly code: FileReplacementErrorCode;
  readonly message: string;
  readonly details?: {
    readonly temporaryResidue?: boolean;
    readonly temporaryPath?: string;
  };
};

export type FileReplacementResult<T = FileReplacementSuccess> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: FileReplacementError };

export type FileReplacementHooks = {
  readonly afterFlush?: (temporaryPath: string) => Promise<void>;
  readonly afterReplace?: (targetPath: string) => Promise<void>;
  readonly afterUnlinkDestination?: (targetPath: string) => Promise<void>;
  readonly replace?: (temporaryPath: string, targetPath: string) => Promise<void>;
  readonly unlinkTemporary?: (temporaryPath: string) => Promise<void>;
};

export type FileReplacementOptions = {
  readonly targetPath: string;
  readonly contents: Uint8Array;
  readonly baseline: FileReplacementBaseline;
  readonly signal?: AbortSignal;
  readonly platform?: NodeJS.Platform;
  readonly hooks?: FileReplacementHooks;
};

const EXCLUSIVE_CREATE_ATTEMPTS = 16;

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function fileIdentity(stats: Stats): FileReplacementIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    nlink: stats.nlink,
    mode: stats.mode,
  };
}

function sameIdentity(
  left: FileReplacementIdentity,
  right: FileReplacementIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.nlink === right.nlink &&
    left.mode === right.mode
  );
}

function fail(
  code: FileReplacementErrorCode,
  message: string,
  details?: FileReplacementError["details"],
): Extract<FileReplacementResult<never>, { readonly ok: false }> {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function abortResult(
  signal: AbortSignal,
): Extract<FileReplacementResult<never>, { readonly ok: false }> {
  return isTimeoutReason(signal.reason)
    ? fail("ETIMEDOUT", "File replacement timed out.")
    : fail("ETOOL", "File replacement was cancelled.");
}

function mapIoError(
  error: unknown,
  message: string,
): Extract<FileReplacementResult<never>, { readonly ok: false }> {
  const code = nodeErrorCode(error);
  const mapped: FileReplacementErrorCode =
    code === "ENOENT"
      ? "ENOENT"
      : code === "EACCES" || code === "EPERM"
        ? "EACCES"
        : "EIO";
  return fail(mapped, message);
}

async function createExclusiveTemporary(directory: string): Promise<string> {
  for (let attempt = 0; attempt < EXCLUSIVE_CREATE_ATTEMPTS; attempt += 1) {
    const temporaryPath = join(
      directory,
      `.susan-${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      const handle = await open(temporaryPath, "wx", 0o666);
      await handle.close();
      return temporaryPath;
    } catch (error) {
      if (nodeErrorCode(error) === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
  throw Object.assign(new Error("Unable to create an exclusive temporary file."), {
    code: "EIO",
  });
}

async function recheckTargetBaseline(
  targetPath: string,
  baseline: FileReplacementBaseline,
): Promise<FileReplacementResult<void>> {
  try {
    const stats = await lstat(targetPath);
    if (!baseline.exists) {
      return fail("ECONFLICT", "Target changed before commit.");
    }
    if (!stats.isFile() || !sameIdentity(baseline.identity, fileIdentity(stats))) {
      return fail("ECONFLICT", "Target changed before commit.");
    }
    return { ok: true, value: undefined };
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return baseline.exists
        ? fail("ECONFLICT", "Target changed before commit.")
        : { ok: true, value: undefined };
    }
    throw error;
  }
}

async function cleanupTemporary(
  temporaryPath: string,
  result: Extract<FileReplacementResult<never>, { readonly ok: false }>,
  unlinkTemporary: (path: string) => Promise<void> = unlink,
): Promise<FileReplacementResult<never>> {
  try {
    await unlinkTemporary(temporaryPath);
    return result;
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return result;
    }
    return fail(result.error.code, result.error.message, {
      ...result.error.details,
      temporaryResidue: true,
      temporaryPath,
    });
  }
}

async function replacePath(
  temporaryPath: string,
  targetPath: string,
  platform: NodeJS.Platform,
  hooks: FileReplacementHooks | undefined,
): Promise<void> {
  if (hooks?.replace !== undefined) {
    await hooks.replace(temporaryPath, targetPath);
    return;
  }
  if (platform !== "win32") {
    await rename(temporaryPath, targetPath);
    return;
  }
  let destinationExists = false;
  try {
    await lstat(targetPath);
    destinationExists = true;
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  if (destinationExists) {
    await unlink(targetPath);
    await hooks?.afterUnlinkDestination?.(targetPath);
  }
  await rename(temporaryPath, targetPath);
}

export async function observeReplacementTarget(
  targetPath: string,
): Promise<FileReplacementResult<FileReplacementBaseline>> {
  try {
    const stats = await lstat(targetPath);
    if (stats.isDirectory()) {
      return fail("EISDIR", "Path is a directory.");
    }
    if (!stats.isFile()) {
      return fail("EUNSUPPORTED", "Path is not a regular file.");
    }
    return {
      ok: true,
      value: { exists: true, identity: fileIdentity(stats) },
    };
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ENOENT") {
      return { ok: true, value: { exists: false } };
    }
    return mapIoError(error, "Target cannot be observed.");
  }
}

export async function replaceFile(
  options: FileReplacementOptions,
): Promise<FileReplacementResult> {
  if (options.signal?.aborted) {
    return abortResult(options.signal);
  }
  let temporaryPath: string;
  try {
    temporaryPath = await createExclusiveTemporary(dirname(options.targetPath));
  } catch (error) {
    return mapIoError(error, "File replacement failed.");
  }
  try {
    const handle = await open(temporaryPath, "r+");
    try {
      await handle.writeFile(options.contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.baseline.exists) {
      await chmod(temporaryPath, options.baseline.identity.mode & 0o777);
    }
    await options.hooks?.afterFlush?.(temporaryPath);
    if (options.signal?.aborted) {
      return await cleanupTemporary(
        temporaryPath,
        abortResult(options.signal),
        options.hooks?.unlinkTemporary,
      );
    }
    const review = await recheckTargetBaseline(options.targetPath, options.baseline);
    if (!review.ok) {
      return await cleanupTemporary(
        temporaryPath,
        review,
        options.hooks?.unlinkTemporary,
      );
    }
    if (options.signal?.aborted) {
      return await cleanupTemporary(
        temporaryPath,
        abortResult(options.signal),
        options.hooks?.unlinkTemporary,
      );
    }
    await replacePath(
      temporaryPath,
      options.targetPath,
      options.platform ?? hostPlatform,
      options.hooks,
    );
  } catch (error) {
    return await cleanupTemporary(
      temporaryPath,
      mapIoError(error, "File replacement failed."),
      options.hooks?.unlinkTemporary,
    );
  }
  try {
    await options.hooks?.afterReplace?.(options.targetPath);
  } catch {}
  return {
    ok: true,
    value: {
      operation: options.baseline.exists ? "overwritten" : "created",
      bytesWritten: options.contents.byteLength,
      detachedHardLinks:
        options.baseline.exists && options.baseline.identity.nlink > 1,
    },
  };
}
