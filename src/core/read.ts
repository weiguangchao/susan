import { processImage } from "./image-process.js";
import { detectSupportedImageMimeTypeFromFile } from "./mime.js";
import type { ToolExecutionContext } from "./provider.js";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { isRecord, type JsonObject } from "./json.js";
import { resolveReadPathAsync } from "./path-utils.js";
import { type ToolResult } from "./tool-result.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";

export const READ_PROMPT_SNIPPET = "Read file contents";
export const READ_PROMPT_GUIDELINES = [
  "Use read to examine files instead of cat or sed.",
] as const;

const READ_DESCRIPTION =
  `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`;

export type ReadToolOptions = {
  readonly sessionCwd: string;
  readonly autoResizeImages?: boolean;
};

export type ReadToolDetails = {
  readonly truncation?: TruncationResult;
};

export type ReadTool = {
  readonly name: "read";
  readonly description: string;
  readonly parameters: JsonObject;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  execute(
    input: unknown,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ): Promise<ToolResult<ReadToolDetails | undefined>>;
};

type ValidatedArguments = {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
  if (input.offset !== undefined && !isFiniteNumber(input.offset)) {
    throw new Error("Invalid read arguments.");
  }
  if (input.limit !== undefined && !isFiniteNumber(input.limit)) {
    throw new Error("Invalid read arguments.");
  }
  return {
    path: input.path,
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

export async function executeRead(
  input: unknown,
  options: ReadToolOptions & { readonly signal?: AbortSignal; readonly context?: ToolExecutionContext },
): Promise<ToolResult<ReadToolDetails | undefined>> {
  const { path, offset, limit } = validateArguments(input);
  const signal = options.signal;
  throwIfAborted(signal);

  try {
    const absolutePath = await resolveReadPathAsync(path, options.sessionCwd);
    throwIfAborted(signal);
    await access(absolutePath, constants.R_OK);
    throwIfAborted(signal);
    const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
    throwIfAborted(signal);
    const buffer = await readFile(
      absolutePath,
      signal === undefined ? {} : { signal },
    );
    throwIfAborted(signal);

    if (mimeType) {
      const processed = await processImage(buffer, mimeType, { autoResizeImages: options.autoResizeImages });
      throwIfAborted(signal);
      let text = `Read image file [${processed.ok ? processed.mimeType : mimeType}]`;
      if (processed.ok && processed.hints.length) text += `\n${processed.hints.join("\n")}`;
      if (!processed.ok) text += `\n${processed.message}`;
      if (options.context?.modelInput && !options.context.modelInput.includes("image")) {
        text += "\n[Current model does not support images. The image will be omitted from this request.]";
      }
      return {
        content: processed.ok
          ? [{ type: "text", text }, { type: "image", data: processed.data, mimeType: processed.mimeType }]
          : [{ type: "text", text }],
        details: undefined,
      };
    }

    const textContent = buffer.toString("utf-8");
    const allLines = textContent.split("\n");
    const totalFileLines = allLines.length;
    const startLine = offset ? Math.max(0, offset - 1) : 0;
    const startLineDisplay = startLine + 1;
    if (startLine >= allLines.length) {
      throw new Error(
        `Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
      );
    }

    let selectedContent: string;
    let userLimitedLines: number | undefined;
    if (limit !== undefined) {
      const endLine = Math.min(startLine + limit, allLines.length);
      selectedContent = allLines.slice(startLine, endLine).join("\n");
      userLimitedLines = endLine - startLine;
    } else {
      selectedContent = allLines.slice(startLine).join("\n");
    }

    const truncation = truncateHead(selectedContent);
    let outputText: string;
    let details: ReadToolDetails | undefined;
    if (truncation.firstLineExceedsLimit) {
      const firstLineSize = formatSize(
        Buffer.byteLength(allLines[startLine] ?? "", "utf-8"),
      );
      outputText =
        `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
      details = { truncation };
    } else if (truncation.truncated) {
      const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
      const nextOffset = endLineDisplay + 1;
      outputText = truncation.content;
      if (truncation.truncatedBy === "lines") {
        outputText +=
          `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText +=
          `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
      }
      details = { truncation };
    } else if (
      userLimitedLines !== undefined &&
      startLine + userLimitedLines < allLines.length
    ) {
      const remaining = allLines.length - (startLine + userLimitedLines);
      const nextOffset = startLine + userLimitedLines + 1;
      outputText =
        `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText = truncation.content;
    }

    return {
      content: [{ type: "text", text: outputText }],
      details,
    };
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
}

export function createReadTool(options: ReadToolOptions): ReadTool {
  return {
    name: "read",
    description: READ_DESCRIPTION,
    promptSnippet: READ_PROMPT_SNIPPET,
    promptGuidelines: [...READ_PROMPT_GUIDELINES],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Path to the file to read (relative or absolute)",
        },
        offset: {
          type: "number",
          description: "Line number to start reading from (1-indexed)",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to read",
        },
      },
      required: ["path"],
    },
    execute(input, signal, context) {
      return executeRead(input, {
        ...options,
        context,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
