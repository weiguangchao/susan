import { isRecord, type JsonObject } from "@weiguangchao/susan-core";
import { type ToolResult } from "../tool-result";
import {
  DEFAULT_MAX_BYTES,
  GREP_MAX_LINE_LENGTH,
} from "../truncate";
import {
  DEFAULT_LIMIT,
  executeGrep as executeValidatedGrep,
  type GrepToolDetails,
  type GrepOperations,
  type GrepToolOptions,
  type GrepValidatedArguments,
} from "./execute";

export type { GrepToolDetails, GrepOperations, GrepToolOptions };

export const GREP_PROMPT_SNIPPET =
  "Search file contents for patterns (respects .gitignore)";
export const GREP_PROMPT_GUIDELINES = [] as const;

const GREP_DESCRIPTION =
  `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`;

export type GrepTool = {
  readonly name: "grep";
  readonly description: string;
  readonly parameters: JsonObject;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  execute(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResult<GrepToolDetails | undefined>>;
};

function validateArguments(input: unknown): GrepValidatedArguments {
  if (!isRecord(input)) {
    throw new Error("Invalid grep arguments.");
  }
  const extra = Object.keys(input).find(
    (key) =>
      key !== "pattern" &&
      key !== "path" &&
      key !== "glob" &&
      key !== "ignoreCase" &&
      key !== "literal" &&
      key !== "context" &&
      key !== "limit",
  );
  if (extra !== undefined) {
    throw new Error("Invalid grep arguments.");
  }
  if (typeof input.pattern !== "string") {
    throw new Error("Invalid grep arguments.");
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    throw new Error("Invalid grep arguments.");
  }
  if (input.glob !== undefined && typeof input.glob !== "string") {
    throw new Error("Invalid grep arguments.");
  }
  if (input.ignoreCase !== undefined && typeof input.ignoreCase !== "boolean") {
    throw new Error("Invalid grep arguments.");
  }
  if (input.literal !== undefined && typeof input.literal !== "boolean") {
    throw new Error("Invalid grep arguments.");
  }
  if (input.context !== undefined) {
    if (typeof input.context !== "number" || !Number.isFinite(input.context)) {
      throw new Error("Invalid grep arguments.");
    }
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isFinite(input.limit)) {
      throw new Error("Invalid grep arguments.");
    }
  }
  return {
    pattern: input.pattern,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.glob === undefined ? {} : { glob: input.glob }),
    ...(input.ignoreCase === undefined ? {} : { ignoreCase: input.ignoreCase }),
    ...(input.literal === undefined ? {} : { literal: input.literal }),
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

export async function executeGrep(
  input: unknown,
  options: GrepToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult<GrepToolDetails | undefined>> {
  return executeValidatedGrep(validateArguments(input), options);
}

export function createGrepTool(options: GrepToolOptions): GrepTool {
  return {
    name: "grep",
    description: GREP_DESCRIPTION,
    promptSnippet: GREP_PROMPT_SNIPPET,
    promptGuidelines: [...GREP_PROMPT_GUIDELINES],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description: "Search pattern (regex or literal string)",
        },
        path: {
          type: "string",
          description: "Directory or file to search (default: current directory)",
        },
        glob: {
          type: "string",
          description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
        },
        ignoreCase: {
          type: "boolean",
          description: "Case-insensitive search (default: false)",
        },
        literal: {
          type: "boolean",
          description: "Treat pattern as literal string instead of regex (default: false)",
        },
        context: {
          type: "number",
          description: "Number of lines to show before and after each match (default: 0)",
        },
        limit: {
          type: "number",
          description: "Maximum number of matches to return (default: 100)",
        },
      },
    },
    execute(input, signal) {
      return executeGrep(input, {
        ...options,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
