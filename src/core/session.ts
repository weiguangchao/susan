import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  truncate,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { platform } from "node:process";
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

export const DEFAULT_SESSIONS_DIRECTORY = join(
  homedir(),
  ".susan",
  "sessions",
);

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
  }): Promise<SessionStoreResult<SessionTranscript>>;
  appendMessage(
    sessionId: string,
    message: CompletionMessage,
  ): Promise<SessionStoreResult<void>>;
  loadSession(
    sessionId: string,
  ): Promise<SessionStoreResult<SessionTranscript>>;
  listSessions(): Promise<SessionStoreResult<readonly SessionSummary[]>>;
  loadLastSession(): Promise<
    SessionStoreResult<SessionTranscript | null>
  >;
};

export type SessionStoreOptions = {
  readonly sessionsDirectory?: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function success<T>(value: T): SessionStoreResult<T> {
  return { ok: true, value };
}

function failure<T = void>(
  code: SessionStoreErrorCode,
  message: string,
  path?: string,
): SessionStoreResult<T> {
  return {
    ok: false,
    error: path === undefined ? { code, message } : { code, message, path },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isCompletionMessage(value: unknown): value is CompletionMessage {
  if (!isRecord(value)) {
    return false;
  }
  if (value.role === "system" || value.role === "user") {
    return typeof value.content === "string";
  }
  if (value.role === "assistant") {
    if (
      (value.content !== undefined && typeof value.content !== "string") ||
      (value.reasoning !== undefined && typeof value.reasoning !== "string")
    ) {
      return false;
    }
    if (value.toolCalls !== undefined) {
      if (!Array.isArray(value.toolCalls)) {
        return false;
      }
      return value.toolCalls.every((toolCall) => {
        if (!isRecord(toolCall)) {
          return false;
        }
        return (
          typeof toolCall.id === "string" &&
          typeof toolCall.name === "string" &&
          isJsonValue(toolCall.arguments)
        );
      });
    }
    return true;
  }
  if (value.role === "tool") {
    return typeof value.toolCallId === "string" && isJsonValue(value.content);
  }
  return false;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isSessionHeader(value: unknown): value is SessionHeader {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["type", "version", "id", "createdAt", "cwd"]) ||
    value.type !== "session" ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    typeof value.cwd !== "string" ||
    !isAbsolute(value.cwd)
  ) {
    return false;
  }
  return true;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "message") {
    return hasExactKeys(value, ["type", "message"]) && isCompletionMessage(value.message);
  }
  if (value.type === "compaction") {
    return (
      hasExactKeys(
        value,
        [
          "type",
          "summary",
          "firstKeptMessageIndex",
          "tokensBefore",
          "tokensAfterEstimate",
          "createdAt",
        ],
      ) &&
      typeof value.summary === "string" &&
      typeof value.firstKeptMessageIndex === "number" &&
      Number.isInteger(value.firstKeptMessageIndex) &&
      value.firstKeptMessageIndex >= 0 &&
      typeof value.tokensBefore === "number" &&
      Number.isInteger(value.tokensBefore) &&
      value.tokensBefore >= 0 &&
      typeof value.tokensAfterEstimate === "number" &&
      Number.isInteger(value.tokensAfterEstimate) &&
      value.tokensAfterEstimate >= 0 &&
      typeof value.createdAt === "string" &&
      !Number.isNaN(Date.parse(value.createdAt))
    );
  }
  return false;
}

function formatSessionTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(
    11,
    13,
  )}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

async function ensureSessionsDirectory(
  sessionsDirectory: string,
): Promise<SessionStoreResult<void>> {
  try {
    await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
    const info = await stat(sessionsDirectory);
    if (!info.isDirectory()) {
      return failure("SUSAN_SESSION_DIRECTORY", "Session path is not a directory", sessionsDirectory);
    }
    if (platform !== "win32" && (info.mode & 0o777) !== 0o700) {
      return failure(
        "SUSAN_SESSION_PERMISSION",
        "Sessions directory must use mode 0700",
        sessionsDirectory,
      );
    }
    return success(undefined);
  } catch (error) {
    return failure(
      "SUSAN_SESSION_DIRECTORY",
      error instanceof Error ? error.message : "Unable to prepare sessions directory",
      sessionsDirectory,
    );
  }
}

async function findSessionFilePath(
  sessionsDirectory: string,
  sessionId: string,
): Promise<string | undefined> {
  const entries = await readdir(sessionsDirectory, { withFileTypes: true });
  return entries.find(
    (entry) =>
      entry.isFile() &&
      entry.name.endsWith(`-${sessionId}.jsonl`),
  )?.name;
}

function parseSessionText(
  text: string,
  filePath: string,
): SessionStoreResult<{
  header: SessionHeader;
  records: readonly SessionRecord[];
}> {
  const lines = text.split("\n");
  const hasTrailingNewline = text.endsWith("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length === 0) {
    return failure("SUSAN_SESSION_SCHEMA", "Session file is empty", filePath);
  }

  const header = parseJsonLine(lines[0]!, filePath, 1);
  if (!header.ok) {
    return header;
  }
  if (!isSessionHeader(header.value)) {
    return failure("SUSAN_SESSION_SCHEMA", "Invalid session header", filePath);
  }

  const records: SessionRecord[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const parsed = parseJsonLine(line, filePath, index + 1);
    if (!parsed.ok) {
      if (index === lines.length - 1 && !hasTrailingNewline) {
        break;
      }
      return parsed;
    }
    if (!isSessionRecord(parsed.value)) {
      return failure(
        "SUSAN_SESSION_SCHEMA",
        `Invalid session record on line ${index + 1}`,
        filePath,
      );
    }
    records.push(parsed.value);
  }

  return success({ header: header.value, records });
}

function parseJsonLine(
  line: string,
  filePath: string,
  lineNumber: number,
): SessionStoreResult<unknown> {
  if (line.length === 0) {
    return failure(
      "SUSAN_SESSION_SCHEMA",
      `Blank JSONL line ${lineNumber}`,
      filePath,
    );
  }
  try {
    return success(JSON.parse(line));
  } catch {
    return failure(
      "SUSAN_SESSION_SCHEMA",
      `Invalid JSON on line ${lineNumber}`,
      filePath,
    );
  }
}

async function readSessionFile(
  filePath: string,
): Promise<SessionStoreResult<string>> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return failure("SUSAN_SESSION_DIRECTORY", "Session path is not a file", filePath);
    }
    if (platform !== "win32" && (info.mode & 0o777) !== 0o600) {
      return failure(
        "SUSAN_SESSION_PERMISSION",
        "Session file must use mode 0600",
        filePath,
      );
    }
    return success(await readFile(filePath, "utf8"));
  } catch (error) {
    return failure(
      "SUSAN_SESSION_IO",
      error instanceof Error ? error.message : "Unable to read session file",
      filePath,
    );
  }
}

function transcriptFromParsed(
  header: SessionHeader,
  records: readonly SessionRecord[],
  filePath: string,
): SessionTranscript {
  return {
    header,
    records,
    messages: records
      .filter((record): record is SessionMessageRecord => record.type === "message")
      .map((record) => record.message),
    filePath,
  };
}

function titleFromRecords(records: readonly SessionRecord[]): string {
  const firstUserMessage = records.find(
    (record): record is SessionMessageRecord =>
      record.type === "message" && record.message.role === "user",
  );
  if (
    firstUserMessage === undefined ||
    firstUserMessage.message.role !== "user" ||
    typeof firstUserMessage.message.content !== "string" ||
    firstUserMessage.message.content.length === 0
  ) {
    return "New session";
  }
  return firstUserMessage.message.content.slice(0, 40);
}

export function createSessionStore(
  options: SessionStoreOptions = {},
): SessionStore {
  const sessionsDirectory = resolve(options.sessionsDirectory ?? DEFAULT_SESSIONS_DIRECTORY);

  return {
    async createSession({ cwd }) {
      const prepared = await ensureSessionsDirectory(sessionsDirectory);
      if (!prepared.ok) {
        return prepared;
      }
      if (cwd.length === 0) {
        return failure("SUSAN_SESSION_SCHEMA", "cwd must be a non-empty string");
      }
      const resolvedCwd = resolve(cwd);
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const header: SessionHeader = {
        type: "session",
        version: 1,
        id,
        createdAt,
        cwd: resolvedCwd,
      };
      const filePath = join(
        sessionsDirectory,
        `${formatSessionTimestamp(new Date(createdAt))}-${id}.jsonl`,
      );

      try {
        const handle = await open(filePath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(header)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        return failure(
          "SUSAN_SESSION_IO",
          error instanceof Error ? error.message : "Unable to create session file",
          filePath,
        );
      }

      return success(transcriptFromParsed(header, [], filePath));
    },

    async appendMessage(sessionId, message) {
      const prepared = await ensureSessionsDirectory(sessionsDirectory);
      if (!prepared.ok) {
        return prepared;
      }
      if (!UUID_PATTERN.test(sessionId)) {
        return failure("SUSAN_SESSION_SCHEMA", "sessionId must be a UUID");
      }
      if (!isCompletionMessage(message)) {
        return failure("SUSAN_SESSION_SCHEMA", "message must be a valid CompletionMessage");
      }

      let fileName: string | undefined;
      try {
        fileName = await findSessionFilePath(sessionsDirectory, sessionId);
      } catch (error) {
        return failure(
          "SUSAN_SESSION_DIRECTORY",
          error instanceof Error ? error.message : "Unable to list sessions directory",
          sessionsDirectory,
        );
      }
      if (fileName === undefined) {
        return failure("SUSAN_SESSION_NOT_FOUND", "Session was not found", sessionsDirectory);
      }
      const filePath = join(sessionsDirectory, fileName);

      try {
        const text = await readSessionFile(filePath);
        if (!text.ok) {
          return text;
        }
        const parsed = parseSessionText(text.value, filePath);
        if (!parsed.ok) {
          return parsed;
        }
        const existing = text.value;
        if (!existing.endsWith("\n")) {
          const lastNewline = existing.lastIndexOf("\n");
          const lastLine = existing.slice(lastNewline + 1);
          try {
            JSON.parse(lastLine);
            await appendNewline(filePath);
          } catch {
            await truncate(filePath, lastNewline + 1);
          }
        }
        const handle = await open(filePath, "a");
        try {
          await handle.appendFile(`${JSON.stringify({ type: "message", message })}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        return failure(
          "SUSAN_SESSION_IO",
          error instanceof Error ? error.message : "Unable to append session record",
          filePath,
        );
      }

      return success(undefined);
    },

    async loadSession(sessionId) {
      const prepared = await ensureSessionsDirectory(sessionsDirectory);
      if (!prepared.ok) {
        return prepared;
      }
      if (!UUID_PATTERN.test(sessionId)) {
        return failure("SUSAN_SESSION_SCHEMA", "sessionId must be a UUID");
      }

      let fileName: string | undefined;
      try {
        fileName = await findSessionFilePath(sessionsDirectory, sessionId);
      } catch (error) {
        return failure(
          "SUSAN_SESSION_DIRECTORY",
          error instanceof Error ? error.message : "Unable to list sessions directory",
          sessionsDirectory,
        );
      }
      if (fileName === undefined) {
        return failure("SUSAN_SESSION_NOT_FOUND", "Session was not found", sessionsDirectory);
      }

      const filePath = join(sessionsDirectory, fileName);
      const text = await readSessionFile(filePath);
      if (!text.ok) {
        return text;
      }
      const parsed = parseSessionText(text.value, filePath);
      if (!parsed.ok) {
        return parsed;
      }
      return success(
        transcriptFromParsed(parsed.value.header, parsed.value.records, filePath),
      );
    },

    async listSessions() {
      const prepared = await ensureSessionsDirectory(sessionsDirectory);
      if (!prepared.ok) {
        return prepared;
      }

      let fileNames: string[];
      try {
        const entries = await readdir(sessionsDirectory, { withFileTypes: true });
        fileNames = entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => entry.name);
      } catch (error) {
        return failure(
          "SUSAN_SESSION_DIRECTORY",
          error instanceof Error ? error.message : "Unable to list sessions directory",
          sessionsDirectory,
        );
      }

      const summaries: SessionSummary[] = [];
      for (const fileName of fileNames) {
        const filePath = join(sessionsDirectory, fileName);
        const text = await readSessionFile(filePath);
        if (!text.ok) {
          return text;
        }
        const parsed = parseSessionText(text.value, filePath);
        if (!parsed.ok) {
          return parsed;
        }
        const info = await stat(filePath);
        summaries.push({
          header: parsed.value.header,
          title: titleFromRecords(parsed.value.records),
          recordCount: parsed.value.records.length,
          updatedAt: info.mtime.toISOString(),
          filePath,
        });
      }

      summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return success(summaries);
    },

    async loadLastSession() {
      const list = await this.listSessions();
      if (!list.ok) {
        return list;
      }
      if (list.value.length === 0) {
        return success(null);
      }
      return this.loadSession(list.value[0]!.header.id);
    },
  };
}

async function appendNewline(filePath: string): Promise<void> {
  const handle = await open(filePath, "a");
  try {
    await handle.appendFile("\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
