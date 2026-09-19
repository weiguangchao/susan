import {
  toolResultText,
  type ToolResult,
} from "@weiguangchao/susan-harness";
import {
  formatNumber,
  noticeSuffix,
  numericField,
  stringField,
  stripToolNotices,
} from "./helpers";
import { parseEditDiffLine } from "./rows";

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
    arguments_?: Record<string, unknown>,
  ) => readonly string[];
  readonly hiddenFailureFields?: readonly string[];
};

export const toolPresenters: Readonly<Record<string, ToolPresenter>> = {
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
    summary: (_result, _payload, arguments_) => writeSummary(arguments_),
    supplementalLines: (_result, _payload, arguments_) => {
      const content = stringField(arguments_, "content") ?? "";
      return content === "" ? ["(empty)"] : readPreviewLines(content);
    },
  },
  edit: {
    summary: (_result, payload) => editSummary(payload),
    supplementalLines: (_result, payload) => {
      const diff = stringField(payload, "diff");
      return diff === undefined || diff === "" ? [] : diff.split("\n");
    },
  },
  bash: {
    summary: () => "completed",
    errorSummary: (result) => bashErrorSummary(result),
    supplementalLines: (result) => {
      const content = toolResultText(result.content);
      if (content === "" || content === "(no output)") {
        return [];
      }
      return content.split("\n").filter((line) => {
        const trimmed = line.trim();
        return trimmed !== "" && !/^Command exited with code \d+$/.test(trimmed);
      });
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
      return findListingLines(content);
    },
  },
  ls: {
    summary: (result) => `${lsListingLines(toolResultText(result.content)).length} entries`,
    supplementalLines: (result) => {
      const content = toolResultText(result.content);
      if (content === "" || content === "(empty directory)") {
        return ["空目录"];
      }
      return lsListingLines(content);
    },
  },
};

export function readPreviewLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

export function readOffset(arguments_: Record<string, unknown> | undefined): number {
  const offset = numericField(arguments_, "offset");
  return offset === undefined || offset < 1 ? 1 : Math.trunc(offset);
}

export function readTotalLines(
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

function writeSummary(arguments_: Record<string, unknown> | undefined): string {
  const content = stringField(arguments_, "content") ?? "";
  if (content === "") {
    return "空文件";
  }
  const lines = readPreviewLines(content);
  const bytes = new TextEncoder().encode(content).length;
  return `${lines.length} 行 · ${formatNumber(bytes)} B`;
}

function editSummary(payload: Record<string, unknown> | undefined): string {
  const diff = stringField(payload, "diff") ?? "";
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    const parsed = parseEditDiffLine(line);
    if (parsed?.sign === "+") {
      added += 1;
    } else if (parsed?.sign === "-") {
      removed += 1;
    }
  }
  const counts = `+${added} −${removed}`;
  const firstChangedLine = numericField(payload, "firstChangedLine");
  return firstChangedLine === undefined ? counts : `L${firstChangedLine} · ${counts}`;
}

function bashErrorSummary(result: ToolResult): string {
  const match = /Command exited with code (\d+)/.exec(toolResultText(result.content));
  return match === null ? "failed" : `exit ${match[1]}`;
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
