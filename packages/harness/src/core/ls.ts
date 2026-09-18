import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, type JsonObject } from "@weiguangchao/susan-core";
import { pathExists, resolveToCwd } from "./path-utils";
import { type ToolResult } from "./tool-result";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  type TruncationResult,
  truncateHead,
} from "./truncate";

export const LS_PROMPT_SNIPPET = "List directory contents";
export const LS_PROMPT_GUIDELINES = [] as const;

const DEFAULT_LIMIT = 500;

const LS_DESCRIPTION =
  `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`;

export type LsToolDetails = {
  readonly truncation?: TruncationResult;
  readonly entryLimitReached?: number;
};

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export type LsOperations = {
  exists: (absolutePath: string) => Promise<boolean> | boolean;
  stat: (
    absolutePath: string,
  ) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
  readdir: (absolutePath: string) => Promise<string[]> | string[];
};

const defaultLsOperations: LsOperations = {
  exists: pathExists,
  stat: fsStat,
  readdir: fsReaddir,
};

export type LsToolOptions = {
  readonly sessionCwd: string;
  readonly operations?: LsOperations;
};

export type LsTool = {
  readonly name: "ls";
  readonly description: string;
  readonly parameters: JsonObject;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  execute(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResult<LsToolDetails | undefined>>;
};

type ValidatedArguments = {
  readonly path?: string;
  readonly limit?: number;
};

function validateArguments(input: unknown): ValidatedArguments {
  if (!isRecord(input)) {
    throw new Error("Invalid ls arguments.");
  }
  const extra = Object.keys(input).find(
    (key) => key !== "path" && key !== "limit",
  );
  if (extra !== undefined) {
    throw new Error("Invalid ls arguments.");
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    throw new Error("Invalid ls arguments.");
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isFinite(input.limit)) {
      throw new Error("Invalid ls arguments.");
    }
  }
  return {
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

export async function executeLs(
  input: unknown,
  options: LsToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult<LsToolDetails | undefined>> {
  const { path, limit } = validateArguments(input);
  const signal = options.signal;
  const ops = options.operations ?? defaultLsOperations;
  throwIfAborted(signal);

  const dirPath = resolveToCwd(path || ".", options.sessionCwd);
  const effectiveLimit = limit ?? DEFAULT_LIMIT;

  if (!(await ops.exists(dirPath))) {
    throwIfAborted(signal);
    throw new Error(`Path not found: ${dirPath}`);
  }
  throwIfAborted(signal);

  const stat = await ops.stat(dirPath);
  throwIfAborted(signal);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }

  let entries: string[];
  try {
    entries = await ops.readdir(dirPath);
  } catch (error) {
    throwIfAborted(signal);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read directory: ${message}`);
  }
  throwIfAborted(signal);

  entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const results: string[] = [];
  let entryLimitReached = false;
  for (const entry of entries) {
    if (results.length >= effectiveLimit) {
      entryLimitReached = true;
      break;
    }

    const fullPath = join(dirPath, entry);
    let suffix = "";
    try {
      const entryStat = await ops.stat(fullPath);
      if (entryStat.isDirectory()) {
        suffix = "/";
      }
    } catch {
      continue;
    }
    throwIfAborted(signal);
    results.push(entry + suffix);
  }

  if (results.length === 0) {
    return {
      content: [{ type: "text", text: "(empty directory)" }],
      details: undefined,
    };
  }

  const rawOutput = results.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const notices: string[] = [];
  if (entryLimitReached) {
    notices.push(
      `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`,
    );
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (notices.length > 0) {
    output += `\n\n[${notices.join(". ")}]`;
  }

  const details: LsToolDetails | undefined =
    entryLimitReached || truncation.truncated
      ? {
          ...(entryLimitReached ? { entryLimitReached: effectiveLimit } : {}),
          ...(truncation.truncated ? { truncation } : {}),
        }
      : undefined;

  return {
    content: [{ type: "text", text: output }],
    details,
  };
}

export function createLsTool(options: LsToolOptions): LsTool {
  return {
    name: "ls",
    description: LS_DESCRIPTION,
    promptSnippet: LS_PROMPT_SNIPPET,
    promptGuidelines: [...LS_PROMPT_GUIDELINES],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Directory to list (default: current directory)",
        },
        limit: {
          type: "number",
          description: "Maximum number of entries to return (default: 500)",
        },
      },
    },
    execute(input, signal) {
      return executeLs(input, {
        ...options,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
