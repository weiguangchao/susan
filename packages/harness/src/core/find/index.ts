import { isRecord, type JsonObject } from "@weiguangchao/susan-core";
import { type ToolResult } from "../tool-result";
import {
  DEFAULT_MAX_BYTES,
} from "../truncate";
import {
  DEFAULT_LIMIT,
  executeFind as executeValidatedFind,
  relativizeFindResultPath,
  type FindToolDetails,
  type FindOperations,
  type FindToolOptions,
  type FindValidatedArguments,
} from "./execute";

export type { FindToolDetails, FindOperations, FindToolOptions };
export { relativizeFindResultPath };

export const FIND_PROMPT_SNIPPET =
  "Find files by glob pattern (respects .gitignore)";
export const FIND_PROMPT_GUIDELINES = [] as const;

const FIND_DESCRIPTION =
  `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`;

export type FindTool = {
  readonly name: "find";
  readonly description: string;
  readonly parameters: JsonObject;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  execute(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolResult<FindToolDetails | undefined>>;
};

function validateArguments(input: unknown): FindValidatedArguments {
  if (!isRecord(input)) {
    throw new Error("Invalid find arguments.");
  }
  const extra = Object.keys(input).find(
    (key) => key !== "pattern" && key !== "path" && key !== "limit",
  );
  if (extra !== undefined) {
    throw new Error("Invalid find arguments.");
  }
  if (typeof input.pattern !== "string") {
    throw new Error("Invalid find arguments.");
  }
  if (input.path !== undefined && typeof input.path !== "string") {
    throw new Error("Invalid find arguments.");
  }
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isFinite(input.limit)) {
      throw new Error("Invalid find arguments.");
    }
  }
  return {
    pattern: input.pattern,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  };
}

export async function executeFind(
  input: unknown,
  options: FindToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult<FindToolDetails | undefined>> {
  return executeValidatedFind(validateArguments(input), options);
}

export function createFindTool(options: FindToolOptions): FindTool {
  return {
    name: "find",
    description: FIND_DESCRIPTION,
    promptSnippet: FIND_PROMPT_SNIPPET,
    promptGuidelines: [...FIND_PROMPT_GUIDELINES],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description:
            "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
        },
        path: {
          type: "string",
          description: "Directory to search in (default: current directory)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 1000)",
        },
      },
    },
    execute(input, signal) {
      return executeFind(input, {
        ...options,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
