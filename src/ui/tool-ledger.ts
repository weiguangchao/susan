import { posix, win32 } from "node:path";
import { isRecord } from "../core/json.js";
import type { ProviderToolCall } from "../core/provider.js";
import {
  toolResultText,
  type ToolResult,
} from "../core/tool-result.js";

export type TuiToolStatus =
  | "requested"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

export type TuiToolCard = {
  readonly id: string;
  readonly name: string;
  readonly invocationLabel: string;
  readonly streamIndex?: number;
  readonly argumentsText?: string;
  readonly status: TuiToolStatus;
  readonly summary: string;
  readonly supplementalLines: readonly string[];
};

export type TuiToolResultRow = {
  readonly text: string;
  readonly gap: boolean;
};

export const TOOL_RESULT_ROW_BUDGET = 4;

export function toolResultRows(tool: TuiToolCard): readonly TuiToolResultRow[] {
  const lines = tool.supplementalLines
    .flatMap((line) => line.split("\n"))
    .filter(line => line.trim() !== "");
  if (lines.length <= TOOL_RESULT_ROW_BUDGET) {
    return lines.map((text) => ({ text, gap: false }));
  }
  return [
    ...lines.slice(0, TOOL_RESULT_ROW_BUDGET).map((text) => ({ text, gap: false })),
    { text: `…其余 ${lines.length - TOOL_RESULT_ROW_BUDGET} 行省略`, gap: true },
  ];
}

type ToolPresenter = {
  readonly summary: (
    result: ToolResult,
    payload: Record<string, unknown> | undefined,
  ) => string;
  readonly errorSummary?: (
    result: ToolResult,
    payload: Record<string, unknown> | undefined,
  ) => string;
  readonly invocationLabel?: (
    arguments_: Record<string, unknown>,
    path: string,
  ) => string;
  readonly supplementalLines?: (
    result: ToolResult,
    payload: Record<string, unknown> | undefined,
  ) => readonly string[];
  readonly failurePrefix?: (
    payload: Record<string, unknown> | undefined,
  ) => string;
  readonly hiddenFailureFields?: readonly string[];
};

const toolPresenters: Readonly<Record<string, ToolPresenter>> = {
  read: {
    summary: readSummary,
    supplementalLines: (result) => {
      const content = toolResultText(result.content);
      return content === "" ? ["空文件"] : content.split("\n");
    },
  },
  write: {
    summary: (result) => {
      const text = toolResultText(result.content);
      return text === "" ? "completed" : text;
    },
  },
  edit: {
    summary: (result) => toolResultText(result.content) || "completed",
    supplementalLines: (result, payload) => {
      const diff = stringField(payload, "diff");
      return diff === undefined || diff === "" ? [] : diff.split("\n");
    },
  },
  bash: {
    summary: () => "completed",
    errorSummary: (result) => lastNonEmptyLine(toolResultText(result.content)) || "failed",
    supplementalLines: (result) => {
      const content = toolResultText(result.content);
      if (content === "" || content === "(no output)") {
        return [];
      }
      return content.split("\n").filter((line) => line.trim() !== "");
    },
    invocationLabel: (arguments_) =>
      stringField(arguments_, "command") ?? "bash",
  },
  grep: {
    summary: (result) => `${grepMatchLines(toolResultText(result.content)).length} matches`,
    invocationLabel: (arguments_, path) => {
      const pattern = stringField(arguments_, "pattern") ?? "";
      const query = arguments_.literal === true
        ? JSON.stringify(pattern)
        : `/${pattern}/${arguments_.ignoreCase === true ? "i" : ""}`;
      return `${path} · ${query}`;
    },
    supplementalLines: (result) => {
      const content = toolResultText(result.content);
      if (content === "" || content === "No matches found") {
        return ["无匹配"];
      }
      return content.split("\n").filter((line) => line.trim() !== "");
    },
  },
  find: {
    summary: (result) =>
      `${findListingLines(toolResultText(result.content)).length} entries`,
    invocationLabel: (arguments_, path) =>
      `${path} · ${stringField(arguments_, "pattern") ?? ""}`,
    supplementalLines: (result) => {
      const content = toolResultText(result.content);
      if (content === "" || content === "No files found matching pattern") {
        return ["无匹配"];
      }
      return content.split("\n").filter((line) => line.trim() !== "");
    },
  },
  ls: {
    summary: (result) => `${lsListingLines(toolResultText(result.content)).length} entries`,
    supplementalLines: (result) => {
      const content = toolResultText(result.content);
      if (content === "" || content === "(empty directory)") {
        return ["空目录"];
      }
      return content.split("\n").filter((line) => line.trim() !== "");
    },
  },
};

export function createToolCard(
  toolCall: ProviderToolCall,
  status: TuiToolStatus,
  sessionCwd?: string,
): TuiToolCard {
  const path = lexicalPathPresentation(toolCall, sessionCwd);
  const statusSummary =
    status === "requested"
      ? "等待执行"
      : status === "running"
        ? "执行中"
        : "";
  return {
    id: toolCall.id,
    name: toolCall.name,
    invocationLabel: formatToolCallDetail(toolCall, sessionCwd),
    status,
    supplementalLines: [],
    summary: `${statusSummary}${path?.outside === true ? " · outside cwd" : ""}`,
  };
}

export function createCompletedToolCard(
  toolCall: ProviderToolCall,
  result: ToolResult,
  isError: boolean,
  sessionCwd: string,
): TuiToolCard {
  const payload = asRecord(result.details);
  const invocationLabel = formatToolCallDetail(toolCall, sessionCwd);
  const supplementalLines = buildSupplementalLines(
    toolCall,
    result,
    payload,
    isError,
  );
  if (isError) {
    const presenter = toolPresenters[toolCall.name];
    const failurePrefix = presenter?.failurePrefix?.(payload) ?? "";
    const errorText =
      presenter?.errorSummary?.(result, payload) ??
      toolResultText(result.content);
    return {
      ...createToolCard(toolCall, "failed"),
      invocationLabel,
      summary: `${failurePrefix}${errorText}`,
      supplementalLines,
    };
  }

  const presenter = toolPresenters[toolCall.name];
  return {
    ...createToolCard(toolCall, "completed"),
    invocationLabel,
    summary: presenter?.summary(result, payload) ?? "completed",
    supplementalLines,
  };
}

export function formatToolCallDetail(
  toolCall: ProviderToolCall,
  sessionCwd?: string,
): string {
  const arguments_ = asRecord(toolCall.arguments);
  if (arguments_ === undefined) {
    return toolCall.name;
  }
  const path = lexicalPathPresentation(toolCall, sessionCwd)?.label ??
    stringField(arguments_, "path") ?? ".";
  return toolPresenters[toolCall.name]?.invocationLabel?.(arguments_, path) ?? path;
}

function readSummary(
  result: ToolResult,
  payload: Record<string, unknown> | undefined,
): string {
  const content = toolResultText(result.content);
  const images = result.content.filter((block) => block.type === "image");
  if (images.length) return `已读 ${images.length} 张图片 · ${images.map((block) => block.mimeType).join(", ")}`;
  const returnedLines = content === "" ? 0 : content.split("\n").length;
  const totalLines = numericField(payload, "totalLines");
  const lineSummary =
    totalLines === undefined || totalLines === returnedLines
      ? `${returnedLines}`
      : `${returnedLines}/${totalLines}`;
  const bytes = new TextEncoder().encode(content).length;
  return `已读 ${lineSummary} 行 · ${formatNumber(bytes)} B`;
}

function buildSupplementalLines(
  toolCall: ProviderToolCall,
  result: ToolResult,
  payload: Record<string, unknown> | undefined,
  isError: boolean,
): readonly string[] {
  const lines: string[] = [];
  const presenter = toolPresenters[toolCall.name];
  if (presenter?.supplementalLines !== undefined) {
    lines.push(...presenter.supplementalLines(result, payload));
  }

  if (isError) {
    const supplemental = failureSupplement(
      payload,
      presenter?.hiddenFailureFields ?? [],
    );
    if (supplemental !== undefined) {
      lines.push(`error details · ${JSON.stringify(supplemental)}`);
    }
  }

  const truncation = asRecord(payload?.truncation);
  if (truncation !== undefined) {
    lines.push(`truncation · ${JSON.stringify(truncation)}`);
  }
  return lines;
}

function lexicalPathPresentation(
  toolCall: ProviderToolCall,
  sessionCwd?: string,
): { readonly label: string; readonly outside: boolean } | undefined {
  if (sessionCwd === undefined) {
    return undefined;
  }
  const arguments_ = asRecord(toolCall.arguments);
  const input = stringField(
    arguments_,
    toolCall.name === "bash" ? "cwd" : "path",
  );
  if (input === undefined) {
    return toolCall.name === "bash" ? undefined : { label: ".", outside: false };
  }
  const path = /^[A-Za-z]:[\\/]/.test(sessionCwd) || sessionCwd.includes("\\")
    ? win32
    : posix;
  const resolvedPath = path.resolve(sessionCwd, input);
  const relativePath = path.relative(sessionCwd, resolvedPath);
  const outside =
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath);
  return {
    label: (outside ? resolvedPath : relativePath || ".").replaceAll("\\", "/"),
    outside,
  };
}

function failureSupplement(
  payload: Record<string, unknown> | undefined,
  hiddenFields: readonly string[],
): Record<string, unknown> | undefined {
  if (payload === undefined) {
    return undefined;
  }
  const omitted = new Set(hiddenFields);
  const entries = Object.entries(payload).filter(([key]) => !omitted.has(key));
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "");
  return lines.at(-1);
}

function lsListingLines(content: string): string[] {
  if (content === "" || content === "(empty directory)") {
    return [];
  }
  const noticeAt = content.indexOf("\n\n[");
  const listing = noticeAt === -1 ? content : content.slice(0, noticeAt);
  return listing.split("\n").filter((line) => line !== "");
}

function grepMatchLines(content: string): string[] {
  if (content === "" || content === "No matches found") {
    return [];
  }
  const noticeAt = content.indexOf("\n\n[");
  const listing = noticeAt === -1 ? content : content.slice(0, noticeAt);
  return listing.split("\n").filter((line) => /:\d+: /.test(line));
}

function findListingLines(content: string): string[] {
  if (content === "" || content === "No files found matching pattern") {
    return [];
  }
  const noticeAt = content.indexOf("\n\n[");
  const listing = noticeAt === -1 ? content : content.slice(0, noticeAt);
  return listing.split("\n").filter((line) => line !== "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringField(value: unknown, field: string): string | undefined {
  const fieldValue = asRecord(value)?.[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

function numericField(value: unknown, field: string): number | undefined {
  const fieldValue = asRecord(value)?.[field];
  return typeof fieldValue === "number" ? fieldValue : undefined;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
