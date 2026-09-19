import type { HarnessSnapshot } from "@weiguangchao/susan-harness";
import { reduceHarnessEvent } from "./harness-event";
import { clearedDraftState } from "./input-edit";
import { applyInputIntent } from "./input-reduce";
import { resolveInputIntent } from "./keyboard";
import {
  completedOutputFromMessages,
  messageToTuiMessages,
  pendingNotice,
  toolsFromMessages,
} from "./transcript";
import type { TuiAction, TuiState } from "./types";

export function createTuiState(
  snapshot: HarnessSnapshot,
  globalInputHistory?: readonly string[],
): TuiState {
  const inputHistory =
    globalInputHistory ??
    snapshot.messages.flatMap((message) =>
      message.role === "user" ? [message.content] : [],
    );
  const messages = snapshot.messages.flatMap(messageToTuiMessages);
  const tools = toolsFromMessages(snapshot.messages, snapshot.cwd);
  return {
    cwd: snapshot.cwd,
    status: snapshot.status,
    messages,
    tools,
    completedOutput: completedOutputFromMessages(snapshot.messages, tools),
    awaitingModelAfterTools: false,
    stream: null,
    retry: null,
    failure: null,
    pending: snapshot.pending,
    model: snapshot.model,
    reasoningEffort: snapshot.reasoningEffort,
    contextWindow: snapshot.contextWindow,
    contextTokens: snapshot.contextTokens,
    sessionTotalTokens: snapshot.sessionTotalTokens,
    sessionInputTokens: snapshot.sessionInputTokens,
    sessionCachedInputTokens: snapshot.sessionCachedInputTokens,
    notice:
      snapshot.pending !== null
        ? pendingNotice(snapshot.pending)
        : snapshot.model === undefined || snapshot.reasoningEffort === undefined
          ? "模型配置未完整 · /model 选择"
          : null,
    input: "",
    inputCursor: { row: 0, column: 0 },
    inputHistory,
    inputHistoryIndex: inputHistory.length,
    inputHistoryActive: false,
    slashCommandSelectedIndex: 0,
    modelPickerActive: false,
  };
}

export function reduceTuiState(
  state: TuiState,
  action: TuiAction,
): TuiState {
  switch (action.type) {
    case "harness-event":
      return reduceHarnessEvent(state, action.event);
    case "snapshot":
      return {
        ...state,
        cwd: action.snapshot.cwd,
        status: action.snapshot.status,
        awaitingModelAfterTools:
          action.snapshot.status === "running" && state.awaitingModelAfterTools,
        pending: action.snapshot.pending,
        model: action.snapshot.model,
        reasoningEffort: action.snapshot.reasoningEffort,
        contextWindow: action.snapshot.contextWindow,
        contextTokens: action.snapshot.contextTokens,
        sessionTotalTokens: action.snapshot.sessionTotalTokens,
        sessionInputTokens: action.snapshot.sessionInputTokens,
        sessionCachedInputTokens: action.snapshot.sessionCachedInputTokens,
        ...(action.snapshot.pending === null
          ? {}
          : { notice: pendingNotice(action.snapshot.pending) }),
      };
    case "input-key":
      return applyInputIntent(state, resolveInputIntent(state, action.key));
    case "input-intent":
      return applyInputIntent(state, action.intent);
    case "notice":
      return { ...state, notice: action.message };
    case "clear-input":
      return { ...state, ...clearedDraftState(state), notice: null };
    case "close-model-picker":
      return { ...state, modelPickerActive: false };
    case "new-session":
      return createTuiState(
        action.snapshot,
        action.inputHistory ?? state.inputHistory,
      );
    default:
      return state;
  }
}
