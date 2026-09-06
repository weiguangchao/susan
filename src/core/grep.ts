import { type Stats } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isRecord, type JsonObject } from "./json.js";
import {
  createSessionPathResolver,
  type CwdRelation,
  type PathResolution,
  type PathResolutionError,
} from "./path-resolver.js";
import { decodeUtf8Text } from "./text-file.js";
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
  TRAVERSAL_MAX_DIAGNOSTICS,
  compileGlob,
  filesystemErrorCode,
  traverse,
  type TraversalDiagnostic,
  type TraversalDiagnosticOperation,
  type TraversalError,
} from "./traverse.js";

export const GREP_DEFAULT_LIMIT = 100;
export const GREP_MAX_LIMIT = 1_000;
export const GREP_MAX_CONTEXT = 10;
export const GREP_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const GREP_MAX_LINE_TEXT_BYTES = 1_000;
export const GREP_DEFAULT_TIMEOUT_MS = TRAVERSAL_DEFAULT_TIMEOUT_MS;

const GREP_DESCRIPTION =
  "Search logical lines in one UTF-8 regular file or recursively beneath a directory. Use grep instead of bash or a host grep command when looking for file content. It supports ECMAScript Unicode regex or literal matching, optional context, a platform-independent file glob, depth and ignore controls, and deterministic pagination. Results may include Traversal Diagnostics; their presence means the traversal was not completely error-free.";

const ALLOWED_FIELDS = new Set([
  "pattern",
  "path",
  "glob",
  "literal",
  "ignoreCase",
  "context",
  "maxDepth",
  "includeIgnored",
  "limit",
  "offset",
]);
const FILE_ONLY_CONFLICTS = ["glob", "maxDepth", "includeIgnored"] as const;
const REGEX_METACHARACTERS = /[\\^$.*+?()[\]{}|\/]/g;
const TRUNCATION_REASON_ORDER: readonly ToolTruncationReason[] = [
  "bytes",
  "lines",
  "items",
  "line-length",
];

export type GrepErrorCode =
  | "EINVAL"
  | "EINVAL_PATH"
  | "EINVAL_PATTERN"
  | "EINVAL_GLOB"
  | "EINVAL_LIMIT"
  | "EINVAL_OFFSET"
  | "EINVAL_DEPTH"
  | "EINVAL_CONTEXT"
  | "ENOENT"
  | "EACCES"
  | "ELOOP"
  | "EIO"
  | "EUNSUPPORTED"
  | "EBINARY"
  | "EFILE_TOO_LARGE"
  | "EQUERY_TOO_LARGE"
  | "ETIMEDOUT"
  | "ETOOL";

export type GrepToolOptions = {
  readonly sessionCwd: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

export type GrepTool = {
  readonly name: "grep";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult>;
};

type ValidatedArguments = {
  readonly pattern: string;
  readonly path: string;
  readonly glob: string | undefined;
  readonly literal: boolean;
  readonly ignoreCase: boolean;
  readonly context: number;
  readonly maxDepth: number | undefined;
  readonly includeIgnored: boolean | undefined;
  readonly limit: number;
  readonly offset: number;
};

type ValidatedQuery = {
  readonly args: ValidatedArguments;
  readonly matcher: RegExp;
  readonly provided: ReadonlySet<string>;
};

type ArgumentValidationResult =
  | { readonly ok: true; readonly value: ValidatedQuery }
  | { readonly ok: false; readonly result: ToolResult };

type PathFacts = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
};

type ContextLine = {
  readonly line: number;
  readonly text: string;
};

type GrepMatch = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly before: readonly ContextLine[];
  readonly after: readonly ContextLine[];
};

type MatchCandidate = {
  readonly match: GrepMatch;
  readonly hasClippedText: boolean;
};

type QueryBudget = {
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly deadline: number;
  readonly timeoutMs: number;
};

type FileContentFailure = {
  readonly operation: TraversalDiagnosticOperation;
  readonly code: string;
};

type FileContentResult =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly failure: FileContentFailure };

function fail(
  code: GrepErrorCode,
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
  return fail("EINVAL", "Invalid grep arguments.", { field });
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function compileMatcher(
  pattern: string,
  literal: boolean,
  ignoreCase: boolean,
): RegExp | undefined {
  const source = literal
    ? pattern.replace(REGEX_METACHARACTERS, "\\$&")
    : pattern;
  try {
    return new RegExp(source, ignoreCase ? "iu" : "u");
  } catch {
    return undefined;
  }
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
  if (input.glob !== undefined && typeof input.glob !== "string") {
    return { ok: false, result: invalid("glob") };
  }
  if (input.literal !== undefined && typeof input.literal !== "boolean") {
    return { ok: false, result: invalid("literal") };
  }
  if (input.ignoreCase !== undefined && typeof input.ignoreCase !== "boolean") {
    return { ok: false, result: invalid("ignoreCase") };
  }
  if (
    input.includeIgnored !== undefined &&
    typeof input.includeIgnored !== "boolean"
  ) {
    return { ok: false, result: invalid("includeIgnored") };
  }
  if (input.context !== undefined && !isSafeInteger(input.context)) {
    return { ok: false, result: invalid("context") };
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

  const literal = input.literal === true;
  const ignoreCase = input.ignoreCase === true;
  const matcher = input.pattern.length === 0
    ? undefined
    : compileMatcher(input.pattern, literal, ignoreCase);
  if (matcher === undefined) {
    return {
      ok: false,
      result: fail(
        "EINVAL_PATTERN",
        "pattern must be a non-empty ECMAScript Unicode regex.",
        { field: "pattern" },
      ),
    };
  }
  if (input.glob !== undefined && !compileGlob(input.glob).ok) {
    return {
      ok: false,
      result: fail("EINVAL_GLOB", "glob pattern is invalid.", { field: "glob" }),
    };
  }
  if (
    input.limit !== undefined &&
    (input.limit < 1 || input.limit > GREP_MAX_LIMIT)
  ) {
    return {
      ok: false,
      result: fail(
        "EINVAL_LIMIT",
        `limit must be an integer between 1 and ${GREP_MAX_LIMIT}.`,
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
  if (
    input.context !== undefined &&
    (input.context < 0 || input.context > GREP_MAX_CONTEXT)
  ) {
    return {
      ok: false,
      result: fail(
        "EINVAL_CONTEXT",
        `context must be an integer between 0 and ${GREP_MAX_CONTEXT}.`,
        { field: "context" },
      ),
    };
  }

  return {
    ok: true,
    value: {
      args: {
        pattern: input.pattern,
        path: input.path ?? ".",
        glob: input.glob,
        literal,
        ignoreCase,
        context: input.context ?? 0,
        maxDepth: input.maxDepth,
        includeIgnored: input.includeIgnored,
        limit: input.limit ?? GREP_DEFAULT_LIMIT,
        offset: input.offset ?? 0,
      },
      matcher,
      provided: new Set(
        Object.keys(input).filter((key) => input[key] !== undefined),
      ),
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

function mapObservedIoError(error: unknown, facts: PathFacts): ToolResult {
  const code = nodeErrorCode(error);
  if (code === "ENOENT") {
    return fail("ENOENT", "Path does not exist.", facts);
  }
  if (code === "EACCES" || code === "EPERM") {
    return fail("EACCES", "Path cannot be read.", facts);
  }
  if (code === "ELOOP") {
    return fail("ELOOP", "Path contains a symlink loop.", facts);
  }
  return fail("EIO", "Path cannot be read.", facts);
}

function mapTraversalError(error: TraversalError, facts: PathFacts): ToolResult {
  const details = {
    ...facts,
    ...(error.details === undefined ? {} : error.details),
  };
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
    return fail("ETIMEDOUT", "Grep timed out.", details);
  }
  return fail("EIO", "Search Root cannot be traversed.", details);
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function abortResult(signal: AbortSignal, details?: JsonObject): ToolResult {
  return isTimeoutReason(signal.reason)
    ? fail("ETIMEDOUT", "Grep timed out.", details)
    : fail("ETOOL", "Tool execution failed.", details);
}

function splitLogicalLines(text: string): readonly string[] {
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }
    const end = index > start && text[index - 1] === "\r" ? index - 1 : index;
    lines.push(text.slice(start, end));
    start = index + 1;
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

function clipLineText(text: string): { readonly text: string; readonly clipped: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= GREP_MAX_LINE_TEXT_BYTES) {
    return { text, clipped: false };
  }
  let end = GREP_MAX_LINE_TEXT_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: bytes.subarray(0, end).toString("utf8"), clipped: true };
}

function collectMatches(
  path: string,
  lines: readonly string[],
  matcher: RegExp,
  context: number,
): readonly MatchCandidate[] {
  const candidates: MatchCandidate[] = [];
  for (const [index, line] of lines.entries()) {
    if (!matcher.test(line)) {
      continue;
    }
    let hasClippedText = false;
    const clip = (value: string): string => {
      const result = clipLineText(value);
      hasClippedText = hasClippedText || result.clipped;
      return result.text;
    };
    const before: ContextLine[] = [];
    for (let cursor = Math.max(0, index - context); cursor < index; cursor += 1) {
      before.push({ line: cursor + 1, text: clip(lines[cursor]) });
    }
    const after: ContextLine[] = [];
    const lastAfter = Math.min(lines.length - 1, index + context);
    for (let cursor = index + 1; cursor <= lastAfter; cursor += 1) {
      after.push({ line: cursor + 1, text: clip(lines[cursor]) });
    }
    const text = clip(line);
    candidates.push({
      match: { path, line: index + 1, text, before, after },
      hasClippedText,
    });
  }
  return candidates;
}

async function readLogicalLines(
  absolutePath: string,
  signal: AbortSignal,
): Promise<FileContentResult> {
  let stats: Stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    return {
      ok: false,
      failure: { operation: "read-metadata", code: filesystemErrorCode(error) },
    };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return {
      ok: false,
      failure: { operation: "read-metadata", code: "EUNSUPPORTED" },
    };
  }
  if (stats.size > GREP_MAX_FILE_BYTES) {
    return {
      ok: false,
      failure: { operation: "read-file", code: "EFILE_TOO_LARGE" },
    };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath, { signal });
  } catch (error) {
    return {
      ok: false,
      failure: { operation: "read-file", code: filesystemErrorCode(error) },
    };
  }
  const decoded = decodeUtf8Text(bytes);
  return decoded.ok
    ? { ok: true, lines: splitLogicalLines(decoded.text) }
    : { ok: false, failure: { operation: "read-file", code: "EBINARY" } };
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
    ...(args.glob === undefined ? {} : { glob: args.glob }),
    ...(args.literal ? { literal: true } : {}),
    ...(args.ignoreCase ? { ignoreCase: true } : {}),
    ...(args.context > 0 ? { context: args.context } : {}),
    ...(args.maxDepth === undefined ? {} : { maxDepth: args.maxDepth }),
    ...(args.includeIgnored === true ? { includeIgnored: true } : {}),
  };
}

function fieldBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function mergeGrepTruncation(
  bounded: ToolResult,
  args: ValidatedArguments,
  paged: readonly MatchCandidate[],
  remaining: readonly MatchCandidate[],
  diagnostics: readonly TraversalDiagnostic[],
): ToolResult {
  if (!bounded.ok) {
    return bounded;
  }
  const retainedMatches = Array.isArray(bounded.result.matches)
    ? bounded.result.matches.length
    : 0;
  const existing = bounded.meta?.truncation;
  const overflowed =
    remaining.length > paged.length && retainedMatches === paged.length;
  const clipped = paged
    .slice(0, retainedMatches)
    .some((candidate) => candidate.hasClippedText);
  const added = new Set<ToolTruncationReason>([
    ...(overflowed ? (["items"] as const) : []),
    ...(clipped ? (["line-length"] as const) : []),
  ]);
  if (added.size === 0) {
    return bounded;
  }
  const reasons = TRUNCATION_REASON_ORDER.filter(
    (reason) => added.has(reason) || existing?.reasons.includes(reason) === true,
  );
  const fields = ["matches", "diagnostics"].filter(
    (field) => field === "matches" || existing?.fields.includes(field) === true,
  );
  const nextArguments = existing?.nextArguments ??
    (overflowed
      ? continuationArguments(args, args.offset + paged.length)
      : undefined);
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
            fieldBytes(bounded.result.matches) +
              fieldBytes(bounded.result.diagnostics),
          items: retainedMatches,
        },
        total: {
          bytes: fieldBytes(remaining.map((candidate) => candidate.match)) +
            fieldBytes(diagnostics),
          items: remaining.length,
        },
        ...(nextArguments === undefined ? {} : { nextArguments }),
      },
    },
  });
}

function boundGrepResult(
  facts: PathFacts,
  args: ValidatedArguments,
  candidates: readonly MatchCandidate[],
  diagnostics: readonly TraversalDiagnostic[],
): ToolResult {
  const remaining = candidates.slice(args.offset);
  const paged = remaining.slice(0, args.limit);
  try {
    const bounded = boundToolResult({
      result: { ...facts },
      fields: [
        { name: "matches", kind: "items" },
        { name: "diagnostics", kind: "items" },
      ],
      records: [
        ...paged.map((candidate) => ({
          field: "matches",
          value: candidate.match,
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
          const retainedMatches = retainedRecordIndices.filter(
            (index) => index < paged.length,
          ).length;
          return retainedMatches === 0
            ? undefined
            : continuationArguments(args, args.offset + firstOmittedRecordIndex);
        }
        return remaining.length > paged.length
          ? continuationArguments(args, args.offset + paged.length)
          : undefined;
      },
    });
    return mergeGrepTruncation(bounded, args, paged, remaining, diagnostics);
  } catch {
    return fail("ETOOL", "Tool result exceeds its size limit.", facts);
  }
}

async function searchSingleFile(
  facts: PathFacts,
  query: ValidatedQuery,
  rootStats: Stats,
  signal: AbortSignal,
): Promise<ToolResult> {
  const conflict = FILE_ONLY_CONFLICTS.find((field) =>
    query.provided.has(field),
  );
  if (conflict !== undefined) {
    return invalid(conflict);
  }
  if (!rootStats.isFile()) {
    return fail("EUNSUPPORTED", "Path is not a regular file.", facts);
  }
  if (rootStats.size > GREP_MAX_FILE_BYTES) {
    return fail("EFILE_TOO_LARGE", "File exceeds the 10 MiB size limit.", {
      ...facts,
      actualBytes: rootStats.size,
      limitBytes: GREP_MAX_FILE_BYTES,
    });
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(facts.realTargetPath, { signal });
  } catch (error) {
    return signal.aborted
      ? abortResult(signal, facts)
      : mapObservedIoError(error, facts);
  }
  const decoded = decodeUtf8Text(bytes);
  if (!decoded.ok) {
    return fail("EBINARY", "File is not valid UTF-8 text.", facts);
  }
  return boundGrepResult(
    facts,
    query.args,
    collectMatches(
      basename(facts.resolvedPath),
      splitLogicalLines(decoded.text),
      query.matcher,
      query.args.context,
    ),
    [],
  );
}

async function searchTree(
  facts: PathFacts,
  query: ValidatedQuery,
  budget: QueryBudget,
): Promise<ToolResult> {
  const { args } = query;
  const { signal } = budget;
  const walked = await traverse({
    searchRoot: facts.realTargetPath,
    ...(args.glob === undefined ? {} : { glob: args.glob }),
    ...(args.maxDepth === undefined ? {} : { maxDepth: args.maxDepth }),
    includeIgnored: args.includeIgnored === true,
    timeoutMs: budget.timeoutMs,
    now: budget.now,
    signal,
  });
  if (!walked.ok) {
    return signal.aborted
      ? abortResult(signal, facts)
      : mapTraversalError(walked.error, facts);
  }

  const candidates: MatchCandidate[] = [];
  const diagnostics = [...walked.value.diagnostics];
  for (const entry of walked.value.entries) {
    if (entry.type !== "file") {
      continue;
    }
    if (signal.aborted) {
      return abortResult(signal, facts);
    }
    if (budget.now() >= budget.deadline) {
      return fail("ETIMEDOUT", "Grep timed out.", {
        ...facts,
        matchedItems: candidates.length,
      });
    }
    const content = await readLogicalLines(
      join(facts.realTargetPath, ...entry.path.split("/")),
      signal,
    );
    if (!content.ok) {
      if (signal.aborted) {
        return abortResult(signal, facts);
      }
      diagnostics.push({ path: entry.path, ...content.failure });
      continue;
    }
    candidates.push(
      ...collectMatches(entry.path, content.lines, query.matcher, args.context),
    );
  }

  return boundGrepResult(
    facts,
    args,
    candidates,
    diagnostics
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      )
      .slice(0, TRAVERSAL_MAX_DIAGNOSTICS),
  );
}

export async function executeGrep(
  input: unknown,
  options: GrepToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult> {
  const validated = validateArguments(input);
  if (!validated.ok) {
    return validated.result;
  }

  const timeoutMs = options.timeoutMs ?? GREP_DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([timeout, options.signal]);
  if (signal.aborted) {
    return abortResult(signal);
  }
  const budget: QueryBudget = {
    signal,
    now,
    deadline: now() + timeoutMs,
    timeoutMs,
  };

  const resolverResult = await createSessionPathResolver(options.sessionCwd);
  if (signal.aborted) {
    return abortResult(signal);
  }
  if (!resolverResult.ok) {
    return mapPathError(resolverResult.error);
  }

  const resolved = await resolverResult.value.resolve(validated.value.args.path, {
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
  let rootStats: Stats;
  try {
    rootStats = await stat(facts.realTargetPath);
  } catch (error) {
    return signal.aborted
      ? abortResult(signal, facts)
      : mapObservedIoError(error, facts);
  }
  if (rootStats.isDirectory()) {
    return searchTree(facts, validated.value, budget);
  }
  if (budget.now() >= budget.deadline) {
    return fail("ETIMEDOUT", "Grep timed out.", facts);
  }
  return searchSingleFile(facts, validated.value, rootStats, signal);
}

export function createGrepTool(options: GrepToolOptions): GrepTool {
  return {
    name: "grep",
    description: GREP_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pattern: {
          type: "string",
          description:
            "ECMAScript Unicode regex matched against one logical line at a time, or an exact substring when literal is true",
        },
        path: {
          type: "string",
          description:
            "Absolute or Session-cwd-relative file or directory path; defaults to .",
        },
        glob: {
          type: "string",
          description:
            "Platform-independent glob selecting which files under the Search Root are searched; directory-target only",
        },
        literal: {
          type: "boolean",
          description:
            "When true, treat pattern as an exact substring instead of a regex; defaults to false",
        },
        ignoreCase: {
          type: "boolean",
          description:
            "When true, match content case-insensitively; defaults to false",
        },
        context: {
          type: "integer",
          minimum: 0,
          maximum: GREP_MAX_CONTEXT,
          description:
            "Number of lines kept before and after each match; defaults to 0",
        },
        maxDepth: {
          type: "integer",
          minimum: 1,
          maximum: TRAVERSAL_MAX_DEPTH,
          description:
            "Maximum traversal depth where 1 means direct children only; unlimited when omitted; directory-target only",
        },
        includeIgnored: {
          type: "boolean",
          description:
            "When true, do not apply .gitignore or the built-in .git/ ignore; defaults to false; directory-target only",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Number of sorted matches to skip; defaults to 0",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: GREP_MAX_LIMIT,
          description: `Maximum number of matches to return; defaults to ${GREP_DEFAULT_LIMIT}`,
        },
      },
      required: ["pattern"],
    },
    execute(input, signal) {
      return executeGrep(input, {
        ...options,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
