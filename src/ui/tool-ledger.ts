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
    summary: (result, payload) => {
      const edits = numericField(payload, "editsApplied") ?? 0;
      const replacements = numericField(payload, "replacementsApplied") ?? 0;
      const bytes = numericField(payload, "bytesWritten") ?? 0;
      return `${edits} ${plural(edits, "edit")} · ${replacements} ${plural(replacements, "replacement")} · ${formatNumber(bytes)} B`;
    },
    supplementalLines: (result, payload) => {
      const diff = stringField(payload, "diff");
      return diff === undefined || diff === "" ? [] : diff.split("\n");
    },
  },
  bash: {
    summary: (result, payload) => {
      const exit = numericField(payload, "exitCode");
      return exit === undefined ? "completed" : `exit ${exit}`;
    },
    supplementalLines: (result, payload) => bashSupplementalLines(payload),
    invocationLabel: (arguments_) =>
      stringField(arguments_, "command") ?? "bash",
    failurePrefix: bashFailurePrefix,
    hiddenFailureFields: [
      "exitCode",
      "signal",
      "stdout",
      "stderr",
      "termination",
    ],
  },
  grep: {
    summary: (result, payload) =>
      `${arrayLength(payload, "matches")} matches${diagnosticSuffix(payload)}`,
    invocationLabel: (arguments_, path) => {
      const pattern = stringField(arguments_, "pattern") ?? "";
      const query = arguments_.literal === true
        ? JSON.stringify(pattern)
        : `/${pattern}/${arguments_.ignoreCase === true ? "i" : ""}`;
      return `${path} · ${query}`;
    },
  },
  find: {
    summary: (result, payload) =>
      `${arrayLength(payload, "entries")} entries${diagnosticSuffix(payload)}`,
    invocationLabel: (arguments_, path) =>
      `${path} · ${stringField(arguments_, "pattern") ?? ""}`,
  },
  ls: {
    summary: (result, payload) =>
      `${arrayLength(payload, "entries")} entries${diagnosticSuffix(payload)}`,
    supplementalLines: (result, payload) => {
      if (!Array.isArray(payload?.entries)) {
        return [];
      }
      if (payload.entries.length === 0) {
        return ["空目录"];
      }
      return payload.entries.flatMap((entry: unknown) => {
        const name = stringField(entry, "name");
        const type = stringField(entry, "type");
        return name === undefined ? [] : [
          `${name}${type === "directory" ? "/" : type === "symlink" ? "@" : ""}`,
        ];
      });
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
    invocationLabel: formatToolCallDetail(toolCall, undefined, sessionCwd),
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
  const invocationLabel = formatToolCallDetail(toolCall, payload, sessionCwd);
  const outside = outsideSuffix(payload);
  const supplementalLines = buildSupplementalLines(
    toolCall,
    result,
    payload,
    isError,
  );
  if (isError) {
    const failurePrefix =
      toolPresenters[toolCall.name]?.failurePrefix?.(payload) ?? "";
    return {
      ...createToolCard(toolCall, "failed"),
      invocationLabel,
      summary: `${failurePrefix}${toolResultText(result.content)}${outside}`,
      supplementalLines,
    };
  }

  const presenter = toolPresenters[toolCall.name];
  return {
    ...createToolCard(toolCall, "completed"),
    invocationLabel,
    summary: `${presenter?.summary(result, payload) ?? "completed"}${outside}`,
    supplementalLines,
  };
}

export function formatToolCallDetail(
  toolCall: ProviderToolCall,
  payload?: unknown,
  sessionCwd?: string,
): string {
  const arguments_ = asRecord(toolCall.arguments);
  if (arguments_ === undefined) {
    return toolCall.name;
  }
  const path = displayPath(payload, sessionCwd) ??
    lexicalPathPresentation(toolCall, sessionCwd)?.label ??
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
  const resolvedPath = stringField(payload, "resolvedPath");
  const realTargetPath = stringField(payload, "realTargetPath");
  if (
    resolvedPath !== undefined &&
    realTargetPath !== undefined &&
    resolvedPath !== realTargetPath
  ) {
    lines.push(
      `Resolved Path → Real Target Path · ${resolvedPath} → ${realTargetPath}`,
    );
  }

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

function bashSupplementalLines(
  payload: Record<string, unknown> | undefined,
): readonly string[] {
  const lines: string[] = [];
  for (const field of ["stdout", "stderr"] as const) {
    const output = stringField(payload, field)?.trimEnd();
    if (output !== undefined && output !== "") {
      lines.push(
        ...output.split("\n").map((line) => `${field} (full) · ${line}`),
      );
    }
  }
  const termination = asRecord(payload?.termination);
  if (termination !== undefined) {
    lines.push(
      `termination · ${String(termination.scope)} · ${termination.forced === true ? "forced" : "graceful"} · ${termination.cleanupConfirmed === true ? "cleanup confirmed" : "cleanup unconfirmed"}`,
    );
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

function bashFailurePrefix(
  payload: Record<string, unknown> | undefined,
): string {
  const exit = numericField(payload, "exitCode");
  if (exit !== undefined) {
    return `exit ${exit} · `;
  }
  const signal = stringField(payload, "signal");
  return signal === undefined ? "" : `signal ${signal} · `;
}

function failureSupplement(
  payload: Record<string, unknown> | undefined,
  hiddenFields: readonly string[],
): Record<string, unknown> | undefined {
  if (payload === undefined) {
    return undefined;
  }
  const omitted = new Set([
    "resolvedPath",
    "realTargetPath",
    "cwdRelation",
    ...hiddenFields,
  ]);
  const entries = Object.entries(payload).filter(([key]) => !omitted.has(key));
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
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

function arrayLength(value: unknown, field: string): number {
  const fieldValue = asRecord(value)?.[field];
  return Array.isArray(fieldValue) ? fieldValue.length : 0;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function outsideSuffix(value: unknown): string {
  return stringField(value, "cwdRelation") === "outside" ? " · outside cwd" : "";
}

function diagnosticSuffix(value: unknown): string {
  const count = arrayLength(value, "diagnostics");
  return count === 0 ? "" : ` · ${count} ${plural(count, "diagnostic")}`;
}

function displayPath(payload: unknown, sessionCwd?: string): string | undefined {
  const resolvedPath = stringField(payload, "resolvedPath");
  if (resolvedPath === undefined) {
    return undefined;
  }
  if (stringField(payload, "cwdRelation") === "outside" || !sessionCwd) {
    return resolvedPath;
  }
  const normalizedCwd = sessionCwd.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedPath = resolvedPath.replaceAll("\\", "/");
  if (normalizedPath === normalizedCwd) {
    return ".";
  }
  const prefix = `${normalizedCwd}/`;
  return normalizedPath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : resolvedPath;
}
