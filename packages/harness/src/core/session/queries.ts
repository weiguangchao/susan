import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { ensureSessionsDirectory, findSessionFilePath, readSessionFile } from "./files";
import { isUnsupportedVersionSession, parseSessionText } from "./jsonl";
import { failure, success } from "./result";
import { UUID_PATTERN } from "./schema";
import type {
  SessionHeader,
  SessionMessageRecord,
  SessionRecord,
  SessionStore,
  SessionSummary,
  SessionTranscript,
} from "./types";

export function transcriptFromParsed(
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

export function createSessionQueries(
  sessionsDirectory: string,
): Pick<SessionStore, "loadSession" | "listSessions" | "loadLastSession" | "loadInputHistory"> {
  return {
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
        if (isUnsupportedVersionSession(text.value)) {
          continue;
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
    async loadInputHistory() {
      const list = await this.listSessions();
      if (!list.ok) {
        return list;
      }

      const inputHistory: string[] = [];
      for (const summary of [...list.value].reverse()) {
        const loaded = await this.loadSession(summary.header.id);
        if (!loaded.ok) {
          return loaded;
        }
        for (const message of loaded.value.messages) {
          if (message.role === "user" && message.content.length > 0) {
            inputHistory.push(message.content);
          }
        }
      }
      return success(inputHistory);
    },
  };
}
