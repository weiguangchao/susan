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
import { type ToolResult } from "./tool-result.js";
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

export type GrepToolOptions = {
  readonly sessionCwd: string;
  readonly timeoutMs?: number;
  readonly now?: () => number;
};

export type GrepMatch = {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly before: readonly { readonly line: number; readonly text: string }[];
  readonly after: readonly { readonly line: number; readonly text: string }[];
};

export type GrepToolDetails = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
  readonly matches: readonly GrepMatch[];
  readonly diagnostics: readonly TraversalDiagnostic[];
  readonly truncation?: {
    readonly truncatedBy: readonly ("items" | "line-length")[];
    readonly outputItems?: number;
    readonly nextOffset?: number;
    readonly glob?: string;
    readonly literal?: true;
    readonly ignoreCase?: true;
    readonly context?: number;
    readonly maxDepth?: number;
    readonly includeIgnored?: true;
  };
};

export type GrepTool = {
  readonly name: "grep";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult<GrepToolDetails>>;
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

type PathFacts = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
};

type ContextLine = {
  readonly line: number;
  readonly text: string;
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

function fail(message: string): never {
  throw new Error(message);
}

function invalid(_field: string): never {
  fail("Invalid grep arguments.");
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

function validateArguments(input: unknown): ValidatedQuery {
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
  if (input.glob !== undefined && typeof input.glob !== "string") {
    invalid("glob");
  }
  if (input.literal !== undefined && typeof input.literal !== "boolean") {
    invalid("literal");
  }
  if (input.ignoreCase !== undefined && typeof input.ignoreCase !== "boolean") {
    invalid("ignoreCase");
  }
  if (
    input.includeIgnored !== undefined &&
    typeof input.includeIgnored !== "boolean"
  ) {
    invalid("includeIgnored");
  }
  if (input.context !== undefined && !isSafeInteger(input.context)) {
    invalid("context");
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

  const literal = input.literal === true;
  const ignoreCase = input.ignoreCase === true;
  const matcher = input.pattern.length === 0
    ? undefined
    : compileMatcher(input.pattern, literal, ignoreCase);
  if (matcher === undefined) {
    fail("pattern must be a non-empty ECMAScript Unicode regex.");
  }
  if (input.glob !== undefined && !compileGlob(input.glob).ok) {
    fail("glob pattern is invalid.");
  }
  if (
    input.limit !== undefined &&
    (input.limit < 1 || input.limit > GREP_MAX_LIMIT)
  ) {
    fail(`limit must be an integer between 1 and ${GREP_MAX_LIMIT}.`);
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
  if (
    input.context !== undefined &&
    (input.context < 0 || input.context > GREP_MAX_CONTEXT)
  ) {
    fail(`context must be an integer between 0 and ${GREP_MAX_CONTEXT}.`);
  }

  return {
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

function mapObservedIoError(error: unknown): never {
  const code = nodeErrorCode(error);
  if (code === "ENOENT") {
    fail("Path does not exist.");
  }
  if (code === "EACCES" || code === "EPERM") {
    fail("Path cannot be read.");
  }
  if (code === "ELOOP") {
    fail("Path contains a symlink loop.");
  }
  fail("Path cannot be read.");
}

function mapTraversalError(error: TraversalError): never {
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
    fail("Grep timed out.");
  }
  fail("Search Root cannot be traversed.");
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function abortResult(signal: AbortSignal): never {
  if (isTimeoutReason(signal.reason)) {
    fail("Grep timed out.");
  }
  fail("Tool execution failed.");
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

function formatMatchLine(match: GrepMatch): string {
  return `${match.path}:${match.line}: ${match.text}`;
}

function formatGrepContent(
  matches: readonly GrepMatch[],
  remaining: number,
  nextOffset: number,
): string {
  const listing = matches.map(formatMatchLine).join("\n");
  if (remaining <= 0) {
    return listing;
  }
  const note = `[${remaining} more matches. Use offset=${nextOffset} to continue.]`;
  if (listing === "") {
    return note;
  }
  return `${listing}\n\n${note}`;
}

function boundGrepResult(
  facts: PathFacts,
  args: ValidatedArguments,
  candidates: readonly MatchCandidate[],
  diagnostics: readonly TraversalDiagnostic[],
): ToolResult<GrepToolDetails> {
  const remaining = candidates.slice(args.offset);
  const paged = remaining.slice(0, args.limit);
  const omitted = remaining.length - paged.length;
  const nextOffset = args.offset + paged.length;
  const clipped = paged.some((candidate) => candidate.hasClippedText);
  const truncatedBy: Array<"items" | "line-length"> = [
    ...(omitted > 0 ? (["items"] as const) : []),
    ...(clipped ? (["line-length"] as const) : []),
  ];
  const matches = paged.map((candidate) => candidate.match);
  const details: GrepToolDetails = {
    ...facts,
    matches,
    diagnostics,
    ...(truncatedBy.length > 0
      ? {
          truncation: {
            truncatedBy,
            ...(omitted > 0
              ? { outputItems: paged.length, nextOffset }
              : {}),
            ...(args.glob === undefined ? {} : { glob: args.glob }),
            ...(args.literal ? { literal: true as const } : {}),
            ...(args.ignoreCase ? { ignoreCase: true as const } : {}),
            ...(args.context > 0 ? { context: args.context } : {}),
            ...(args.maxDepth === undefined ? {} : { maxDepth: args.maxDepth }),
            ...(args.includeIgnored === true
              ? { includeIgnored: true as const }
              : {}),
          },
        }
      : {}),
  };
  return {
    content: [{
      type: "text",
      text: formatGrepContent(matches, omitted, nextOffset),
    }],
    details,
  };
}

async function searchSingleFile(
  facts: PathFacts,
  query: ValidatedQuery,
  rootStats: Stats,
  signal: AbortSignal,
): Promise<ToolResult<GrepToolDetails>> {
  const conflict = FILE_ONLY_CONFLICTS.find((field) =>
    query.provided.has(field),
  );
  if (conflict !== undefined) {
    invalid(conflict);
  }
  if (!rootStats.isFile()) {
    fail("Path is not a regular file.");
  }
  if (rootStats.size > GREP_MAX_FILE_BYTES) {
    fail("File exceeds the 10 MiB size limit.");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(facts.realTargetPath, { signal });
  } catch (error) {
    if (signal.aborted) {
      abortResult(signal);
    }
    mapObservedIoError(error);
  }
  const decoded = decodeUtf8Text(bytes);
  if (!decoded.ok) {
    fail("File is not valid UTF-8 text.");
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
): Promise<ToolResult<GrepToolDetails>> {
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
    if (signal.aborted) {
      abortResult(signal);
    }
    mapTraversalError(walked.error);
  }

  const candidates: MatchCandidate[] = [];
  const diagnostics = [...walked.value.diagnostics];
  for (const entry of walked.value.entries) {
    if (entry.type !== "file") {
      continue;
    }
    if (signal.aborted) {
      abortResult(signal);
    }
    if (budget.now() >= budget.deadline) {
      fail("Grep timed out.");
    }
    const content = await readLogicalLines(
      join(facts.realTargetPath, ...entry.path.split("/")),
      signal,
    );
    if (!content.ok) {
      if (signal.aborted) {
        abortResult(signal);
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
): Promise<ToolResult<GrepToolDetails>> {
  const validated = validateArguments(input);

  const timeoutMs = options.timeoutMs ?? GREP_DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([timeout, options.signal]);
  if (signal.aborted) {
    abortResult(signal);
  }
  const budget: QueryBudget = {
    signal,
    now,
    deadline: now() + timeoutMs,
    timeoutMs,
  };

  const resolverResult = await createSessionPathResolver(options.sessionCwd);
  if (signal.aborted) {
    abortResult(signal);
  }
  if (!resolverResult.ok) {
    mapPathError(resolverResult.error);
  }

  const resolved = await resolverResult.value.resolve(validated.args.path, {
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
  let rootStats: Stats;
  try {
    rootStats = await stat(facts.realTargetPath);
  } catch (error) {
    if (signal.aborted) {
      abortResult(signal);
    }
    mapObservedIoError(error);
  }
  if (rootStats.isDirectory()) {
    return searchTree(facts, validated, budget);
  }
  if (budget.now() >= budget.deadline) {
    fail("Grep timed out.");
  }
  return searchSingleFile(facts, validated, rootStats, signal);
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
