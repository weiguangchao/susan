import { isRecord, type JsonObject } from "./json.js";
import {
  createSessionPathResolver,
  type CwdRelation,
  type PathResolution,
  type PathResolutionError,
} from "./path-resolver.js";
import { type ToolResult } from "./tool-result.js";
import {
  TRAVERSAL_DEFAULT_TIMEOUT_MS,
  traverse,
  type TraversalDiagnostic,
  type TraversalEntry,
  type TraversalError,
} from "./traverse.js";

export const LS_DEFAULT_LIMIT = 500;
export const LS_MAX_LIMIT = 5_000;
export const LS_DEFAULT_TIMEOUT_MS = TRAVERSAL_DEFAULT_TIMEOUT_MS;

const LS_DESCRIPTION =
  "List a directory's direct children without recursion. Use ls to inspect a known directory and find for deeper path discovery. It returns deterministically ordered file, directory, and symlink entries, applies ignore rules unless requested otherwise, and does not follow symlinks. Results may include Traversal Diagnostics.";

const ALLOWED_FIELDS = new Set(["path", "includeIgnored", "limit", "offset"]);

export type LsToolOptions = {
  readonly sessionCwd: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

export type LsEntry = {
  readonly name: string;
  readonly type: TraversalEntry["type"];
};

export type LsToolDetails = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
  readonly entries: readonly LsEntry[];
  readonly diagnostics: readonly TraversalDiagnostic[];
  readonly truncation?: {
    readonly truncatedBy: "items";
    readonly outputItems: number;
    readonly nextOffset: number;
    readonly includeIgnored?: true;
  };
};

export type LsTool = {
  readonly name: "ls";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult<LsToolDetails>>;
};

type ValidatedArguments = {
  readonly path: string;
  readonly includeIgnored: boolean;
  readonly limit: number;
  readonly offset: number;
};

type PathFacts = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
};

function fail(message: string): never {
  throw new Error(message);
}

function invalid(_field: string): never {
  fail("Invalid ls arguments.");
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function validateArguments(input: unknown): ValidatedArguments {
  if (!isRecord(input)) {
    invalid("path");
  }
  const extra = Object.keys(input).find((key) => !ALLOWED_FIELDS.has(key));
  if (extra !== undefined) {
    invalid(extra);
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    invalid("path");
  }
  if (input.includeIgnored !== undefined && typeof input.includeIgnored !== "boolean") {
    invalid("includeIgnored");
  }
  if (input.limit !== undefined && !isSafeInteger(input.limit)) {
    invalid("limit");
  }
  if (input.offset !== undefined && !isSafeInteger(input.offset)) {
    invalid("offset");
  }
  if (
    input.limit !== undefined &&
    (input.limit < 1 || input.limit > LS_MAX_LIMIT)
  ) {
    fail(`limit must be an integer between 1 and ${LS_MAX_LIMIT}.`);
  }
  if (input.offset !== undefined && input.offset < 0) {
    fail("offset must be a non-negative integer.");
  }
  return {
    path: input.path ?? ".",
    includeIgnored: input.includeIgnored === true,
    limit: input.limit ?? LS_DEFAULT_LIMIT,
    offset: input.offset ?? 0,
  };
}

function pathFacts(resolution: PathResolution): PathFacts {
  return {
    resolvedPath: resolution.resolvedPath,
    realTargetPath: resolution.realTargetPath,
    cwdRelation: resolution.cwdRelation,
  };
}

function mapPathError(error: PathResolutionError): never {
  if (error.code === "ESYMLINK") {
    fail("Path cannot be resolved.");
  }
  const messages: Record<Exclude<PathResolutionError["code"], "ESYMLINK">, string> = {
    EINVAL_PATH: "Path syntax is invalid.",
    ENOENT: "Path does not exist.",
    ELOOP: "Path contains a symlink loop.",
    EACCES: "Path cannot be read.",
    EIO: "Path cannot be resolved.",
  };
  fail(messages[error.code]);
}

function mapTraversalError(error: TraversalError): never {
  if (error.code === "ENOTDIR") {
    fail("Path is not a directory.");
  }
  if (error.code === "ENOENT") {
    fail("Path does not exist.");
  }
  if (error.code === "EACCES") {
    fail("Path cannot be read.");
  }
  if (error.code === "ELOOP") {
    fail("Path contains a symlink loop.");
  }
  if (error.code === "EQUERY_TOO_LARGE") {
    fail("Query exceeded the entry budget.");
  }
  if (error.code === "ETIMEDOUT") {
    fail("Ls timed out.");
  }
  fail("Path cannot be listed.");
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function abortResult(signal: AbortSignal): never {
  if (isTimeoutReason(signal.reason)) {
    fail("Ls timed out.");
  }
  fail("Tool execution failed.");
}

function toLsEntry(entry: TraversalEntry): LsEntry {
  return { name: entry.path, type: entry.type };
}

function formatLsEntry(entry: LsEntry): string {
  if (entry.type === "directory") {
    return `${entry.name}/`;
  }
  if (entry.type === "symlink") {
    return `${entry.name}@`;
  }
  return entry.name;
}

function formatLsContent(
  entries: readonly LsEntry[],
  remaining: number,
  nextOffset: number,
): string {
  const listing = entries.map(formatLsEntry).join("\n");
  if (remaining <= 0) {
    return listing;
  }
  const note = `[${remaining} more entries. Use offset=${nextOffset} to continue.]`;
  if (listing === "") {
    return note;
  }
  return `${listing}\n\n${note}`;
}

export async function executeLs(
  input: unknown,
  options: LsToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult<LsToolDetails>> {
  const validated = validateArguments(input);

  const timeoutMs = options.timeoutMs ?? LS_DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([timeout, options.signal]);
  if (signal.aborted) {
    abortResult(signal);
  }

  const resolverResult = await createSessionPathResolver(options.sessionCwd);
  if (signal.aborted) {
    abortResult(signal);
  }
  if (!resolverResult.ok) {
    mapPathError(resolverResult.error);
  }

  const resolved = await resolverResult.value.resolve(validated.path, {
    existence: "required",
    symlinks: "follow",
  });
  if (signal.aborted) {
    abortResult(signal);
  }
  if (!resolved.ok) {
    mapPathError(resolved.error);
  }

  const facts = pathFacts(resolved.value);
  const walked = await traverse({
    searchRoot: facts.realTargetPath,
    maxDepth: 1,
    includeIgnored: validated.includeIgnored,
    timeoutMs,
    signal,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!walked.ok) {
    if (signal.aborted) {
      abortResult(signal);
    }
    mapTraversalError(walked.error);
  }

  const remaining = walked.value.entries.slice(validated.offset).map(toLsEntry);
  const paged = remaining.slice(0, validated.limit);
  const omitted = remaining.length - paged.length;
  const nextOffset = validated.offset + paged.length;
  const details: LsToolDetails = {
    ...facts,
    entries: paged,
    diagnostics: walked.value.diagnostics,
    ...(omitted > 0
      ? {
          truncation: {
            truncatedBy: "items" as const,
            outputItems: paged.length,
            nextOffset,
            ...(validated.includeIgnored ? { includeIgnored: true as const } : {}),
          },
        }
      : {}),
  };
  return {
    content: [{ type: "text", text: formatLsContent(paged, omitted, nextOffset) }],
    details,
  };
}

export function createLsTool(options: LsToolOptions): LsTool {
  return {
    name: "ls",
    description: LS_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description:
            "Absolute or Session-cwd-relative directory path; defaults to .",
        },
        includeIgnored: {
          type: "boolean",
          description:
            "When true, do not apply the target directory .gitignore or the built-in .git/ ignore; defaults to false",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "Number of sorted entries to skip; defaults to 0",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: LS_MAX_LIMIT,
          description: `Maximum number of entries to return; defaults to ${LS_DEFAULT_LIMIT}`,
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
