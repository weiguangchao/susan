import { posix, win32 } from "node:path";
import { isRecord } from "../core/json.js";
import type { ProviderToolCall } from "../core/provider.js";
import {
  TOOL_RESULT_OUTPUT_BUDGET_BYTES,
  type ToolResult,
  type ToolResultMeta,
  type ToolTruncationReason,
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

type ToolPresenter = {
  readonly summary: (result: Record<string, unknown>) => string;
  readonly invocationLabel?: (
    arguments_: Record<string, unknown>,
    path: string,
  ) => string;
  readonly supplementalLines?: (
    result: Record<string, unknown>,
    strategy: "head" | "tail" | "full",
  ) => readonly string[];
  readonly failurePrefix?: (
    payload: Record<string, unknown> | undefined,
  ) => string;
  readonly hiddenFailureFields?: readonly string[];
};

const toolPresenters: Readonly<Record<string, ToolPresenter>> = {
  read: {
    summary: readSummary,
  },
  read_file: {
    summary: readSummary,
  },
  write: {
    summary: (result) =>
      `${stringField(result, "operation") ?? "completed"} · ${formatNumber(numericField(result, "bytesWritten") ?? 0)} B`,
  },
  edit: {
    summary: (result) => {
      const edits = numericField(result, "editsApplied") ?? 0;
      const replacements = numericField(result, "replacementsApplied") ?? 0;
      const bytes = numericField(result, "bytesWritten") ?? 0;
      return `${edits} ${plural(edits, "edit")} · ${replacements} ${plural(replacements, "replacement")} · ${formatNumber(bytes)} B`;
    },
    supplementalLines: (result) => {
      const diff = stringField(result, "diff");
      return diff === undefined || diff === "" ? [] : diff.split("\n");
    },
  },
  bash: {
    summary: (result) => {
      const exit = numericField(result, "exitCode");
      return exit === undefined ? "completed" : `exit ${exit}`;
    },
    supplementalLines: bashSupplementalLines,
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
    summary: (result) =>
      `${arrayLength(result, "matches")} matches${diagnosticSuffix(result)}`,
    invocationLabel: (arguments_, path) => {
      const pattern = stringField(arguments_, "pattern") ?? "";
      const query = arguments_.literal === true
        ? JSON.stringify(pattern)
        : `/${pattern}/${arguments_.ignoreCase === true ? "i" : ""}`;
      return `${path} · ${query}`;
    },
  },
  find: {
    summary: (result) =>
      `${arrayLength(result, "entries")} entries${diagnosticSuffix(result)}`,
    invocationLabel: (arguments_, path) =>
      `${path} · ${stringField(arguments_, "pattern") ?? ""}`,
  },
  ls: {
    summary: (result) =>
      `${arrayLength(result, "entries")} entries${diagnosticSuffix(result)}`,
  },
};

const itemLimits: Readonly<Record<string, number>> = {
  grep: 100,
  find: 1_000,
  ls: 500,
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
  sessionCwd: string,
): TuiToolCard {
  const payload = asRecord(result.ok ? result.result : result.error.details);
  const invocationLabel = formatToolCallDetail(toolCall, payload, sessionCwd);
  const outside = outsideSuffix(payload);
  const supplementalLines = buildSupplementalLines(toolCall, result, payload);
  if (!result.ok) {
    const failurePrefix = toolPresenters[toolCall.name]?.failurePrefix?.(payload) ?? "";
    return {
      ...createToolCard(toolCall, "failed"),
      invocationLabel,
      summary: `${failurePrefix}${result.error.code} · ${result.error.message}${outside}`,
      supplementalLines,
    };
  }

  const presenter = toolPresenters[toolCall.name];
  return {
    ...createToolCard(toolCall, "completed"),
    invocationLabel,
    summary: `${presenter?.summary(result.result) ?? "completed"}${outside}`,
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

function readSummary(result: Record<string, unknown>): string {
  const content = stringField(result, "content") ?? "";
  const range = asRecord(result.range);
  const returnedLines =
    range === undefined
      ? content === ""
        ? 0
        : content.split("\n").length
      : Math.max(
          0,
          (numericField(range, "endLine") ?? 0) -
            (numericField(range, "startLine") ?? 1) +
            1,
        );
  const totalLines = numericField(result, "totalLines");
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

  const strategy = result.meta?.truncation?.strategy ?? "full";
  const presenter = toolPresenters[toolCall.name];
  if (payload !== undefined && presenter?.supplementalLines !== undefined) {
    lines.push(...presenter.supplementalLines(payload, strategy));
  }

  if (!result.ok) {
    const supplemental = failureSupplement(
      payload,
      presenter?.hiddenFailureFields ?? [],
    );
    if (supplemental !== undefined) {
      lines.push(`error details · ${JSON.stringify(supplemental)}`);
    }
  }

  const truncation = result.meta?.truncation;
  if (truncation !== undefined) {
    lines.push(formatTruncation(toolCall, truncation));
    lines.push(
      truncation.nextArguments === undefined
        ? "next arguments · unavailable"
        : `next arguments · ${JSON.stringify(truncation.nextArguments)}`,
    );
  }
  return lines;
}

function bashSupplementalLines(
  payload: Record<string, unknown>,
  strategy: "head" | "tail" | "full",
): readonly string[] {
  const lines: string[] = [];
  for (const field of ["stdout", "stderr"] as const) {
    const output = stringField(payload, field)?.trimEnd();
    if (output !== undefined && output !== "") {
      lines.push(`${field} (${strategy}) · ${output}`);
    }
  }
  const termination = asRecord(payload.termination);
  if (termination !== undefined) {
    lines.push(
      `termination · ${String(termination.scope)} · ${termination.forced === true ? "forced" : "graceful"} · ${termination.cleanupConfirmed === true ? "cleanup confirmed" : "cleanup unconfirmed"}`,
    );
  }
  return lines;
}

function formatTruncation(
  toolCall: ProviderToolCall,
  truncation: NonNullable<ToolResultMeta["truncation"]>,
): string {
  const retained = [
    `${formatNumber(truncation.retained.bytes)} B`,
    truncation.retained.lines === undefined
      ? undefined
      : `${formatNumber(truncation.retained.lines)} lines`,
    truncation.retained.items === undefined
      ? undefined
      : `${formatNumber(truncation.retained.items)} items`,
  ].filter((part): part is string => part !== undefined);
  const limits = truncationLimits(toolCall, truncation.reasons);
  const total = truncation.total === undefined
    ? ""
    : ` · total ${[
        truncation.total.bytes === undefined
          ? undefined
          : `${formatNumber(truncation.total.bytes)} B`,
        truncation.total.lines === undefined
          ? undefined
          : `${formatNumber(truncation.total.lines)} lines`,
        truncation.total.items === undefined
          ? undefined
          : `${formatNumber(truncation.total.items)} items`,
      ].filter((part): part is string => part !== undefined).join(", ")}`;
  return `truncation · ${truncation.strategy} · retained ${retained.join(", ")} / limit ${limits.join(", ")} · fields ${truncation.fields.join(", ")}${total}`;
}

function truncationLimits(
  toolCall: ProviderToolCall,
  reasons: readonly ToolTruncationReason[],
): readonly string[] {
  const arguments_ = asRecord(toolCall.arguments);
  const limits = [`${formatNumber(TOOL_RESULT_OUTPUT_BUDGET_BYTES)} B output`];
  if (reasons.includes("lines")) {
    limits.push(`${formatNumber(numericField(arguments_, "limit") ?? 2_000)} lines`);
  }
  if (reasons.includes("items")) {
    const limit = numericField(arguments_, "limit") ?? itemLimits[toolCall.name];
    if (limit !== undefined) {
      limits.push(`${formatNumber(limit)} items`);
    }
  }
  if (reasons.includes("line-length") && toolCall.name === "grep") {
    limits.push("1,000 B per line");
  }
  return limits;
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
