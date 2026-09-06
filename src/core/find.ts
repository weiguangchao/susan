import { isRecord, type JsonObject } from "./json.js";
import {
  createSessionPathResolver,
  type CwdRelation,
  type PathResolution,
  type PathResolutionError,
} from "./path-resolver.js";
import {
  boundToolFailure,
  boundToolResult,
  normalizeToolResult,
  type ToolResult,
  type ToolResultContinuationContext,
  type ToolTruncationReason,
} from "./tool-result.js";
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
const TRUNCATION_REASON_ORDER: readonly ToolTruncationReason[] = [
  "bytes",
  "lines",
  "items",
  "line-length",
];

const FIND_TYPES = ["file", "directory", "symlink", "all"] as const;

export type FindEntryType = (typeof FIND_TYPES)[number];

export type FindErrorCode =
  | "EINVAL"
  | "EINVAL_PATH"
  | "EINVAL_GLOB"
  | "EINVAL_TYPE"
  | "EINVAL_DEPTH"
  | "EINVAL_LIMIT"
  | "EINVAL_OFFSET"
  | "ENOENT"
  | "ENOTDIR"
  | "EACCES"
  | "ELOOP"
  | "EIO"
  | "EQUERY_TOO_LARGE"
  | "ETIMEDOUT"
  | "ETOOL";

export type FindToolOptions = {
  readonly sessionCwd: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

export type FindTool = {
  readonly name: "find";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult>;
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

type ArgumentValidationResult =
  | { readonly ok: true; readonly value: ValidatedArguments }
  | { readonly ok: false; readonly result: ToolResult };

type PathFacts = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
};

function fail(
  code: FindErrorCode,
  message: string,
  details?: JsonObject,
): ToolResult {
  if (details === undefined) {
    return { ok: false, error: { code, message } };
  }
  try {
    return boundToolFailure({
      error: { code, message, details },
      fields: [],
      records: [],
      strategy: "head",
    });
  } catch {
    return {
      ok: false,
      error: { code: "ETOOL", message: "Tool result exceeds its size limit." },
    };
  }
}

function invalid(field: string): ToolResult {
  return fail("EINVAL", "Invalid find arguments.", { field });
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isFindEntryType(value: unknown): value is FindEntryType {
  return FIND_TYPES.includes(value as FindEntryType);
}

function validateArguments(input: unknown): ArgumentValidationResult {
  if (!isRecord(input)) {
    return { ok: false, result: invalid("pattern") };
  }
  const extra = Object.keys(input).find((key) => !ALLOWED_FIELDS.has(key));
  if (extra !== undefined) {
    return { ok: false, result: invalid(extra) };
  }
  if (typeof input.pattern !== "string") {
    return { ok: false, result: invalid("pattern") };
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    return { ok: false, result: invalid("path") };
  }
  if (input.type !== undefined && typeof input.type !== "string") {
    return { ok: false, result: invalid("type") };
  }
  if (
    input.includeIgnored !== undefined &&
    typeof input.includeIgnored !== "boolean"
  ) {
    return { ok: false, result: invalid("includeIgnored") };
  }
  if (input.maxDepth !== undefined && !isSafeInteger(input.maxDepth)) {
    return { ok: false, result: invalid("maxDepth") };
  }
  if (input.limit !== undefined && !isSafeInteger(input.limit)) {
    return { ok: false, result: invalid("limit") };
  }
  if (input.offset !== undefined && !isSafeInteger(input.offset)) {
    return { ok: false, result: invalid("offset") };
  }
  if (!compileGlob(input.pattern).ok) {
    return {
      ok: false,
      result: fail("EINVAL_GLOB", "pattern must be a valid glob.", {
        field: "pattern",
      }),
    };
  }
  if (input.type !== undefined && !isFindEntryType(input.type)) {
    return {
      ok: false,
      result: fail("EINVAL_TYPE", `type must be one of ${FIND_TYPES.join(", ")}.`, {
        field: "type",
      }),
    };
  }
  if (
    input.limit !== undefined &&
    (input.limit < 1 || input.limit > FIND_MAX_LIMIT)
  ) {
    return {
      ok: false,
      result: fail(
        "EINVAL_LIMIT",
        `limit must be an integer between 1 and ${FIND_MAX_LIMIT}.`,
        { field: "limit" },
      ),
    };
  }
  if (input.offset !== undefined && input.offset < 0) {
    return {
      ok: false,
      result: fail("EINVAL_OFFSET", "offset must be a non-negative integer.", {
        field: "offset",
      }),
    };
  }
  if (
    input.maxDepth !== undefined &&
    (input.maxDepth < 1 || input.maxDepth > TRAVERSAL_MAX_DEPTH)
  ) {
    return {
      ok: false,
      result: fail(
        "EINVAL_DEPTH",
        `maxDepth must be an integer between 1 and ${TRAVERSAL_MAX_DEPTH}.`,
        { field: "maxDepth" },
      ),
    };
  }
  return {
    ok: true,
    value: {
      pattern: input.pattern,
      path: input.path ?? ".",
      type: isFindEntryType(input.type) ? input.type : "all",
      maxDepth: input.maxDepth,
      includeIgnored: input.includeIgnored === true,
      limit: input.limit ?? FIND_DEFAULT_LIMIT,
      offset: input.offset ?? 0,
    },
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

function mapPathError(error: PathResolutionError): ToolResult {
  const details = error.details === undefined ? undefined : { ...error.details };
  if (error.code === "ESYMLINK") {
    return fail("EIO", "Path cannot be resolved.", details);
  }
  const messages: Record<Exclude<PathResolutionError["code"], "ESYMLINK">, string> = {
    EINVAL_PATH: "Path syntax is invalid.",
    ENOENT: "Path does not exist.",
    ELOOP: "Path contains a symlink loop.",
    EACCES: "Path cannot be read.",
    EIO: "Path cannot be resolved.",
  };
  return fail(error.code, messages[error.code], details);
}

function mapTraversalError(error: TraversalError, facts: PathFacts): ToolResult {
  const details = {
    ...facts,
    ...(error.details === undefined ? {} : error.details),
  };
  if (error.code === "ENOTDIR") {
    return fail("ENOTDIR", "Path is not a directory.", details);
  }
  if (error.code === "ENOENT") {
    return fail("ENOENT", "Path does not exist.", details);
  }
  if (error.code === "EACCES") {
    return fail("EACCES", "Path cannot be read.", details);
  }
  if (error.code === "ELOOP") {
    return fail("ELOOP", "Path contains a symlink loop.", details);
  }
  if (error.code === "EQUERY_TOO_LARGE") {
    return fail("EQUERY_TOO_LARGE", "Query exceeded the entry budget.", details);
  }
  if (error.code === "ETIMEDOUT") {
    return fail("ETIMEDOUT", "Find timed out.", details);
  }
  return fail("EIO", "Search Root cannot be traversed.", details);
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function abortResult(signal: AbortSignal, details?: JsonObject): ToolResult {
  return isTimeoutReason(signal.reason)
    ? fail("ETIMEDOUT", "Find timed out.", details)
    : fail("ETOOL", "Tool execution failed.", details);
}

function continuationArguments(
  args: ValidatedArguments,
  offset: number,
): JsonObject {
  return {
    pattern: args.pattern,
    path: args.path,
    offset,
    limit: args.limit,
    ...(args.type === "all" ? {} : { type: args.type }),
    ...(args.maxDepth === undefined ? {} : { maxDepth: args.maxDepth }),
    ...(args.includeIgnored ? { includeIgnored: true } : {}),
  };
}

function fieldBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function mergeLimitContinuation(
  bounded: ToolResult,
  args: ValidatedArguments,
  paged: readonly TraversalEntry[],
  remaining: readonly TraversalEntry[],
  diagnostics: readonly TraversalDiagnostic[],
): ToolResult {
  if (!bounded.ok || remaining.length <= paged.length) {
    return bounded;
  }
  const retainedEntries = Array.isArray(bounded.result.entries)
    ? bounded.result.entries.length
    : 0;
  if (retainedEntries !== paged.length) {
    return bounded;
  }
  const existing = bounded.meta?.truncation;
  if (
    existing?.reasons.includes("items") === true &&
    existing.fields.includes("entries") &&
    existing.nextArguments !== undefined
  ) {
    return bounded;
  }
  const reasons = TRUNCATION_REASON_ORDER.filter(
    (reason) => reason === "items" || existing?.reasons.includes(reason) === true,
  );
  const fields = ["entries", "diagnostics"].filter(
    (field) => field === "entries" || existing?.fields.includes(field) === true,
  );
  return normalizeToolResult({
    ok: true,
    result: bounded.result,
    meta: {
      truncation: {
        reasons,
        strategy: "head",
        fields,
        retained: {
          bytes: existing?.retained.bytes ??
            fieldBytes(bounded.result.entries) +
              fieldBytes(bounded.result.diagnostics),
          items: retainedEntries,
        },
        total: {
          bytes: fieldBytes(remaining) + fieldBytes(diagnostics),
          items: remaining.length,
        },
        nextArguments: existing?.nextArguments ??
          continuationArguments(args, args.offset + paged.length),
      },
    },
  });
}

function boundFindResult(
  facts: PathFacts,
  args: ValidatedArguments,
  remaining: readonly TraversalEntry[],
  diagnostics: readonly TraversalDiagnostic[],
): ToolResult {
  const paged = remaining.slice(0, args.limit);
  try {
    const bounded = boundToolResult({
      result: { ...facts },
      fields: [
        { name: "entries", kind: "items" },
        { name: "diagnostics", kind: "items" },
      ],
      records: [
        ...paged.map((entry) => ({
          field: "entries",
          value: entry,
          items: 1 as const,
        })),
        ...diagnostics.map((diagnostic) => ({
          field: "diagnostics",
          value: diagnostic,
        })),
      ],
      strategy: "head" as const,
      includeTotal: ["bytes", "items"],
      continuation({
        firstOmittedRecordIndex,
        retainedRecordIndices,
      }: ToolResultContinuationContext) {
        if (
          firstOmittedRecordIndex !== undefined &&
          firstOmittedRecordIndex < paged.length
        ) {
          const retainedEntries = retainedRecordIndices.filter(
            (index) => index < paged.length,
          ).length;
          return retainedEntries === 0
            ? undefined
            : continuationArguments(args, args.offset + firstOmittedRecordIndex);
        }
        return remaining.length > paged.length
          ? continuationArguments(args, args.offset + paged.length)
          : undefined;
      },
    });
    return mergeLimitContinuation(bounded, args, paged, remaining, diagnostics);
  } catch {
    return fail("ETOOL", "Tool result exceeds its size limit.", facts);
  }
}

export async function executeFind(
  input: unknown,
  options: FindToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult> {
  const validated = validateArguments(input);
  if (!validated.ok) {
    return validated.result;
  }

  const timeoutMs = options.timeoutMs ?? FIND_DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([timeout, options.signal]);
  if (signal.aborted) {
    return abortResult(signal);
  }

  const resolverResult = await createSessionPathResolver(options.sessionCwd);
  if (signal.aborted) {
    return abortResult(signal);
  }
  if (!resolverResult.ok) {
    return mapPathError(resolverResult.error);
  }

  const resolved = await resolverResult.value.resolve(validated.value.path, {
    existence: "required",
    symlinks: "follow",
  });
  if (signal.aborted) {
    return abortResult(signal);
  }
  if (!resolved.ok) {
    return mapPathError(resolved.error);
  }

  const facts = pathFacts(resolved.value);
  const walked = await traverse({
    searchRoot: facts.realTargetPath,
    glob: validated.value.pattern,
    ...(validated.value.maxDepth === undefined
      ? {}
      : { maxDepth: validated.value.maxDepth }),
    includeIgnored: validated.value.includeIgnored,
    timeoutMs,
    signal,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (!walked.ok) {
    if (signal.aborted) {
      return abortResult(signal, facts);
    }
    return mapTraversalError(walked.error, facts);
  }

  const remaining = walked.value.entries
    .filter((entry) => matchesType(entry, validated.value.type))
    .slice(validated.value.offset);
  return boundFindResult(
    facts,
    validated.value,
    remaining,
    walked.value.diagnostics,
  );
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
