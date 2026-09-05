import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { platform } from "node:process";

export type CwdRelation = "inside" | "outside";
export type PathExistence = "required" | "allow-missing";
export type PathSymlinkPolicy = "follow" | "no-follow" | "reject-final";

export type PathResolution = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
};

export type PathResolutionErrorCode =
  | "EINVAL_PATH"
  | "ENOENT"
  | "ELOOP"
  | "EACCES"
  | "EIO"
  | "ESYMLINK";

export type PathResolutionError = {
  readonly code: PathResolutionErrorCode;
  readonly message: string;
  readonly details?: Partial<PathResolution>;
};

export type PathResolutionResult<T = PathResolution> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PathResolutionError };

export type PathResolutionOptions = {
  readonly existence: PathExistence;
  readonly symlinks: PathSymlinkPolicy;
};

export type SessionPathResolver = {
  readonly sessionCwd: string;
  readonly canonicalSessionCwd: string;
  resolve(
    path: string,
    options: PathResolutionOptions,
  ): Promise<PathResolutionResult>;
};

function cwdRelation(
  canonicalSessionCwd: string,
  realTargetPath: string,
): CwdRelation {
  const fromCwd = relative(canonicalSessionCwd, realTargetPath);
  return fromCwd === "" ||
    (!isAbsolute(fromCwd) && fromCwd !== ".." && !fromCwd.startsWith(`..${sep}`))
    ? "inside"
    : "outside";
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function filesystemFailure(
  error: unknown,
  details?: Partial<PathResolution>,
): PathResolutionResult<never> {
  const platformCode = nodeErrorCode(error);
  const code: PathResolutionErrorCode =
    platformCode === "ENOENT"
      ? "ENOENT"
      : platformCode === "ELOOP"
        ? "ELOOP"
        : platformCode === "EINVAL" || platformCode === "ENOTDIR"
          ? "EINVAL_PATH"
          : platformCode === "EACCES" || platformCode === "EPERM"
            ? "EACCES"
            : "EIO";
  const messages: Record<PathResolutionErrorCode, string> = {
    EINVAL_PATH: "Path syntax is invalid",
    ENOENT: "Path does not exist",
    ELOOP: "Path contains a symlink loop",
    EACCES: "Path cannot be resolved",
    EIO: "Path resolution failed",
    ESYMLINK: "Final path component is a symlink",
  };
  return {
    ok: false,
    error: details === undefined
      ? { code, message: messages[code] }
      : { code, message: messages[code], details },
  };
}

async function canonicalizeMissingPath(resolvedPath: string): Promise<string> {
  const missingComponents: string[] = [];
  let candidate = resolvedPath;

  while (true) {
    try {
      await lstat(candidate);
    } catch (error) {
      if (nodeErrorCode(error) !== "ENOENT") {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      missingComponents.push(basename(candidate));
      candidate = parent;
      continue;
    }

    const canonicalAncestor = await realpath(candidate);
    return missingComponents.reduceRight(
      (path, component) => join(path, component),
      canonicalAncestor,
    );
  }
}

function invalidPathFailure(): PathResolutionResult<never> {
  return {
    ok: false,
    error: { code: "EINVAL_PATH", message: "Path syntax is invalid" },
  };
}

function hasValidHostPathSyntax(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    /^(?:[\\/]{2}[?.][\\/]|[\\/]\?\?[\\/])/.test(path)
  ) {
    return false;
  }

  if (platform === "win32") {
    if (
      /^[A-Za-z]:(?![\\/])/.test(path) ||
      /^[\\/](?![\\/])/.test(path)
    ) {
      return false;
    }
  } else if (/^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path)) {
    return false;
  }

  return platform === "win32" && /^[A-Za-z]:[\\/]/.test(path)
    ? true
    : !/^[A-Za-z][A-Za-z\d+.-]*:/.test(path);
}

export async function createSessionPathResolver(
  sessionCwd: string,
): Promise<PathResolutionResult<SessionPathResolver>> {
  if (!isAbsolute(sessionCwd) || !hasValidHostPathSyntax(sessionCwd)) {
    return invalidPathFailure();
  }
  const resolvedSessionCwd = resolve(sessionCwd);
  let canonicalSessionCwd: string;
  try {
    canonicalSessionCwd = await realpath(resolvedSessionCwd);
    if (!(await lstat(canonicalSessionCwd)).isDirectory()) {
      return invalidPathFailure();
    }
  } catch (error) {
    return filesystemFailure(error, { resolvedPath: resolvedSessionCwd });
  }

  return {
    ok: true,
    value: {
      sessionCwd: resolvedSessionCwd,
      canonicalSessionCwd,
      async resolve(path, options) {
        if (!hasValidHostPathSyntax(path)) {
          return invalidPathFailure();
        }
        const resolvedPath = resolve(resolvedSessionCwd, path);
        try {
          const entryStats = await lstat(resolvedPath);
          const finalIsSymlink = entryStats.isSymbolicLink();
          const realTargetPath = finalIsSymlink && options.symlinks !== "follow"
            ? join(await realpath(dirname(resolvedPath)), basename(resolvedPath))
            : await realpath(resolvedPath);
          const relation = cwdRelation(canonicalSessionCwd, realTargetPath);
          if (finalIsSymlink && options.symlinks === "reject-final") {
            return {
              ok: false,
              error: {
                code: "ESYMLINK",
                message: "Final path component is a symlink",
                details: {
                  resolvedPath,
                  realTargetPath,
                  cwdRelation: relation,
                },
              },
            };
          }
          return {
            ok: true,
            value: {
              resolvedPath,
              realTargetPath,
              cwdRelation: relation,
            },
          };
        } catch (error) {
          if (nodeErrorCode(error) === "ENOENT") {
            try {
              const realTargetPath = await canonicalizeMissingPath(resolvedPath);
              const details = {
                resolvedPath,
                realTargetPath,
                cwdRelation: cwdRelation(canonicalSessionCwd, realTargetPath),
              };
              return options.existence === "allow-missing"
                ? { ok: true, value: details }
                : filesystemFailure(error, details);
            } catch (ancestorError) {
              return filesystemFailure(ancestorError, { resolvedPath });
            }
          }
          return filesystemFailure(error, { resolvedPath });
        }
      },
    },
  };
}
