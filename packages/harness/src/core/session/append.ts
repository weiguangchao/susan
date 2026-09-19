import { open, truncate } from "node:fs/promises";
import { join } from "node:path";
import { ensureSessionsDirectory, findSessionFilePath, readSessionFile } from "./files";
import { parseSessionText } from "./jsonl";
import { failure, success } from "./result";
import {
  UUID_PATTERN,
  isCompletionMessage,
  isProviderUsage,
  isSessionRecord,
} from "./schema";
import type {
  SessionRecord,
  SessionStore,
  SessionStoreResult,
  SessionUsageRecord,
} from "./types";

export function createSessionAppends(
  sessionsDirectory: string,
): Pick<SessionStore, "appendMessage" | "appendCompaction" | "appendUsage"> {
  return {
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

      return appendRecord(sessionsDirectory, sessionId, () =>
        success({ type: "message", message }),
      );
    },

    async appendCompaction(sessionId, checkpoint) {
      const prepared = await ensureSessionsDirectory(sessionsDirectory);
      if (!prepared.ok) {
        return prepared;
      }
      if (!UUID_PATTERN.test(sessionId)) {
        return failure("SUSAN_SESSION_SCHEMA", "sessionId must be a UUID");
      }
      if (!isSessionRecord(checkpoint) || checkpoint.type !== "compaction") {
        return failure(
          "SUSAN_SESSION_SCHEMA",
          "checkpoint must be a valid CompactionEntry",
        );
      }

      return appendRecord(sessionsDirectory, sessionId, () => success(checkpoint));
    },

    async appendUsage(sessionId, usage, modelConfiguration) {
      const prepared = await ensureSessionsDirectory(sessionsDirectory);
      if (!prepared.ok) {
        return prepared;
      }
      if (!UUID_PATTERN.test(sessionId)) {
        return failure("SUSAN_SESSION_SCHEMA", "sessionId must be a UUID");
      }
      if (!isProviderUsage(usage)) {
        return failure(
          "SUSAN_SESSION_SCHEMA",
          "usage must contain valid Provider token totals",
        );
      }

      return appendRecord(sessionsDirectory, sessionId, () => {
        const record: SessionUsageRecord = {
          type: "usage",
          usage,
          ...(modelConfiguration === undefined
            ? {}
            : {
                model: modelConfiguration.model,
                reasoningEffort: modelConfiguration.reasoningEffort,
              }),
        };
        if (!isSessionRecord(record)) {
          return failure(
            "SUSAN_SESSION_SCHEMA",
            "usage must contain valid Provider token totals",
          );
        }
        return success(record);
      });
    },
  };
}

async function appendRecord(
  sessionsDirectory: string,
  sessionId: string,
  buildRecord: () => SessionStoreResult<SessionRecord>,
): Promise<SessionStoreResult<void>> {
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
    // Usage model metadata is validated only after the existing file parses.
    const record = buildRecord();
    if (!record.ok) {
      return record;
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
      await handle.appendFile(`${JSON.stringify(record.value)}\n`, "utf8");
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
