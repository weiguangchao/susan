import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { JsonObject } from "./json.js";

export const READ_FILE_MAX_LINES = 2000;
export const READ_FILE_MAX_BYTES = 50 * 1024;
export const READ_FILE_MAX_LINE_CHARACTERS = 2000;

const BINARY_CHECK_BYTES = 8192;
const READ_CHUNK_BYTES = 64 * 1024;

export type ReadFileErrorCode =
  | "EINVAL_PATH"
  | "ENOENT"
  | "EACCES"
  | "EISDIR"
  | "EBINARY"
  | "EINVAL_OFFSET"
  | "EINVAL_LIMIT"
  | "EREAD";

export type ReadFileTruncationReason =
  | "lines"
  | "bytes"
  | "lineLength";

export type ReadFileSuccess = {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly truncated: boolean;
  readonly truncatedBy: ReadFileTruncationReason | null;
  readonly nextOffset: number | null;
  readonly truncatedLineCount: number;
  readonly content: string;
};

export type ReadFileError = {
  readonly code: ReadFileErrorCode;
  readonly message: string;
  readonly path?: string;
};

export type ReadFileToolResult =
  | { readonly ok: true; readonly result: ReadFileSuccess }
  | { readonly ok: false; readonly error: ReadFileError };

export type ReadFileTool = {
  readonly name: "read_file";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown): Promise<ReadFileToolResult>;
};

type ValidatedArguments = {
  readonly path: string;
  readonly offset: number;
  readonly limit: number;
};

type ArgumentValidationResult =
  | { readonly ok: true; readonly arguments: ValidatedArguments }
  | { readonly ok: false; readonly error: ReadFileError };

type LineState = {
  readonly decoder: TextDecoder;
  text: string;
  truncated: boolean;
};

class InvalidUtf8Error extends Error {}

function errorResult(
  code: ReadFileErrorCode,
  message: string,
  path?: string,
): { readonly ok: false; readonly error: ReadFileError } {
  return {
    ok: false,
    error: path === undefined ? { code, message } : { code, message, path },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateArguments(input: unknown): ArgumentValidationResult {
  if (!isRecord(input)) {
    return errorResult(
      "EINVAL_PATH",
      "path must be a non-empty string",
    );
  }

  const { path, offset, limit } = input;
  if (typeof path !== "string" || path.length === 0) {
    return errorResult("EINVAL_PATH", "path must be a non-empty string");
  }

  const resolvedOffset = offset === undefined ? 1 : offset;
  if (
    typeof resolvedOffset !== "number" ||
    !Number.isInteger(resolvedOffset) ||
    resolvedOffset < 1
  ) {
    return errorResult(
      "EINVAL_OFFSET",
      "offset must be a positive integer",
      path,
    );
  }

  const resolvedLimit = limit === undefined ? READ_FILE_MAX_LINES : limit;
  if (
    typeof resolvedLimit !== "number" ||
    !Number.isInteger(resolvedLimit) ||
    resolvedLimit < 1 ||
    resolvedLimit > READ_FILE_MAX_LINES
  ) {
    return errorResult(
      "EINVAL_LIMIT",
      `limit must be an integer between 1 and ${READ_FILE_MAX_LINES}`,
      path,
    );
  }

  return {
    ok: true,
    arguments: { path, offset: resolvedOffset, limit: resolvedLimit },
  };
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;
}

function fileSystemErrorResult(
  error: unknown,
  path: string,
): ReadFileToolResult {
  const code = nodeErrorCode(error);

  if (code === "ENOENT") {
    return errorResult("ENOENT", "File does not exist", path);
  }
  if (code === "EACCES" || code === "EPERM") {
    return errorResult("EACCES", "File cannot be read", path);
  }
  if (code === "EISDIR") {
    return errorResult("EISDIR", "Path is a directory", path);
  }

  const message = error instanceof Error ? error.message : "Unable to read file";
  return errorResult("EREAD", message, path);
}

function createLineState(): LineState {
  return {
    decoder: new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }),
    text: "",
    truncated: false,
  };
}

function decodeLineBytes(state: LineState, bytes: Uint8Array): void {
  try {
    const decoded = state.decoder.decode(bytes, { stream: true });
    if (state.truncated) {
      return;
    }

    state.text += decoded;
    if (state.text.length > READ_FILE_MAX_LINE_CHARACTERS) {
      state.text = state.text.slice(0, READ_FILE_MAX_LINE_CHARACTERS);
      state.truncated = true;
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new InvalidUtf8Error(error.message);
    }
    throw error;
  }
}

function finishLineState(state: LineState): string {
  try {
    const decoded = state.decoder.decode();
    if (!state.truncated) {
      state.text += decoded;
      if (state.text.length > READ_FILE_MAX_LINE_CHARACTERS) {
        state.text = state.text.slice(0, READ_FILE_MAX_LINE_CHARACTERS);
        state.truncated = true;
      }
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new InvalidUtf8Error(error.message);
    }
    throw error;
  }

  return state.text;
}

function successResult(
  path: string,
  startLine: number,
  endLine: number,
  truncated: boolean,
  truncatedBy: ReadFileTruncationReason | null,
  truncatedLineCount: number,
  content: string,
): ReadFileToolResult {
  return {
    ok: true,
    result: {
      path,
      startLine,
      endLine,
      truncated,
      truncatedBy,
      nextOffset: truncated ? endLine + 1 : null,
      truncatedLineCount,
      content,
    },
  };
}

async function hasMoreFileBytes(file: FileHandle): Promise<boolean> {
  const probe = Buffer.alloc(1);
  const { bytesRead } = await file.read(probe, 0, 1, null);
  return bytesRead > 0;
}

async function readFileFromHandle(
  file: FileHandle,
  path: string,
  offset: number,
  limit: number,
): Promise<ReadFileToolResult> {
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let bytesChecked = 0;
  let currentLine = 1;
  let includedLineCount = 0;
  let contentParts: string[] = [];
  let contentBytes = 0;
  let endLine = offset - 1;
  let truncated = false;
  let truncatedBy: ReadFileTruncationReason | null = null;
  let truncatedLineCount = 0;
  let lineState: LineState | null = null;
  let hasPendingLine = false;

  const shouldReadCurrentLine = () =>
    currentLine >= offset && includedLineCount < limit;

  while (true) {
    const { bytesRead } = await file.read(chunk, 0, READ_CHUNK_BYTES, null);
    if (bytesRead === 0) {
      break;
    }

    const data = chunk.subarray(0, bytesRead);
    const binaryCheckLength = Math.min(
      bytesRead,
      Math.max(0, BINARY_CHECK_BYTES - bytesChecked),
    );
    if (data.subarray(0, binaryCheckLength).includes(0)) {
      return errorResult("EBINARY", "File is not UTF-8 text", path);
    }
    bytesChecked += bytesRead;

    let start = 0;
    while (true) {
      const newlineIndex = data.indexOf(0x0a, start);
      if (newlineIndex === -1) {
        break;
      }
      hasPendingLine = false;

      const lineBytes = data.subarray(start, newlineIndex);
      if (shouldReadCurrentLine()) {
        if (lineState === null) {
          lineState = createLineState();
        }
        decodeLineBytes(lineState, lineBytes);

        const lineText = finishLineState(lineState);
        const candidate = `${lineText}\n`;
        const candidateBytes = Buffer.byteLength(candidate, "utf8");

        if (contentBytes + candidateBytes > READ_FILE_MAX_BYTES) {
          return successResult(
            path,
            offset,
            endLine,
            true,
            "bytes",
            truncatedLineCount,
            contentParts.join(""),
          );
        }

        contentParts.push(candidate);
        contentBytes += candidateBytes;
        endLine = currentLine;
        includedLineCount += 1;

        if (lineState.truncated) {
          truncated = true;
          truncatedBy ??= "lineLength";
          truncatedLineCount += 1;
        }

        if (includedLineCount === limit) {
          const remainingInChunk = data.length - (newlineIndex + 1);
          const moreLines =
            remainingInChunk > 0 || (await hasMoreFileBytes(file));
          return successResult(
            path,
            offset,
            endLine,
            truncated || moreLines,
            moreLines ? "lines" : truncatedBy,
            truncatedLineCount,
            contentParts.join(""),
          );
        }
      }

      lineState = null;
      currentLine += 1;
      start = newlineIndex + 1;
    }

    const remaining = data.subarray(start);
    if (remaining.length > 0) {
      hasPendingLine = true;
      if (shouldReadCurrentLine()) {
        if (lineState === null) {
          lineState = createLineState();
        }
        decodeLineBytes(lineState, remaining);
      }
    }
  }

  if (hasPendingLine) {
    if (shouldReadCurrentLine()) {
      const lineText = lineState ? finishLineState(lineState) : "";
      const candidate = lineText;
      const candidateBytes = Buffer.byteLength(candidate, "utf8");

      if (contentBytes + candidateBytes > READ_FILE_MAX_BYTES) {
        return successResult(
          path,
          offset,
          endLine,
          true,
          "bytes",
          truncatedLineCount,
          contentParts.join(""),
        );
      }

      contentParts.push(candidate);
      contentBytes += candidateBytes;
      endLine = currentLine;
      includedLineCount += 1;

      if (lineState?.truncated) {
        truncated = true;
        truncatedBy ??= "lineLength";
        truncatedLineCount += 1;
      }
    }
    currentLine += 1;
  }

  if (currentLine <= offset) {
    return errorResult(
      "EINVAL_OFFSET",
      "offset is beyond the end of the file",
      path,
    );
  }

  return successResult(
    path,
    offset,
    endLine,
    truncated,
    truncatedBy,
    truncatedLineCount,
    contentParts.join(""),
  );
}

export async function executeReadFile(
  input: unknown,
): Promise<ReadFileToolResult> {
  const validated = validateArguments(input);
  if (!validated.ok) {
    return validated;
  }

  const path = resolve(validated.arguments.path);
  let file: FileHandle | undefined;
  try {
    file = await open(path, "r");
    return await readFileFromHandle(
      file,
      path,
      validated.arguments.offset,
      validated.arguments.limit,
    );
  } catch (error) {
    if (error instanceof InvalidUtf8Error) {
      return errorResult("EBINARY", "File is not valid UTF-8", path);
    }
    return fileSystemErrorResult(error, path);
  } finally {
    await file?.close();
  }
}

export const readFileTool: ReadFileTool = {
  name: "read_file",
  description: "Read a UTF-8 text file.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or cwd-relative file path",
      },
      offset: {
        type: "integer",
        minimum: 1,
        description: "1-based starting line number",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: READ_FILE_MAX_LINES,
        description: "Maximum number of lines to read",
      },
    },
    required: ["path"],
  },
  execute: executeReadFile,
};
