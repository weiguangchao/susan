import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathExists, resolveToCwd } from "../path-utils";
import { type ToolResult } from "../tool-result";
import { ensureTool } from "../tools-manager";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "../truncate";

export const DEFAULT_LIMIT = 1000;

/** Relativize a find result against the search root and normalize it to posix separators. */
export function relativizeFindResultPath(
  resultPath: string,
  searchPath: string,
  pathModule: path.PlatformPath = path,
): string {
  const hadTrailingSeparator =
    resultPath.endsWith(pathModule.sep) ||
    (pathModule.sep === "\\" && resultPath.endsWith("/"));
  const relativePath = pathModule.isAbsolute(resultPath)
    ? pathModule.relative(searchPath, resultPath)
    : resultPath;
  const posixPath = relativePath.split(pathModule.sep).join("/");
  return hadTrailingSeparator && !posixPath.endsWith("/")
    ? `${posixPath}/`
    : posixPath;
}

export type FindToolDetails = {
  readonly truncation?: TruncationResult;
  readonly resultLimitReached?: number;
};

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export type FindOperations = {
  /** Check if path exists */
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  /** Find files matching glob pattern. Returns relative or absolute paths. */
  glob: (
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ) => Promise<string[]> | string[];
};

const defaultFindOperations: FindOperations = {
  exists: pathExists,
  // This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
  glob: () => [],
};

export type FindToolOptions = {
  readonly sessionCwd: string;
  readonly operations?: FindOperations;
};

export type FindValidatedArguments = {
  readonly pattern: string;
  readonly path?: string;
  readonly limit?: number;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

function formatFindOutput(
  relativized: readonly string[],
  effectiveLimit: number,
  resultLimitNotice: string,
): ToolResult<FindToolDetails | undefined> {
  if (relativized.length === 0) {
    return {
      content: [{ type: "text", text: "No files found matching pattern" }],
      details: undefined,
    };
  }

  const resultLimitReached = relativized.length >= effectiveLimit;
  const rawOutput = relativized.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let resultOutput = truncation.content;
  const details: {
    truncation?: TruncationResult;
    resultLimitReached?: number;
  } = {};
  const notices: string[] = [];
  if (resultLimitReached) {
    notices.push(resultLimitNotice);
    details.resultLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (notices.length > 0) {
    resultOutput += `\n\n[${notices.join(". ")}]`;
  }
  return {
    content: [{ type: "text", text: resultOutput }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

export async function executeFind(
  input: FindValidatedArguments,
  options: FindToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult<FindToolDetails | undefined>> {
  const { pattern, path: searchDir, limit } = input;
  const signal = options.signal;
  throwIfAborted(signal);

  const searchPath = resolveToCwd(searchDir || ".", options.sessionCwd);
  const effectiveLimit = limit ?? DEFAULT_LIMIT;
  const customOps = options.operations;
  const ops = customOps ?? defaultFindOperations;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }

    let settled = false;
    let stopChild: (() => void) | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      stopChild = undefined;
      fn();
    };
    const onAbort = () => {
      stopChild?.();
      settle(() => reject(new Error("Operation aborted")));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    void (async () => {
      try {
        // If custom operations provide glob(), use that instead of fd.
        if (customOps?.glob) {
          if (!(await ops.exists(searchPath))) {
            settle(() => reject(new Error(`Path not found: ${searchPath}`)));
            return;
          }
          if (signal?.aborted) {
            settle(() => reject(new Error("Operation aborted")));
            return;
          }
          const results = await ops.glob(pattern, searchPath, {
            ignore: ["**/node_modules/**", "**/.git/**"],
            limit: effectiveLimit,
          });
          if (signal?.aborted) {
            settle(() => reject(new Error("Operation aborted")));
            return;
          }
          const relativized = results.map((resultPath) =>
            relativizeFindResultPath(resultPath, searchPath),
          );
          settle(() =>
            resolve(
              formatFindOutput(
                relativized,
                effectiveLimit,
                `${effectiveLimit} results limit reached`,
              ),
            ),
          );
          return;
        }

        const fdPath = await ensureTool("fd");
        if (signal?.aborted) {
          settle(() => reject(new Error("Operation aborted")));
          return;
        }
        if (!fdPath) {
          settle(() =>
            reject(new Error("fd is not available and could not be downloaded")),
          );
          return;
        }

        const args: string[] = ["--glob", "--color=never", "--hidden"];

        // fd normally ignores .gitignore outside git repos, so keep --no-require-git
        // there. Inside repos, use fd's default git-aware behavior so parent
        // .gitignore rules stop at nested repo boundaries:
        // https://github.com/earendil-works/pi/issues/5960
        let insideGitRepo = false;
        for (let current = searchPath; ; ) {
          if (await pathExists(path.join(current, ".git"))) {
            insideGitRepo = true;
            break;
          }
          const parent = path.dirname(current);
          if (parent === current) break;
          current = parent;
        }
        if (!insideGitRepo) args.push("--no-require-git");
        args.push("--max-results", String(effectiveLimit));

        // fd --glob matches against the basename unless --full-path is set; in --full-path
        // mode it matches against the absolute candidate path, so a path-containing
        // pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
        let effectivePattern = pattern;
        if (pattern.includes("/")) {
          args.push("--full-path");
          if (
            !pattern.startsWith("/") &&
            !pattern.startsWith("**/") &&
            pattern !== "**"
          ) {
            effectivePattern = `**/${pattern}`;
          }
          // fd matches full paths using native separators on Windows.
          if (process.platform === "win32") {
            effectivePattern = effectivePattern.replaceAll("/", String.raw`[/\\]`);
          }
        }
        args.push("--", effectivePattern, searchPath);

        const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
        const rl = createInterface({ input: child.stdout });
        let stderr = "";
        const lines: string[] = [];

        stopChild = () => {
          if (!child.killed) {
            child.kill();
          }
        };

        const cleanup = () => {
          rl.close();
        };

        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        rl.on("line", (line) => {
          lines.push(line);
        });

        child.on("error", (error) => {
          cleanup();
          settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
        });

        child.on("close", (code) => {
          cleanup();
          if (signal?.aborted) {
            settle(() => reject(new Error("Operation aborted")));
            return;
          }
          const output = lines.join("\n");
          if (code !== 0) {
            const errorMsg = stderr.trim() || `fd exited with code ${code}`;
            if (!output) {
              settle(() => reject(new Error(errorMsg)));
              return;
            }
          }
          if (!output) {
            settle(() =>
              resolve({
                content: [
                  { type: "text", text: "No files found matching pattern" },
                ],
                details: undefined,
              }),
            );
            return;
          }

          const relativized: string[] = [];
          for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, "").trim();
            if (!line) continue;
            relativized.push(relativizeFindResultPath(line, searchPath));
          }

          settle(() =>
            resolve(
              formatFindOutput(
                relativized,
                effectiveLimit,
                `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
              ),
            ),
          );
        });
      } catch (error) {
        if (signal?.aborted) {
          settle(() => reject(new Error("Operation aborted")));
          return;
        }
        settle(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
      }
    })();
  });
}
