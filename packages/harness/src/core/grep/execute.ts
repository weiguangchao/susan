import { spawn } from "node:child_process";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { basename, relative as pathRelative } from "node:path";
import { createInterface } from "node:readline";
import { resolveToCwd } from "../path-utils";
import { type ToolResult } from "../tool-result";
import { ensureTool } from "../tools-manager";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  type TruncationResult,
  truncateHead,
  truncateLine,
} from "../truncate";

export const DEFAULT_LIMIT = 100;

export type GrepToolDetails = {
  readonly truncation?: TruncationResult;
  readonly matchLimitReached?: number;
  readonly linesTruncated?: boolean;
};

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export type GrepOperations = {
  /** Check if path is a directory. Throws if path does not exist. */
  isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
  /** Read file contents for context lines */
  readFile: (absolutePath: string) => Promise<string> | string;
};

const defaultGrepOperations: GrepOperations = {
  isDirectory: async (absolutePath) => (await fsStat(absolutePath)).isDirectory(),
  readFile: (absolutePath) => fsReadFile(absolutePath, "utf-8"),
};

export type GrepToolOptions = {
  readonly sessionCwd: string;
  readonly operations?: GrepOperations;
};

export type GrepValidatedArguments = {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly ignoreCase?: boolean;
  readonly literal?: boolean;
  readonly context?: number;
  readonly limit?: number;
};

type RgMatchEvent = {
  readonly type?: unknown;
  readonly data?: {
    readonly path?: { readonly text?: unknown };
    readonly line_number?: unknown;
    readonly lines?: { readonly text?: unknown };
  };
};

type CollectedMatch = {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly lineText?: string;
};

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

export async function executeGrep(
  input: GrepValidatedArguments,
  options: GrepToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult<GrepToolDetails | undefined>> {
  const {
    pattern,
    path: searchDir,
    glob,
    ignoreCase,
    literal,
    context,
    limit,
  } = input;
  const signal = options.signal;
  throwIfAborted(signal);

  const rgPath = await ensureTool("rg");
  throwIfAborted(signal);
  if (!rgPath) {
    throw new Error("ripgrep (rg) is not available and could not be downloaded");
  }

  const searchPath = resolveToCwd(searchDir || ".", options.sessionCwd);
  const ops = options.operations ?? defaultGrepOperations;
  let isDirectory: boolean;
  try {
    isDirectory = await ops.isDirectory(searchPath);
  } catch {
    throw new Error(`Path not found: ${searchPath}`);
  }
  throwIfAborted(signal);

  const contextValue = context && context > 0 ? context : 0;
  const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
  const formatPath = (filePath: string): string => {
    if (isDirectory) {
      const relative = pathRelative(searchPath, filePath);
      if (relative && !relative.startsWith("..")) {
        return relative.replace(/\\/g, "/");
      }
    }
    return basename(filePath);
  };

  const fileCache = new Map<string, string[]>();
  const getFileLines = async (filePath: string): Promise<string[]> => {
    let lines = fileCache.get(filePath);
    if (!lines) {
      try {
        const content = await ops.readFile(filePath);
        lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      } catch {
        lines = [];
      }
      fileCache.set(filePath, lines);
    }
    return lines;
  };

  const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
  if (ignoreCase) args.push("--ignore-case");
  if (literal) args.push("--fixed-strings");
  if (glob) args.push("--glob", glob);
  args.push("--", pattern, searchPath);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const rl = createInterface({ input: child.stdout });
    let stderr = "";
    let matchCount = 0;
    let matchLimitReached = false;
    let linesTruncated = false;
    let aborted = false;
    let killedDueToLimit = false;
    const outputLines: string[] = [];
    const matches: CollectedMatch[] = [];

    const cleanup = () => {
      rl.close();
      signal?.removeEventListener("abort", onAbort);
    };
    const stopChild = (dueToLimit = false) => {
      if (!child.killed) {
        killedDueToLimit = dueToLimit;
        child.kill();
      }
    };
    const onAbort = () => {
      aborted = true;
      stopChild();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const formatBlock = async (
      filePath: string,
      lineNumber: number,
    ): Promise<string[]> => {
      const relativePath = formatPath(filePath);
      const lines = await getFileLines(filePath);
      if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
      const block: string[] = [];
      const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
      const end =
        contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
      for (let current = start; current <= end; current += 1) {
        const lineText = lines[current - 1] ?? "";
        const sanitized = lineText.replace(/\r/g, "");
        const isMatchLine = current === lineNumber;
        const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
        if (wasTruncated) linesTruncated = true;
        if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
        else block.push(`${relativePath}-${current}- ${truncatedText}`);
      }
      return block;
    };

    rl.on("line", (line) => {
      if (!line.trim() || matchCount >= effectiveLimit) return;
      let event: RgMatchEvent;
      try {
        event = JSON.parse(line) as RgMatchEvent;
      } catch {
        return;
      }
      if (event.type === "match") {
        matchCount += 1;
        const filePath = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        const lineText = event.data?.lines?.text;
        if (typeof filePath === "string" && typeof lineNumber === "number") {
          matches.push({
            filePath,
            lineNumber,
            ...(typeof lineText === "string" ? { lineText } : {}),
          });
        }
        if (matchCount >= effectiveLimit) {
          matchLimitReached = true;
          stopChild(true);
        }
      }
    });

    child.on("error", (error) => {
      cleanup();
      settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
    });
    child.on("close", async (code) => {
      cleanup();
      if (aborted) {
        settle(() => reject(new Error("Operation aborted")));
        return;
      }
      if (!killedDueToLimit && code !== 0 && code !== 1) {
        const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
        settle(() => reject(new Error(errorMsg)));
        return;
      }
      if (matchCount === 0) {
        settle(() =>
          resolve({
            content: [{ type: "text", text: "No matches found" }],
            details: undefined,
          }),
        );
        return;
      }

      try {
        for (const match of matches) {
          if (contextValue === 0 && match.lineText !== undefined) {
            const relativePath = formatPath(match.filePath);
            const sanitized = match.lineText
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "")
              .replace(/\n$/, "");
            const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
            if (wasTruncated) linesTruncated = true;
            outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
          } else {
            const block = await formatBlock(match.filePath, match.lineNumber);
            outputLines.push(...block);
          }
        }

        const rawOutput = outputLines.join("\n");
        const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
        let output = truncation.content;
        const details: {
          truncation?: TruncationResult;
          matchLimitReached?: number;
          linesTruncated?: boolean;
        } = {};
        const notices: string[] = [];
        if (matchLimitReached) {
          notices.push(
            `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
          );
          details.matchLimitReached = effectiveLimit;
        }
        if (truncation.truncated) {
          notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
          details.truncation = truncation;
        }
        if (linesTruncated) {
          notices.push(
            `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
          );
          details.linesTruncated = true;
        }
        if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
        settle(() =>
          resolve({
            content: [{ type: "text", text: output }],
            details: Object.keys(details).length > 0 ? details : undefined,
          }),
        );
      } catch (error) {
        settle(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
      }
    });
  });
}
