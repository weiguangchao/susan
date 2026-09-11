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
  detectLineEnding,
  isWellFormedUnicode,
  type LineEnding,
} from "./text-file.js";
import { type ToolResult } from "./tool-result.js";

export const WRITE_MAX_CONTENT_BYTES = 10 * 1024 * 1024;
export const WRITE_DEFAULT_TIMEOUT_MS = 10_000;

const WRITE_DESCRIPTION =
  "Create or completely replace a UTF-8 regular file, creating missing parent directories when needed. Use write for new files or intentional whole-file replacement; use edit for precise changes to an existing file. Content is written exactly, without implicit append, newline, or permission changes. The operation rejects a final symlink and reports whether it created or overwrote the target.";

export type WriteLineEnding = LineEnding;

export type WriteToolOptions = {
  readonly sessionCwd: string;
  readonly timeoutMs?: number;
  readonly replacementHooks?: FileReplacementHooks;
};

export type WriteToolDetails = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
  readonly operation: "created" | "overwritten";
  readonly bytesWritten: number;
  readonly bom: boolean;
  readonly lineEnding: WriteLineEnding;
  readonly detachedHardLinks: boolean;
};

export type WriteTool = {
  readonly name: "write";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult<WriteToolDetails>>;
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

function validateArguments(input: unknown): ValidatedArguments {
  if (!isRecord(input)) {
    throw new Error("Invalid write arguments.");
  }
  const extra = Object.keys(input).find(
    (key) => key !== "path" && key !== "content",
  );
  if (extra !== undefined) {
    throw new Error("Invalid write arguments.");
  }
  if (typeof input.path !== "string") {
    throw new Error("Invalid write arguments.");
  }
  if (typeof input.content !== "string") {
    throw new Error("Invalid write arguments.");
  }
  return { path: input.path, content: input.content };
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
    throw new Error("Path cannot be written.");
  }
  if (error.code === "EINVAL_PATH") {
    throw new Error("Path syntax is invalid.");
  }
  if (error.code === "ESYMLINK") {
    throw new Error("Final path component is a symlink.");
  }
  throw new Error("Path cannot be resolved.");
}

function mapReplacementError(
  error: FileReplacementError,
  _facts: PathFacts,
): never {
  throw new Error(error.message);
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function abortResult(signal: AbortSignal): never {
  if (isTimeoutReason(signal.reason)) {
    throw new Error("Write timed out.");
  }
  throw new Error("Tool execution failed.");
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function mapDirectoryError(error: unknown): never {
  const code = nodeErrorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    throw new Error("Parent directory cannot be created.");
  }
  if (code === "ENOENT") {
    throw new Error("Parent directory does not exist.");
  }
  throw new Error("Parent directory cannot be created.");
}

export async function executeWrite(
  input: unknown,
  options: WriteToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult<WriteToolDetails>> {
  const validated = validateArguments(input);

  const timeout = AbortSignal.timeout(
    options.timeoutMs ?? WRITE_DEFAULT_TIMEOUT_MS,
  );
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
    existence: "allow-missing",
    symlinks: "reject-final",
  });
  if (signal.aborted) {
    abortResult(signal);
  }
  if (!resolved.ok) {
    mapPathError(resolved.error);
  }
  const facts = pathFacts(resolved.value);

  const observed = await observeReplacementTarget(facts.realTargetPath);
  if (signal.aborted) {
    abortResult(signal);
  }
  if (!observed.ok) {
    mapReplacementError(observed.error, facts);
  }

  const contents = Buffer.from(validated.content, "utf8");
  if (contents.byteLength > WRITE_MAX_CONTENT_BYTES) {
    throw new Error("Content exceeds the 10 MiB size limit.");
  }
  if (
    validated.content.includes("\0") ||
    !isWellFormedUnicode(validated.content)
  ) {
    throw new Error("Content must be valid UTF-8 text without NUL bytes.");
  }

  const details: WriteToolDetails = {
    ...facts,
    operation: observed.value.exists ? "overwritten" : "created",
    bytesWritten: contents.byteLength,
    bom: validated.content.startsWith("\uFEFF"),
    lineEnding: detectLineEnding(validated.content),
    detachedHardLinks:
      observed.value.exists && observed.value.identity.nlink > 1,
  };

  try {
    await mkdir(dirname(facts.realTargetPath), { recursive: true });
  } catch (error) {
    mapDirectoryError(error);
  }
  if (signal.aborted) {
    abortResult(signal);
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
    mapReplacementError(replaced.error, facts);
  }
  return {
    content: [{ type: "text", text: `Successfully wrote to ${facts.resolvedPath}` }],
    details,
  };
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
