import type { ToolPreview } from "../types.js";

export const PREVIEW_LINES = 5;
const MAX_LINE_CHARS = 2000;

/** Bound both rows and row length before handing output to a UI. */
export function preview(
  text: string,
  options: { firstLine?: number; totalLines?: number; sourceCapped?: boolean; capNotice?: string } = {},
): ToolPreview {
  const lines = text.split("\n");
  let clipped = false;
  const visible = lines.slice(0, PREVIEW_LINES).map((text, index) => {
    if (text.length > MAX_LINE_CHARS) clipped = true;
    return {
      text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text,
      ...(options.firstLine === undefined ? {} : { lineNumber: options.firstLine + index }),
    };
  });
  return {
    lines: visible,
    totalLines: options.totalLines ?? lines.length,
    sourceCapped: options.sourceCapped ?? false,
    ...(options.capNotice ? { capNotice: options.capNotice.slice(0, MAX_LINE_CHARS) } : {}),
    ...(clipped ? { linesClipped: true } : {}),
  };
}
