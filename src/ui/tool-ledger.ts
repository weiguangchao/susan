import { posix, win32 } from "node:path";
import { isRecord } from "../core/json";
import type { ProviderToolCall } from "../core/provider";
import {
  toolResultText,
  type ToolResult,
} from "../core/tool-result";

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
  readonly startLine?: number;
  readonly totalLines?: number;
};

export type TuiToolResultRow = {
  readonly text: string;
  readonly gap: boolean;
  readonly lineNumber?: number;
};

export const TOOL_RESULT_ROW_BUDGET = 4;

export function isSourceToolCard(tool: Pick<TuiToolCard, "name">): boolean {
  return tool.name === "read" || tool.name === "grep";
}

export function toolResultRows(tool: TuiToolCard): readonly TuiToolResultRow[] {
  if (isSourceToolCard(tool)) {
    return sourceToolResultRows(tool);
  }
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

function sourceToolResultRows(tool: TuiToolCard): readonly TuiToolResultRow[] {
  const lines = tool.supplementalLines
    .flatMap((line) => line.split("\n"))
    .filter((line) => !line.startsWith("error details ·") && !line.startsWith("truncation ·"));
  const rows = lines
    .slice(0, TOOL_RESULT_ROW_BUDGET)
    .map((text, index) => sourceResultRow(tool, text, index));
  const shown = rows.length;
  const omitted = Math.max(0, (tool.totalLines ?? lines.length) - shown);
  if (omitted === 0) {
    return rows;
  }
  return [...rows, { text: `其余 ${omitted} 行`, gap: true }];
}

function sourceResultRow(
  tool: TuiToolCard,
  text: string,
  index: number,
): TuiToolResultRow {
  if (tool.name === "grep") {
    const parsed = parseGrepMatchLine(text);
    if (parsed === undefined) {
      return { text, gap: false };
    }
    return { text: parsed.text, gap: false, lineNumber: parsed.lineNumber };
  }
  if (
    tool.status !== "completed" ||
    text === "(empty)" ||
    /^已读 \d+ 张图片$/.test(text)
  ) {
    return { text, gap: false };
  }
  return {
    text,
    gap: false,
    lineNumber: (tool.startLine ?? 1) + index,
  };
}

function parseGrepMatchLine(
  line: string,
): { readonly lineNumber: number; readonly text: string } | undefined {
  const match = /:(\d+): /.exec(line);
  if (match === null || match.index === undefined) {
    return undefined;
  }
  return {
    lineNumber: Number(match[1]),
    text: `${line.slice(0, match.index)}: ${line.slice(match.index + match[0].length)}`,
  };
}

type ToolPresenter = {
  readonly summary: (
    result: ToolResult,
    payload: Record<string, unknown> | undefined,
    arguments_?: Record<string, unknown>,
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
      const images = result.content.filter((block) => block.type === "image");
      if (images.length > 0) {
        return [`已读 ${images.length} 张图片`];
      }
      const content = stripToolNotices(toolResultText(result.content));
      return content === "" ? ["(empty)"] : readPreviewLines(content);
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
      return stripToolNotices(content).split("\n").filter((line) => line.trim() !== "");
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
  const startLine = toolCall.name === "read" ? readStartLine(toolCall) : undefined;
  const arguments_ = asRecord(toolCall.arguments);
  const totalLines = toolCall.name === "read" && !isError
    ? readTotalLines(
        toolResultText(result.content),
        payload,
        readStartLine(toolCall),
        readPreviewLines(stripToolNotices(toolResultText(result.content))).length,
      )
    : undefined;
  if (isError) {
    const presenter = toolPresenters[toolCall.name];
    const failurePrefix = presenter?.failurePrefix?.(payload) ?? "";
    const errorText =
      presenter?.errorSummary?.(result, payload) ??
      toolResultText(result.content);
    return {
      ...createToolCard(toolCall, "failed"),
      invocationLabel,
      summary: isSourceToolCard(toolCall) ? "failed" : `${failurePrefix}${errorText}`,
      supplementalLines,
      ...(startLine === undefined ? {} : { startLine }),
    };
  }

  const presenter = toolPresenters[toolCall.name];
  return {
    ...createToolCard(toolCall, "completed"),
    invocationLabel,
    summary: presenter?.summary(result, payload, arguments_) ?? "completed",
    supplementalLines,
    ...(startLine === undefined ? {} : { startLine }),
    ...(totalLines === undefined ? {} : { totalLines }),
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
  arguments_?: Record<string, unknown>,
): string {
  const images = result.content.filter((block) => block.type === "image");
  if (images.length > 0) {
    return images.map((block) => block.mimeType).join(", ");
  }
  const raw = toolResultText(result.content);
  const content = stripToolNotices(raw);
  if (content === "") {
    return "空文件";
  }
  const displayedLines = readPreviewLines(content);
  const startLine = readOffset(arguments_);
  const endLine = startLine + displayedLines.length - 1;
  const totalLines = readTotalLines(raw, payload, startLine, displayedLines.length);
  if (totalLines !== undefined && totalLines !== displayedLines.length) {
    return `L${startLine}–${endLine} / ${totalLines}`;
  }
  const bytes = new TextEncoder().encode(content).length;
  return `L${startLine} · ${displayedLines.length} 行 · ${formatNumber(bytes)} B`;
}

function readStartLine(toolCall: ProviderToolCall): number {
  return readOffset(asRecord(toolCall.arguments));
}

function readOffset(arguments_: Record<string, unknown> | undefined): number {
  const offset = numericField(arguments_, "offset");
  return offset === undefined || offset < 1 ? 1 : Math.trunc(offset);
}

function readPreviewLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function readTotalLines(
  content: string,
  payload: Record<string, unknown> | undefined,
  startLine: number,
  displayedLines: number,
): number | undefined {
  const totalLines = numericField(payload, "totalLines");
  if (totalLines !== undefined) {
    return totalLines;
  }
  const notice = noticeSuffix(content);
  const showing = /\[Showing lines \d+-\d+ of (\d+)/.exec(notice);
  if (showing !== null) {
    return Number(showing[1]);
  }
  const remaining = /\[(\d+) more lines in file\./.exec(notice);
  if (remaining !== null) {
    return startLine + displayedLines - 1 + Number(remaining[1]);
  }
  return undefined;
}

function noticeSuffix(content: string): string {
  const noticeAt = content.indexOf("\n\n[");
  return noticeAt === -1 ? "" : content.slice(noticeAt + 2);
}

function stripToolNotices(content: string): string {
  const noticeAt = content.indexOf("\n\n[");
  return noticeAt === -1 ? content : content.slice(0, noticeAt);
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
  if (truncation !== undefined && !isSourceToolCard(toolCall)) {
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
