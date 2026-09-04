import type { SessionSummary } from "./session.js";

export type SessionPickerState = {
  readonly sessions: readonly SessionSummary[];
  readonly selectedIndex: number;
};

export type SessionPickerKey = {
  readonly input: string;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
};

export type SessionPickerIntent =
  | { readonly type: "move"; readonly delta: -1 | 1 }
  | { readonly type: "select" }
  | { readonly type: "new" }
  | { readonly type: "exit" }
  | { readonly type: "none" };

export function createSessionPickerState(
  sessions: readonly SessionSummary[],
): SessionPickerState {
  return {
    sessions,
    selectedIndex: 0,
  };
}

export function resolveSessionPickerIntent(
  key: SessionPickerKey,
): SessionPickerIntent {
  if (key.escape) {
    return { type: "exit" };
  }
  if (key.return) {
    return { type: "select" };
  }
  if (key.downArrow || key.input === "j") {
    return { type: "move", delta: 1 };
  }
  if (key.upArrow || key.input === "k") {
    return { type: "move", delta: -1 };
  }
  if (key.input === "n") {
    return { type: "new" };
  }
  return { type: "none" };
}

export function reduceSessionPickerState(
  state: SessionPickerState,
  intent: SessionPickerIntent,
): SessionPickerState {
  if (intent.type !== "move" || state.sessions.length === 0) {
    return state;
  }
  const nextIndex = Math.min(
    state.sessions.length - 1,
    Math.max(0, state.selectedIndex + intent.delta),
  );
  return {
    ...state,
    selectedIndex: nextIndex,
  };
}
