import { resolveSlashCommandMenu, slashCommands } from "../slash-command-menu";
import type {
  TuiInputIntent,
  TuiInputKey,
  TuiState,
  TuiSubmissionIntent,
} from "./types";

export function normalizeSubmission(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function resolveSubmission(value: string): TuiSubmissionIntent {
  const content = normalizeSubmission(value);
  if (content.startsWith("/compact ")) {
    return { type: "compact", customInstructions: content.slice(9).trim() };
  }
  const command = slashCommands.find((candidate) => candidate.name === content);
  if (command !== undefined) {
    return { type: command.intent };
  }
  return { type: "submit", content };
}

export function resolveInputIntent(
  state: TuiState,
  key: TuiInputKey,
): TuiInputIntent {
  if (key.ctrl && key.input === "c") {
    if (state.status === "running") return { type: "interrupt" };
    if (state.input !== "") return { type: "clear-input" };
    return { type: "exit" };
  }
  if (key.ctrl && key.input === "j") return { type: "newline" };
  if (key.ctrl && key.input === "d") return { type: "clear-input" };
  if (key.input === "\n" && key.return !== true) return { type: "newline" };
  if (key.ctrl && key.input === "a") {
    return { type: "move-cursor-to-line-start" };
  }
  if (key.ctrl && key.input === "e") {
    return { type: "move-cursor-to-line-end" };
  }

  const slashCommandMenu = resolveSlashCommandMenu(state);
  if (key.upArrow) {
    if (slashCommandMenu.visible) {
      return { type: "move-slash-command-selection", delta: -1 };
    }
    if (
      (state.input === "" || state.inputHistoryActive) &&
      state.inputHistoryIndex > 0
    ) {
      return { type: "history-previous" };
    }
    return { type: "move-cursor-up", inputWidth: key.inputWidth };
  }
  if (key.downArrow) {
    if (slashCommandMenu.visible) {
      return { type: "move-slash-command-selection", delta: 1 };
    }
    if (
      (state.input === "" || state.inputHistoryActive) &&
      state.inputHistoryIndex < state.inputHistory.length
    ) {
      return { type: "history-next" };
    }
    return { type: "move-cursor-down", inputWidth: key.inputWidth };
  }
  if (key.leftArrow) return { type: "move-cursor-left" };
  if (key.rightArrow) return { type: "move-cursor-right" };

  if (key.escape && (slashCommandMenu.visible || state.failure !== null)) {
    return { type: "dismiss-failure" };
  }

  if (state.status === "running") {
    if (key.return) {
      return { type: "notice", message: "生成中 · Ctrl+C 可中断" };
    }
    if (key.backspace) return { type: "backspace" };
    return { type: "insert", text: key.input };
  }

  if (state.status === "pending") {
    if (state.input === "") {
      if (key.input === "r") {
        return state.model === undefined || state.reasoningEffort === undefined
          ? { type: "model-picker" }
          : { type: "retry" };
      }
      if (key.input === "n") return { type: "new-session" };
      if (key.return && state.failure !== null) return { type: "retry" };
      if (key.return) {
        return {
          type: "notice",
          message: "Pending Agent Loop · r 重试 · n 新对话",
        };
      }
    }
    if (key.backspace) return { type: "backspace" };
    if (key.return) {
      if (slashCommandMenu.selected !== null) {
        return { type: slashCommandMenu.selected.intent };
      }
      const submission = resolveSubmission(state.input);
      if (submission.type !== "submit") return submission;
      return {
        type: "notice",
        message: "Pending Agent Loop · 清空输入后 r 重试 / n 新对话",
      };
    }
    return { type: "insert", text: key.input };
  }

  if (key.backspace) return { type: "backspace" };
  if (key.return) {
    if (slashCommandMenu.selected !== null) {
      return { type: slashCommandMenu.selected.intent };
    }
    const submission = resolveSubmission(state.input);
    if (submission.type === "submit" && submission.content.length === 0) {
      return { type: "none" };
    }
    if (
      submission.type === "submit" &&
      (state.model === undefined || state.reasoningEffort === undefined)
    ) {
      return { type: "model-picker" };
    }
    return submission;
  }
  if (key.input === "") return { type: "none" };
  return { type: "insert", text: key.input };
}
