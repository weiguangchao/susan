import type { CompletionMessage, ProviderUsage, ReasoningEffort } from "../provider";

export type SessionFormatVersion = 5;

export type SessionHeader = {
  type: "session";
  version: SessionFormatVersion;
  id: string;
  createdAt: string;
  cwd: string;
};

export type SessionMessageRecord = {
  type: "message";
  message: CompletionMessage;
};

export type CompactionEntry = {
  type: "compaction";
  summary: string;
  /** Stable message ordinal in Susan's linear append-only transcript. */
  firstKeptEntryId: string;
  retainedTail: CompletionMessage[];
  tokensBefore: number;
  details: { readFiles: string[]; modifiedFiles: string[] };
  usage?: ProviderUsage;
  timestamp: string;
};

export type SessionUsageRecord = {
  type: "usage";
  usage: ProviderUsage;
  model?: string;
  reasoningEffort?: ReasoningEffort;
};

export type SessionUsageAudit = Pick<
  SessionUsageRecord,
  "model" | "reasoningEffort"
>;

export type SessionRecord =
  | SessionMessageRecord
  | CompactionEntry
  | SessionUsageRecord;

export type SessionStoreErrorCode =
  | "SUSAN_SESSION_DIRECTORY"
  | "SUSAN_SESSION_PERMISSION"
  | "SUSAN_SESSION_SCHEMA"
  | "SUSAN_SESSION_NOT_FOUND"
  | "SUSAN_SESSION_IO";

export type SessionStoreError = {
  readonly code: SessionStoreErrorCode;
  readonly message: string;
  readonly path?: string;
};

export type SessionStoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SessionStoreError };

export type SessionTranscript = {
  readonly header: SessionHeader;
  readonly records: readonly SessionRecord[];
  readonly messages: readonly CompletionMessage[];
  readonly filePath: string;
};

export type SessionSummary = {
  readonly header: SessionHeader;
  readonly title: string;
  readonly recordCount: number;
  readonly updatedAt: string;
  readonly filePath: string;
};

export type SessionStore = {
  createSession(input: {
    readonly cwd: string;
    readonly reuseEmpty?: boolean;
  }): Promise<SessionStoreResult<SessionTranscript>>;
  appendMessage(
    sessionId: string,
    message: CompletionMessage,
  ): Promise<SessionStoreResult<void>>;
  appendCompaction(
    sessionId: string,
    checkpoint: CompactionEntry,
  ): Promise<SessionStoreResult<void>>;
  appendUsage(
    sessionId: string,
    usage: ProviderUsage,
    modelConfiguration?: SessionUsageAudit,
  ): Promise<SessionStoreResult<void>>;
  loadSession(
    sessionId: string,
  ): Promise<SessionStoreResult<SessionTranscript>>;
  listSessions(): Promise<SessionStoreResult<readonly SessionSummary[]>>;
  loadLastSession(): Promise<
    SessionStoreResult<SessionTranscript | null>
  >;
  loadInputHistory(): Promise<SessionStoreResult<readonly string[]>>;
};

export type SessionStoreOptions = {
  readonly sessionsDirectory?: string;
};
