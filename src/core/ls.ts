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
const TRUNCATION_REASON_ORDER: readonly ToolTruncationReason[] = [
  "bytes",
  "lines",
  "items",
  "line-length",
];

export type LsErrorCode =
  | "EINVAL"
  | "EINVAL_PATH"
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

export type LsToolOptions = {
  readonly sessionCwd: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

export type LsTool = {
  readonly name: "ls";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult>;
};

type ValidatedArguments = {
  readonly path: string;
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

type LsEntry = {
  readonly name: string;
  readonly type: TraversalEntry["type"];
};

function fail(
  code: LsErrorCode,
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
  return fail("EINVAL", "Invalid ls arguments.", { field });
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function validateArguments(input: unknown): ArgumentValidationResult {
  if (!isRecord(input)) {
    return { ok: false, result: invalid("path") };
  }
  const extra = Object.keys(input).find((key) => !ALLOWED_FIELDS.has(key));
  if (extra !== undefined) {
    return { ok: false, result: invalid(extra) };
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    return { ok: false, result: invalid("path") };
  }
  if (input.includeIgnored !== undefined && typeof input.includeIgnored !== "boolean") {
    return { ok: false, result: invalid("includeIgnored") };
  }
  if (input.limit !== undefined && !isSafeInteger(input.limit)) {
    return { ok: false, result: invalid("limit") };
  }
  if (input.offset !== undefined && !isSafeInteger(input.offset)) {
    return { ok: false, result: invalid("offset") };
  }
  if (
    input.limit !== undefined &&
    (input.limit < 1 || input.limit > LS_MAX_LIMIT)
  ) {
    return {
      ok: false,
      result: fail(
        "EINVAL_LIMIT",
        `limit must be an integer between 1 and ${LS_MAX_LIMIT}.`,
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
  return {
    ok: true,
    value: {
      path: input.path ?? ".",
      includeIgnored: input.includeIgnored === true,
      limit: input.limit ?? LS_DEFAULT_LIMIT,
      offset: input.offset ?? 0,
    },
  };
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
    return fail("ETIMEDOUT", "Ls timed out.", details);
  }
  return fail("EIO", "Path cannot be listed.", details);
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function abortResult(signal: AbortSignal, details?: JsonObject): ToolResult {
  return isTimeoutReason(signal.reason)
    ? fail("ETIMEDOUT", "Ls timed out.", details)
    : fail("ETOOL", "Tool execution failed.", details);
}

function toLsEntry(entry: TraversalEntry): LsEntry {
  return { name: entry.path, type: entry.type };
}

function continuationArguments(
  args: ValidatedArguments,
  offset: number,
): JsonObject {
  return {
    path: args.path,
    offset,
    limit: args.limit,
    ...(args.includeIgnored ? { includeIgnored: true } : {}),
  };
}

function fieldBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function mergeLimitContinuation(
  bounded: ToolResult,
  args: ValidatedArguments,
  paged: readonly LsEntry[],
  remaining: readonly LsEntry[],
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
  const retainedBytes = existing?.retained.bytes ??
    fieldBytes(bounded.result.entries) + fieldBytes(bounded.result.diagnostics);
  return normalizeToolResult({
    ok: true,
    result: bounded.result,
    meta: {
      truncation: {
        reasons,
        strategy: "head",
        fields,
        retained: {
          bytes: retainedBytes,
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

function boundLsResult(
  facts: PathFacts,
  args: ValidatedArguments,
  remaining: readonly LsEntry[],
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
        const retainedEntries = retainedRecordIndices.filter(
          (index) => index < paged.length,
        ).length;
        if (
          firstOmittedRecordIndex !== undefined &&
          firstOmittedRecordIndex < paged.length
        ) {
          if (retainedEntries === 0) {
            return undefined;
          }
          return continuationArguments(
            args,
            args.offset + firstOmittedRecordIndex,
          );
        }
        if (remaining.length > paged.length) {
          return continuationArguments(args, args.offset + paged.length);
        }
        return undefined;
      },
    });
    return mergeLimitContinuation(
      bounded,
      args,
      paged,
      remaining,
      diagnostics,
    );
  } catch {
    return fail("ETOOL", "Tool result exceeds its size limit.", facts);
  }
}

export async function executeLs(
  input: unknown,
  options: LsToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult> {
  const validated = validateArguments(input);
  if (!validated.ok) {
    return validated.result;
  }

  const timeoutMs = options.timeoutMs ?? LS_DEFAULT_TIMEOUT_MS;
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
    maxDepth: 1,
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

  const remaining = walked.value.entries.slice(validated.value.offset).map(toLsEntry);
  return boundLsResult(
    facts,
    validated.value,
    remaining,
    walked.value.diagnostics,
  );
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
