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
  TRAVERSAL_MAX_DEPTH,
  compileGlob,
  traverse,
  type TraversalDiagnostic,
  type TraversalEntry,
  type TraversalError,
} from "./traverse.js";

export const FIND_DEFAULT_LIMIT = 1_000;
export const FIND_MAX_LIMIT = 10_000;
export const FIND_DEFAULT_TIMEOUT_MS = TRAVERSAL_DEFAULT_TIMEOUT_MS;

const FIND_DESCRIPTION =
  "Find descendant path names beneath a directory using a platform-independent glob. Use find instead of bash or a host find command when locating files, directories, or symlinks by name or relative path; use grep when searching file contents. It supports type, depth, ignore controls, and deterministic pagination. It does not match the Search Root itself or traverse through symlinks, and results may include Traversal Diagnostics.";

const ALLOWED_FIELDS = new Set([
  "pattern",
  "path",
  "type",
  "maxDepth",
  "includeIgnored",
  "limit",
  "offset",
]);

const FIND_TYPES = ["file", "directory", "symlink", "all"] as const;

export type FindEntryType = (typeof FIND_TYPES)[number];

export type FindToolOptions = {
  readonly sessionCwd: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

export type FindToolDetails = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
  readonly entries: readonly TraversalEntry[];
  readonly diagnostics: readonly TraversalDiagnostic[];
  readonly truncation?: {
    readonly truncatedBy: "items";
    readonly outputItems: number;
    readonly nextOffset: number;
    readonly type?: Exclude<FindEntryType, "all">;
    readonly maxDepth?: number;
    readonly includeIgnored?: true;
  };
};

export type FindTool = {
  readonly name: "find";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult<FindToolDetails>>;
};

type ValidatedArguments = {
  readonly pattern: string;
  readonly path: string;
  readonly type: FindEntryType;
  readonly maxDepth: number | undefined;
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
  fail("Invalid find arguments.");
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isFindEntryType(value: unknown): value is FindEntryType {
  return FIND_TYPES.includes(value as FindEntryType);
}

function validateArguments(input: unknown): ValidatedArguments {
  if (!isRecord(input)) {
    invalid("pattern");
  }
  const extra = Object.keys(input).find((key) => !ALLOWED_FIELDS.has(key));
  if (extra !== undefined) {
    invalid(extra);
  }
  if (typeof input.pattern !== "string") {
    invalid("pattern");
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    invalid("path");
  }
  if (input.type !== undefined && typeof input.type !== "string") {
    invalid("type");
  }
  if (
    input.includeIgnored !== undefined &&
    typeof input.includeIgnored !== "boolean"
  ) {
    invalid("includeIgnored");
  }
  if (input.maxDepth !== undefined && !isSafeInteger(input.maxDepth)) {
    invalid("maxDepth");
  }
  if (input.limit !== undefined && !isSafeInteger(input.limit)) {
    invalid("limit");
  }
  if (input.offset !== undefined && !isSafeInteger(input.offset)) {
    invalid("offset");
  }
  if (!compileGlob(input.pattern).ok) {
    fail("pattern must be a valid glob.");
  }
  if (input.type !== undefined && !isFindEntryType(input.type)) {
    fail(`type must be one of ${FIND_TYPES.join(", ")}.`);
  }
  if (
    input.limit !== undefined &&
    (input.limit < 1 || input.limit > FIND_MAX_LIMIT)
  ) {
    fail(`limit must be an integer between 1 and ${FIND_MAX_LIMIT}.`);
  }
  if (input.offset !== undefined && input.offset < 0) {
    fail("offset must be a non-negative integer.");
  }
  if (
    input.maxDepth !== undefined &&
    (input.maxDepth < 1 || input.maxDepth > TRAVERSAL_MAX_DEPTH)
  ) {
    fail(`maxDepth must be an integer between 1 and ${TRAVERSAL_MAX_DEPTH}.`);
  }
  return {
    pattern: input.pattern,
    path: input.path ?? ".",
    type: isFindEntryType(input.type) ? input.type : "all",
    maxDepth: input.maxDepth,
    includeIgnored: input.includeIgnored === true,
    limit: input.limit ?? FIND_DEFAULT_LIMIT,
    offset: input.offset ?? 0,
  };
}

function matchesType(entry: TraversalEntry, type: FindEntryType): boolean {
  return type === "all" || entry.type === type;
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
    fail("Find timed out.");
  }
  fail("Search Root cannot be traversed.");
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function abortResult(signal: AbortSignal): never {
  if (isTimeoutReason(signal.reason)) {
    fail("Find timed out.");
  }
  fail("Tool execution failed.");
}

function formatFindEntry(entry: TraversalEntry): string {
  if (entry.type === "directory") {
    return `${entry.path}/`;
  }
  if (entry.type === "symlink") {
    return `${entry.path}@`;
  }
  return entry.path;
}

function formatFindContent(
  entries: readonly TraversalEntry[],
  remaining: number,
  nextOffset: number,
): string {
  const listing = entries.map(formatFindEntry).join("\n");
  if (remaining <= 0) {
    return listing;
  }
  const note = `[${remaining} more entries. Use offset=${nextOffset} to continue.]`;
  if (listing === "") {
    return note;
  }
  return `${listing}\n\n${note}`;
}

export async function executeFind(
  input: unknown,
  options: FindToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult<FindToolDetails>> {
  const validated = validateArguments(input);

  const timeoutMs = options.timeoutMs ?? FIND_DEFAULT_TIMEOUT_MS;
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
    glob: validated.pattern,
    ...(validated.maxDepth === undefined
      ? {}
      : { maxDepth: validated.maxDepth }),
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

  const remaining = walked.value.entries
    .filter((entry) => matchesType(entry, validated.type))
    .slice(validated.offset);
  const paged = remaining.slice(0, validated.limit);
  const omitted = remaining.length - paged.length;
  const nextOffset = validated.offset + paged.length;
  const details: FindToolDetails = {
    ...facts,
    entries: paged,
    diagnostics: walked.value.diagnostics,
    ...(omitted > 0
      ? {
          truncation: {
            truncatedBy: "items" as const,
            outputItems: paged.length,
            nextOffset,
            ...(validated.type === "all" ? {} : { type: validated.type }),
            ...(validated.maxDepth === undefined
              ? {}
              : { maxDepth: validated.maxDepth }),
            ...(validated.includeIgnored ? { includeIgnored: true as const } : {}),
          },
        }
      : {}),
  };
  return {
    content: [{ type: "text", text: formatFindContent(paged, omitted, nextOffset) }],
    details,
  };
}

export function createFindTool(options: FindToolOptions): FindTool {
  return {
    name: "find",
    description: FIND_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pattern: {
          type: "string",
          description:
            "Platform-independent glob matched against Search Root descendants",
        },
        path: {
          type: "string",
          description:
            "Absolute or Session-cwd-relative directory path; defaults to .",
        },
        type: {
          type: "string",
          enum: ["file", "directory", "symlink", "all"],
          description: "Entry type to return; defaults to all",
        },
        maxDepth: {
          type: "integer",
          minimum: 1,
          maximum: TRAVERSAL_MAX_DEPTH,
          description:
            "Maximum traversal depth where 1 means direct children only; unlimited when omitted",
        },
        includeIgnored: {
          type: "boolean",
          description:
            "When true, do not apply .gitignore or the built-in .git/ ignore; defaults to false",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Number of sorted entries to skip; defaults to 0",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: FIND_MAX_LIMIT,
          description: `Maximum number of entries to return; defaults to ${FIND_DEFAULT_LIMIT}`,
        },
      },
      required: ["pattern"],
    },
    execute(input, signal) {
      return executeFind(input, {
        ...options,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
