import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  observeReplacementTarget,
  replaceFile,
  type FileReplacementError,
  type FileReplacementHooks,
} from "./file-replacement.js";
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
  type ToolResult,
} from "./tool-result.js";

export const WRITE_MAX_CONTENT_BYTES = 10 * 1024 * 1024;
export const WRITE_DEFAULT_TIMEOUT_MS = 10_000;

const WRITE_DESCRIPTION =
  "Create or completely overwrite a UTF-8 regular file. Missing parent directories are created recursively. Content is written exactly without appending a newline or converting line endings. Final symlinks, directories, special files, binary content, and content over 10 MiB are rejected.";

export type WriteLineEnding = "lf" | "crlf" | "mixed" | "none";

export type WriteErrorCode =
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
  | "ECONFLICT"
  | "ESYMLINK"
  | "ETIMEDOUT"
  | "ETOOL";

export type WriteToolOptions = {
  readonly sessionCwd: string;
  readonly timeoutMs?: number;
  readonly replacementHooks?: FileReplacementHooks;
};

export type WriteTool = {
  readonly name: "write";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult>;
};

type ValidatedArguments = {
  readonly path: string;
  readonly content: string;
};

type PathFacts = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
};

function fail(
  code: WriteErrorCode,
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
  return fail("EINVAL", "Invalid write arguments.", { field });
}

function validateArguments(input: unknown):
  | { readonly ok: true; readonly value: ValidatedArguments }
  | { readonly ok: false; readonly result: ToolResult } {
  if (!isRecord(input)) {
    return { ok: false, result: invalid("path") };
  }
  const extra = Object.keys(input).find(
    (key) => key !== "path" && key !== "content",
  );
  if (extra !== undefined) {
    return { ok: false, result: invalid(extra) };
  }
  if (typeof input.path !== "string") {
    return { ok: false, result: invalid("path") };
  }
  if (typeof input.content !== "string") {
    return { ok: false, result: invalid("content") };
  }
  return {
    ok: true,
    value: { path: input.path, content: input.content },
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
  const messages: Record<PathResolutionError["code"], string> = {
    EINVAL_PATH: "Path syntax is invalid.",
    ENOENT: "Path does not exist.",
    ELOOP: "Path contains a symlink loop.",
    EACCES: "Path cannot be written.",
    EIO: "Path cannot be resolved.",
    ESYMLINK: "Final path component is a symlink.",
  };
  return fail(error.code, messages[error.code], details);
}

function mapReplacementError(
  error: FileReplacementError,
  facts: PathFacts,
): ToolResult {
  return fail(error.code, error.message, {
    ...facts,
    ...error.details,
  });
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function abortResult(signal: AbortSignal, details?: JsonObject): ToolResult {
  return isTimeoutReason(signal.reason)
    ? fail("ETIMEDOUT", "Write timed out.", details)
    : fail("ETOOL", "Tool execution failed.", details);
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function mapDirectoryError(error: unknown, facts: PathFacts): ToolResult {
  const code = nodeErrorCode(error);
  return code === "EACCES" || code === "EPERM"
    ? fail("EACCES", "Parent directory cannot be created.", facts)
    : code === "ENOENT"
      ? fail("ENOENT", "Parent directory does not exist.", facts)
      : fail("EIO", "Parent directory cannot be created.", facts);
}

function detectLineEnding(content: string): WriteLineEnding {
  let hasLf = false;
  let hasCrlf = false;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== "\n") {
      continue;
    }
    if (index > 0 && content[index - 1] === "\r") {
      hasCrlf = true;
    } else {
      hasLf = true;
    }
  }
  return !hasLf && !hasCrlf
    ? "none"
    : hasLf && hasCrlf
      ? "mixed"
      : hasCrlf
        ? "crlf"
        : "lf";
}

function isWellFormedUnicode(content: string): boolean {
  for (let index = 0; index < content.length; index += 1) {
    const codeUnit = content.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export async function executeWrite(
  input: unknown,
  options: WriteToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult> {
  const validated = validateArguments(input);
  if (!validated.ok) {
    return validated.result;
  }

  const timeout = AbortSignal.timeout(
    options.timeoutMs ?? WRITE_DEFAULT_TIMEOUT_MS,
  );
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
    existence: "allow-missing",
    symlinks: "reject-final",
  });
  if (signal.aborted) {
    return abortResult(signal);
  }
  if (!resolved.ok) {
    return mapPathError(resolved.error);
  }
  const facts = pathFacts(resolved.value);

  const observed = await observeReplacementTarget(facts.realTargetPath);
  if (signal.aborted) {
    return abortResult(signal, facts);
  }
  if (!observed.ok) {
    return mapReplacementError(observed.error, facts);
  }

  const contents = Buffer.from(validated.value.content, "utf8");
  if (contents.byteLength > WRITE_MAX_CONTENT_BYTES) {
    return fail("EFILE_TOO_LARGE", "Content exceeds the 10 MiB size limit.", {
      ...facts,
      actualBytes: contents.byteLength,
      limitBytes: WRITE_MAX_CONTENT_BYTES,
    });
  }
  if (
    validated.value.content.includes("\0") ||
    !isWellFormedUnicode(validated.value.content)
  ) {
    return fail(
      "EBINARY",
      "Content must be valid UTF-8 text without NUL bytes.",
      facts,
    );
  }

  let successResult: ToolResult;
  try {
    successResult = boundToolResult({
      result: {
        ...facts,
        operation: observed.value.exists ? "overwritten" : "created",
        bytesWritten: contents.byteLength,
        bom: validated.value.content.startsWith("\uFEFF"),
        lineEnding: detectLineEnding(validated.value.content),
        detachedHardLinks:
          observed.value.exists && observed.value.identity.nlink > 1,
      },
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

  try {
    await mkdir(dirname(facts.realTargetPath), { recursive: true });
  } catch (error) {
    return mapDirectoryError(error, facts);
  }
  if (signal.aborted) {
    return abortResult(signal, facts);
  }

  const replaced = await replaceFile({
    targetPath: facts.realTargetPath,
    contents,
    baseline: observed.value,
    signal,
    ...(options.replacementHooks === undefined
      ? {}
      : { hooks: options.replacementHooks }),
  });
  if (!replaced.ok) {
    return mapReplacementError(replaced.error, facts);
  }
  return successResult;
}

export function createWriteTool(options: WriteToolOptions): WriteTool {
  return {
    name: "write",
    description: WRITE_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Absolute or Session-cwd-relative file path",
        },
        content: {
          type: "string",
          description: "Complete UTF-8 file content",
        },
      },
      required: ["path", "content"],
    },
    execute(input, signal) {
      return executeWrite(input, {
        ...options,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
