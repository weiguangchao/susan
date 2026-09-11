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
import { type ToolResult } from "./tool-result.js";

export const READ_MAX_LINES = 2000;
export const READ_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const READ_DEFAULT_TIMEOUT_MS = 10_000;

const READ_DESCRIPTION =
  "Read a known UTF-8 regular file, optionally from a 1-based line offset with a line limit. Use read instead of bash or cat when inspecting file contents. It reports file and path facts together with the confirmed content. Large results may be truncated; use nextArguments only when the omitted content is relevant. It does not list directories or read binary and special files.";

export type ReadLineEnding = LineEnding;

export type ReadToolOptions = {
  readonly sessionCwd: string;
  readonly timeoutMs?: number;
};

export type ReadToolDetails = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
  readonly totalLines: number;
  readonly sizeBytes: number;
  readonly bom: boolean;
  readonly lineEnding: ReadLineEnding;
  readonly range: {
    readonly startLine: number;
    readonly endLine: number;
  } | null;
  readonly truncation?: {
    readonly truncatedBy: "lines";
    readonly totalLines: number;
    readonly outputLines: number;
    readonly nextOffset: number;
  };
};

export type ReadTool = {
  readonly name: "read";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult<ReadToolDetails>>;
};

type ValidatedArguments = {
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
};

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

function isIntegerNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function validateArguments(input: unknown): ValidatedArguments {
  if (!isRecord(input)) {
    throw new Error("Invalid read arguments.");
  }
  const extra = Object.keys(input).find(
    (key) => key !== "path" && key !== "offset" && key !== "limit",
  );
  if (extra !== undefined) {
    throw new Error("Invalid read arguments.");
  }
  if (typeof input.path !== "string") {
    throw new Error("Invalid read arguments.");
  }
  if (input.offset !== undefined && !isIntegerNumber(input.offset)) {
    throw new Error("Invalid read arguments.");
  }
  if (input.limit !== undefined && !isIntegerNumber(input.limit)) {
    throw new Error("Invalid read arguments.");
  }
  if (input.offset !== undefined && input.offset < 1) {
    throw new Error("offset must be a positive integer.");
  }
  if (
    input.limit !== undefined &&
    (input.limit < 1 || input.limit > READ_MAX_LINES)
  ) {
    throw new Error(
      `limit must be an integer between 1 and ${READ_MAX_LINES}.`,
    );
  }
  return {
    path: input.path,
    offset: input.offset ?? 1,
    limit: input.limit ?? READ_MAX_LINES,
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
  if (error.code === "ENOENT") {
    throw new Error("Path does not exist.");
  }
  if (error.code === "ELOOP") {
    throw new Error("Path contains a symlink loop.");
  }
  if (error.code === "EACCES") {
    throw new Error("Path cannot be read.");
  }
  if (error.code === "EINVAL_PATH") {
    throw new Error("Path syntax is invalid.");
  }
  throw new Error("Path cannot be resolved.");
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

function abortResult(signal: AbortSignal): never {
  if (isTimeoutReason(signal.reason)) {
    throw new Error("Read timed out.");
  }
  throw new Error("Tool execution failed.");
}

function mapObservedIoError(error: unknown): never {
  const code = nodeErrorCode(error);
  if (code === "ENOENT") {
    throw new Error("File changed during read.");
  }
  if (code === "EACCES" || code === "EPERM") {
    throw new Error("File cannot be read.");
  }
  if (code === "EISDIR") {
    throw new Error("Path is a directory.");
  }
  throw new Error("File cannot be read.");
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

export async function executeRead(
  input: unknown,
  options: ReadToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult<ReadToolDetails>> {
  const validated = validateArguments(input);

  const timeoutMs = options.timeoutMs ?? READ_DEFAULT_TIMEOUT_MS;
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
  let identity: FileIdentity;
  let stats: Stats;
  try {
    stats = await stat(facts.realTargetPath);
  } catch (error) {
    if (signal.aborted) {
      abortResult(signal);
    }
    mapObservedIoError(error);
  }
  if (stats.isDirectory()) {
    throw new Error("Path is a directory.");
  }
  if (!stats.isFile()) {
    throw new Error("Path is not a regular file.");
  }
  if (stats.size > READ_MAX_FILE_BYTES) {
    throw new Error("File exceeds the 100 MiB size limit.");
  }
  identity = fileIdentity(stats);

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
    throw new Error("File is not valid UTF-8 text.");
  }

  if (signal.aborted) {
    abortResult(signal);
  }
  const afterResolution = await resolverResult.value.resolve(validated.path, {
    existence: "required",
    symlinks: "follow",
  });
  if (!afterResolution.ok) {
    throw new Error("File changed during read.");
  }
  try {
    const afterStats = await stat(afterResolution.value.realTargetPath);
    if (
      afterResolution.value.resolvedPath !== facts.resolvedPath ||
      afterResolution.value.realTargetPath !== facts.realTargetPath ||
      !sameIdentity(identity, fileIdentity(afterStats)) ||
      afterStats.size !== bytes.length
    ) {
      throw new Error("File changed during read.");
    }
  } catch {
    throw new Error("File changed during read.");
  }

  const { lines, lineEnding } = scanLines(decoded.text);
  if (lines.length === 0 && validated.offset > 1) {
    throw new Error("offset is beyond the end of the file.");
  }
  if (lines.length > 0 && validated.offset > lines.length) {
    throw new Error("offset is beyond the end of the file.");
  }

  const selected = lines.slice(validated.offset - 1);
  const retained = selected.slice(0, validated.limit);
  const remaining = selected.length - retained.length;
  const outputLines = retained.length;
  const nextOffset = validated.offset + outputLines;
  const base = retained.join("");
  const outputText =
    remaining > 0
      ? `${base}${base.endsWith("\n") ? "" : "\n"}\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`
      : base;
  const details: ReadToolDetails = {
    ...facts,
    totalLines: lines.length,
    sizeBytes: identity.size,
    bom: decoded.bom,
    lineEnding,
    range:
      outputLines === 0
        ? null
        : { startLine: validated.offset, endLine: nextOffset - 1 },
    ...(remaining > 0
      ? {
          truncation: {
            truncatedBy: "lines" as const,
            totalLines: selected.length,
            outputLines,
            nextOffset,
          },
        }
      : {}),
  };
  return {
    content: [{ type: "text", text: outputText }],
    details,
  };
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
