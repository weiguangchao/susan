import type { TuiToolCard, TuiToolResultRow } from "./types";

export const TOOL_RESULT_ROW_BUDGET = 4;

export function toolResultRows(tool: TuiToolCard): readonly TuiToolResultRow[] {
  const lines = tool.supplementalLines
    .flatMap((line) => line.split("\n"))
    .filter((line) => !line.startsWith("error details ·") && !line.startsWith("truncation ·"));
  const rows = lines
    .slice(0, TOOL_RESULT_ROW_BUDGET)
    .map((text, index) => resultRow(tool, text, index));
  const shown = rows.length;
  const omitted = Math.max(0, (tool.totalLines ?? lines.length) - shown);
  if (omitted === 0) {
    return rows;
  }
  return [...rows, { text: `其余 ${omitted} 行`, gap: true }];
}

function resultRow(
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
  if (tool.name === "edit") {
    if (/^[+\- ] +\.\.\.\s*$/.test(text)) {
      return { text: "...", gap: false };
    }
    const parsed = parseEditDiffLine(text);
    if (parsed === undefined) {
      return { text, gap: false };
    }
    return {
      text: parsed.text,
      gap: false,
      lineNumber: parsed.lineNumber,
      sign: parsed.sign,
    };
  }
  if (
    (tool.name !== "read" && tool.name !== "write") ||
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

export function parseEditDiffLine(
  line: string,
): { readonly sign: "+" | "-" | " "; readonly lineNumber: number; readonly text: string } | undefined {
  const match = /^([+\- ]) *(\d+)(?: (.*))?$/.exec(line);
  if (match === null) {
    return undefined;
  }
  return {
    sign: match[1] as "+" | "-" | " ",
    lineNumber: Number(match[2]),
    text: match[3] ?? "",
  };
}
