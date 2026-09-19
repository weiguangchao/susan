import { posix, win32 } from "node:path";
import type { ProviderToolCall } from "@weiguangchao/susan-harness";
import {
  toolResultText,
  type ToolResult,
} from "@weiguangchao/susan-harness";
import {
  asRecord,
  stringField,
  stripToolNotices,
} from "./helpers";
import {
  readOffset,
  readPreviewLines,
  readTotalLines,
  toolPresenters,
} from "./presenters";
import type { TuiToolCard, TuiToolStatus } from "./types";

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
  const arguments_ = asRecord(toolCall.arguments);
  const supplementalLines = buildSupplementalLines(
    toolCall,
    result,
    payload,
    isError,
    arguments_,
  );
  const startLine = toolCall.name === "read" ? readStartLine(toolCall) : undefined;
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
    return {
      ...createToolCard(toolCall, "failed"),
      invocationLabel,
      summary: presenter?.errorSummary?.(result, payload) ?? "failed",
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

function readStartLine(toolCall: ProviderToolCall): number {
  return readOffset(asRecord(toolCall.arguments));
}

function buildSupplementalLines(
  toolCall: ProviderToolCall,
  result: ToolResult,
  payload: Record<string, unknown> | undefined,
  isError: boolean,
  arguments_?: Record<string, unknown>,
): readonly string[] {
  const lines: string[] = [];
  const presenter = toolPresenters[toolCall.name];
  if (isError) {
    if (toolCall.name === "bash" && presenter?.supplementalLines !== undefined) {
      lines.push(...presenter.supplementalLines(result, payload, arguments_));
    } else {
      const errorText = toolResultText(result.content);
      if (errorText !== "" && errorText !== "(no output)") {
        lines.push(...errorText.split("\n").filter((line) => line.trim() !== ""));
      }
    }
    const supplemental = failureSupplement(
      payload,
      presenter?.hiddenFailureFields ?? [],
    );
    if (supplemental !== undefined) {
      lines.push(`error details · ${JSON.stringify(supplemental)}`);
    }
    return lines;
  }
  if (presenter?.supplementalLines !== undefined) {
    lines.push(...presenter.supplementalLines(result, payload, arguments_));
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
