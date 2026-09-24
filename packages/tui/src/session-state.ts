/** What the transcript is made of. The renderer draws only these. */

export interface UserItem {
  kind: "user";
  id: string;
  text: string;
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  text: string;
}

export interface ToolItem {
  kind: "tool";
  id: string;
  name: string;
  summary: string;
  status: "pending" | "running" | "done" | "error" | "denied";
  display?: string;
}

export interface NoticeItem {
  kind: "notice";
  id: string;
  level: "info" | "warn" | "error";
  text: string;
}

export interface ReasoningItem {
  kind: "reasoning";
  id: string;
  text: string;
  /** Wall-clock duration of the block, measured in the TUI. */
  ms: number;
}

export type LogItem = UserItem | AssistantItem | ReasoningItem | ToolItem | NoticeItem;

let seq = 0;
export const nextItemId = (prefix: string): string => `${prefix}-${++seq}`;
