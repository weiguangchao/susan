import { type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isRecord, type JsonObject } from "./json.js";
import {
  createSessionPathResolver,
  type CwdRelation,
  type PathResolution,
  type PathResolutionError,
} from "./path-resolver.js";
import { decodeUtf8Text, type LineEnding } from "./text-file.js";
import {
  boundToolResult,
  normalizeToolResult,
  type ToolResult,
} from "./tool-result.js";

export const READ_MAX_LINES = 2000;
export const READ_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const READ_DEFAULT_TIMEOUT_MS = 10_000;

const READ_DESCRIPTION =
  "Read a UTF-8 regular file by path. offset is the 1-based start line (default 1); limit is the maximum number of lines (default and maximum 2000). Successful results include path facts, BOM, line ending, and shared truncation metadata. Use offset/limit or meta.truncation.nextArguments to continue. Directories, special files, binary, and invalid UTF-8 fail with typed errors.";

export type ReadLineEnding = LineEnding;

export type ReadErrorCode =
  | "EINVAL"
  | "EINVAL_PATH"
  | "ENOENT"
  | "EACCES"
  | "ELOOP"
  | "EIO"
  | "EISDIR"
  | "EUNSUPPORTED"
  | "EFILE_TOO_LARGE"
  | "EBINARY"
  | "EINVAL_OFFSET"
  | "EINVAL_LIMIT"
  | "ECONFLICT"
  | "ETIMEDOUT"
  | "ETOOL";

export type ReadToolOptions = {
  readonly sessionCwd: string;
  readonly timeoutMs?: number;
};

export type ReadTool = {
  readonly name: "read";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult>;
};

type ValidatedArguments = {
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
};

type ArgumentValidationResult =
  | { readonly ok: true; readonly value: ValidatedArguments }
  | { readonly ok: false; readonly result: ToolResult };

type PathFacts = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
};

type FileIdentity = {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
};

type LineScan = {
  readonly lines: readonly string[];
  readonly lineEnding: ReadLineEnding;
};

function fail(
  code: ReadErrorCode,
  message: string,
  details?: JsonObject,
): ToolResult {
  return {
    ok: false,
    error:
      details === undefined ? { code, message } : { code, message, details },
  };
}

function invalid(field: string): ToolResult {
  return fail("EINVAL", "Invalid read arguments.", { field });
}

function isIntegerNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function validateArguments(input: unknown): ArgumentValidationResult {
  if (!isRecord(input)) {
    return { ok: false, result: invalid("path") };
  }
  const extra = Object.keys(input).find(
    (key) => key !== "path" && key !== "offset" && key !== "limit",
  );
  if (extra !== undefined) {
    return { ok: false, result: invalid(extra) };
  }
  if (typeof input.path !== "string") {
    return { ok: false, result: invalid("path") };
  }
  if (input.offset !== undefined && !isIntegerNumber(input.offset)) {
    return { ok: false, result: invalid("offset") };
  }
  if (input.limit !== undefined && !isIntegerNumber(input.limit)) {
    return { ok: false, result: invalid("limit") };
  }
  if (input.offset !== undefined && input.offset < 1) {
    return {
      ok: false,
      result: fail("EINVAL_OFFSET", "offset must be a positive integer.", {
        field: "offset",
      }),
    };
  }
  if (
    input.limit !== undefined &&
    (input.limit < 1 || input.limit > READ_MAX_LINES)
  ) {
    return {
      ok: false,
      result: fail(
        "EINVAL_LIMIT",
        `limit must be an integer between 1 and ${READ_MAX_LINES}.`,
        { field: "limit" },
      ),
    };
  }
  return {
    ok: true,
    value: {
      path: input.path,
      offset: input.offset ?? 1,
      limit: input.limit ?? READ_MAX_LINES,
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
  if (error.code === "ENOENT") {
    return fail("ENOENT", "Path does not exist.", details);
  }
  if (error.code === "ELOOP") {
    return fail("ELOOP", "Path contains a symlink loop.", details);
  }
  if (error.code === "EACCES") {
    return fail("EACCES", "Path cannot be read.", details);
  }
  if (error.code === "EINVAL_PATH") {
    return fail("EINVAL_PATH", "Path syntax is invalid.", details);
  }
  return fail("EIO", "Path cannot be resolved.", details);
}

function fileIdentity(stats: Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function isTimeoutReason(reason: unknown): boolean {
  return (
    reason instanceof Error &&
    reason.name === "TimeoutError"
  );
}

function abortResult(signal: AbortSignal, details?: JsonObject): ToolResult {
  return isTimeoutReason(signal.reason)
    ? fail("ETIMEDOUT", "Read timed out.", details)
    : fail("ETOOL", "Tool execution failed.", details);
}

function mapObservedIoError(error: unknown, facts: PathFacts): ToolResult {
  const code = nodeErrorCode(error);
  if (code === "ENOENT") {
    return fail("ECONFLICT", "File changed during read.", facts);
  }
  if (code === "EACCES" || code === "EPERM") {
    return fail("EACCES", "File cannot be read.", facts);
  }
  if (code === "EISDIR") {
    return fail("EISDIR", "Path is a directory.", facts);
  }
  return fail("EIO", "File cannot be read.", facts);
}

function scanLines(text: string): LineScan {
  if (text.length === 0) {
    return { lines: [], lineEnding: "none" };
  }
  let hasLf = false;
  let hasCrlf = false;
  const lines: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }
    if (index > 0 && text[index - 1] === "\r") {
      hasCrlf = true;
    } else {
      hasLf = true;
    }
    lines.push(text.slice(start, index + 1));
    start = index + 1;
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  const lineEnding: ReadLineEnding =
    !hasLf && !hasCrlf
      ? "none"
      : hasLf && hasCrlf
        ? "mixed"
        : hasCrlf
          ? "crlf"
          : "lf";
  return { lines, lineEnding };
}

function finalizeReadResult(
  bounded: ToolResult,
  offset: number,
  recordCount: number,
): ToolResult {
  if (!bounded.ok) {
    return bounded;
  }
  const retainedLines = bounded.meta?.truncation?.retained.lines ?? recordCount;
  const range =
    retainedLines === 0
      ? null
      : { startLine: offset, endLine: offset + retainedLines - 1 };
  return normalizeToolResult({
    ...bounded,
    result: { ...bounded.result, range },
  });
}

export async function executeRead(
  input: unknown,
  options: ReadToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult> {
  const validated = validateArguments(input);
  if (!validated.ok) {
    return validated.result;
  }

  const timeoutMs = options.timeoutMs ?? READ_DEFAULT_TIMEOUT_MS;
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
  let identity: FileIdentity;
  try {
    const stats = await stat(facts.realTargetPath);
    if (stats.isDirectory()) {
      return fail("EISDIR", "Path is a directory.", facts);
    }
    if (!stats.isFile()) {
      return fail("EUNSUPPORTED", "Path is not a regular file.", facts);
    }
    if (stats.size > READ_MAX_FILE_BYTES) {
      return fail("EFILE_TOO_LARGE", "File exceeds the 100 MiB size limit.", {
        ...facts,
        actualBytes: stats.size,
        limitBytes: READ_MAX_FILE_BYTES,
      });
    }
    identity = fileIdentity(stats);
  } catch (error) {
    if (signal.aborted) {
      return abortResult(signal, facts);
    }
    return mapObservedIoError(error, facts);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(facts.realTargetPath, { signal });
  } catch (error) {
    if (signal.aborted) {
      return abortResult(signal, facts);
    }
    return mapObservedIoError(error, facts);
  }

  const decoded = decodeUtf8Text(bytes);
  if (!decoded.ok) {
    return fail("EBINARY", "File is not valid UTF-8 text.", facts);
  }

  if (signal.aborted) {
    return abortResult(signal, facts);
  }
  const afterResolution = await resolverResult.value.resolve(validated.value.path, {
    existence: "required",
    symlinks: "follow",
  });
  if (!afterResolution.ok) {
    return fail("ECONFLICT", "File changed during read.", facts);
  }
  try {
    const afterStats = await stat(afterResolution.value.realTargetPath);
    if (
      afterResolution.value.resolvedPath !== facts.resolvedPath ||
      afterResolution.value.realTargetPath !== facts.realTargetPath ||
      !sameIdentity(identity, fileIdentity(afterStats)) ||
      afterStats.size !== bytes.length
    ) {
      return fail("ECONFLICT", "File changed during read.", facts);
    }
  } catch {
    return fail("ECONFLICT", "File changed during read.", facts);
  }

  const { lines, lineEnding } = scanLines(decoded.text);
  if (lines.length === 0 && validated.value.offset > 1) {
    return fail("EINVAL_OFFSET", "offset is beyond the end of the file.", {
      ...facts,
      totalLines: 0,
    });
  }
  if (lines.length > 0 && validated.value.offset > lines.length) {
    return fail("EINVAL_OFFSET", "offset is beyond the end of the file.", {
      ...facts,
      totalLines: lines.length,
    });
  }

  const records = lines.slice(validated.value.offset - 1).map((line) => ({
    field: "content",
    value: line,
    lines: 1 as const,
  }));
  return finalizeReadResult(
    boundToolResult({
      result: {
        ...facts,
        totalLines: lines.length,
        sizeBytes: identity.size,
        bom: decoded.bom,
        lineEnding,
      },
      fields: [
        {
          name: "content",
          kind: "text",
          truncateOversizedRecords: true,
        },
      ],
      records,
      strategy: "head",
      limits: { lines: validated.value.limit },
      continuation({ firstOmittedRecordIndex }) {
        return firstOmittedRecordIndex === undefined
          ? undefined
          : {
              path: validated.value.path,
              offset: validated.value.offset + firstOmittedRecordIndex,
              limit: validated.value.limit,
            };
      },
    }),
    validated.value.offset,
    records.length,
  );
}

export function createReadTool(options: ReadToolOptions): ReadTool {
  return {
    name: "read",
    description: READ_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Absolute or Session-cwd-relative file path",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "1-based starting line number; defaults to 1",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: READ_MAX_LINES,
          description: "Maximum number of lines to return; defaults to 2000",
        },
      },
      required: ["path"],
    },
    execute(input, signal) {
      return executeRead(input, {
        ...options,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
