import stringWidth from "string-width";
import { toolLedgerRowCount, type TuiToolCard } from "../tool-ledger";
import type { TuiCompletedOutput, TuiMessage, TuiState } from "../state";

export const USER_MESSAGE_BAR = "▌";
export const USER_MESSAGE_BAR_COLUMNS = 2;

export function wrapLines(text: string, width: number): readonly string[] {
  const usable = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const character of Array.from(paragraph)) {
      const characterWidth = stringWidth(character);
      if (currentWidth + characterWidth > usable && current !== "") {
        lines.push(current);
        current = character;
        currentWidth = characterWidth;
      } else {
        current += character;
        currentWidth += characterWidth;
      }
    }
    lines.push(current);
  }
  return lines;
}

// Compact output presentation without changing the stored message content.
// Rendering and height accounting must consume the same visible rows.
export function outputLines(text: string, width: number): readonly string[] {
  return wrapLines(text, width).filter(line => line.trim() !== "");
}

export function thinkDurationLabel(durationMs: number): string {
  return `Think · ${(durationMs / 1000).toFixed(1)} 秒`;
}

function wrappedRowCount(text: string, width: number): number {
  const usableWidth = Math.max(1, width);
  return text.split("\n").reduce((sum, line) => {
    const lineWidth = stringWidth(line);
    return sum + Math.max(1, Math.ceil(lineWidth / usableWidth) || 1);
  }, 0);
}

export function messageGapAbove(
  messages: readonly TuiMessage[],
  index: number,
): number {
  if (index === 0) {
    return 0;
  }
  return messages[index - 1]?.kind === "reasoning" &&
    messages[index]?.kind === "assistant"
    ? 1
    : 0;
}

export function completedItemGapAbove(
  items: readonly TuiCompletedOutput[],
  index: number,
): number {
  if (index === 0) {
    return 0;
  }
  const previous = items[index - 1]!;
  const item = items[index]!;
  const previousKind = previous.kind === "message" ? previous.message.kind : previous.kind;
  const currentKind = item.kind === "message" ? item.message.kind : item.kind;
  const outputKinds = ["reasoning", "assistant", "tool-batch"];
  return previousKind !== currentKind &&
    outputKinds.includes(previousKind) && outputKinds.includes(currentKind) ? 1 : 0;
}

export function completedItemRows(
  item: TuiCompletedOutput,
  width: number,
): number {
  if (item.kind === "tool-batch") {
    return toolLedgerRowCount(item.tools);
  }
  if (item.message.kind === "interrupted") {
    return 2;
  }
  if (item.message.kind === "user") {
    return (
      wrapLines(item.message.text, width - USER_MESSAGE_BAR_COLUMNS).length + 2
    );
  }
  if (item.message.kind === "assistant") {
    return outputLines(item.message.text, width).length;
  }
  if (item.message.kind === "reasoning") {
    return (
      (item.message.durationMs === undefined ? 0 : 1) +
      outputLines(item.message.text, width).length
    );
  }
  return wrappedRowCount(`⚠ ${item.message.text}`, width);
}

// Let growing live output reclaim terminal rows from completed Static output.
// The previous frame height is a floor, not a fixed viewport for later streams.
export function liveContentRows(
  state: Pick<TuiState, "stream" | "awaitingModelAfterTools">,
  tools: readonly TuiToolCard[],
  width: number,
): number {
  const stream = state.stream;
  const reasoning = stream?.reasoning ?? "";
  const text = stream?.text ?? "";
  const reasoningRows = reasoning === "" ? 0 : 1 +
    outputLines(text === "" ? `${reasoning}▍` : reasoning, width).length;
  const textRows = text === "" ? 0 :
    (reasoning === "" ? 0 : 1) + outputLines(`${text}▍`, width).length;
  const activityRow =
    state.awaitingModelAfterTools ||
    (stream !== null && stream.reasoning === "" && stream.text === "")
      ? 1
      : 0;
  return reasoningRows + textRows + toolLedgerRowCount(tools) + activityRow;
}
