import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationQueue } from "./file-mutation-queue";
import { isRecord, type JsonObject } from "@weiguangchao/susan-core";
import { resolveToCwd } from "./path-utils";
import { type ToolResult } from "./tool-result";

export const WRITE_PROMPT_SNIPPET = "Create or overwrite files";
export const WRITE_PROMPT_GUIDELINES = [
  "Use write only for new files or complete rewrites.",
] as const;

const WRITE_DESCRIPTION =
  "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.";

export type WriteToolOptions = {
  readonly sessionCwd: string;
};

export type WriteTool = {
  readonly name: "write";
  readonly description: string;
  readonly parameters: JsonObject;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult<undefined>>;
};

type ValidatedArguments = {
  readonly path: string;
  readonly content: string;
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

export async function executeWrite(
  input: unknown,
  options: WriteToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult<undefined>> {
  const { path, content } = validateArguments(input);
  const absolutePath = resolveToCwd(path, options.sessionCwd);
  const dir = dirname(absolutePath);
  const signal = options.signal;

  return withFileMutationQueue(absolutePath, async () => {
    // Do not reject from an abort event listener here: that would release the
    // mutation queue while an in-flight filesystem operation may still finish.
    // Checking signal.aborted after each await observes the same aborts while
    // keeping the queue locked until the current operation has settled.
    throwIfAborted(signal);
    await mkdir(dir, { recursive: true });
    throwIfAborted(signal);
    await writeFile(absolutePath, content, "utf-8");
    throwIfAborted(signal);

    return {
      content: [{ type: "text", text: `Successfully wrote to ${path}` }],
      details: undefined,
    };
  });
}

export function createWriteTool(options: WriteToolOptions): WriteTool {
  return {
    name: "write",
    description: WRITE_DESCRIPTION,
    promptSnippet: WRITE_PROMPT_SNIPPET,
    promptGuidelines: [...WRITE_PROMPT_GUIDELINES],
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Path to the file to write (relative or absolute)",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
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
