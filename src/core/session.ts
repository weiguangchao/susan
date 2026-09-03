import type { CompletionMessage } from "./provider.js";

export type SessionHeader = {
  type: "session";
  version: 1;
  id: string;
  createdAt: string;
  cwd: string;
};

export type SessionMessageRecord = {
  type: "message";
  message: CompletionMessage;
};

export type SessionCompactionRecord = {
  type: "compaction";
  summary: string;
  firstKeptMessageIndex: number;
  tokensBefore: number;
  tokensAfterEstimate: number;
  createdAt: string;
};

export type SessionRecord = SessionMessageRecord | SessionCompactionRecord;
