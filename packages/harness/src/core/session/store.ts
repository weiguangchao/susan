import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createSessionAppends } from "./append";
import { ensureSessionsDirectory } from "./files";
import { createSessionQueries, transcriptFromParsed } from "./queries";
import { failure, success } from "./result";
import type { SessionHeader, SessionStore, SessionStoreOptions } from "./types";

export const DEFAULT_SESSIONS_DIRECTORY = join(
  homedir(),
  ".susan",
  "sessions",
);

function formatSessionTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(
    11,
    13,
  )}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

export function createSessionStore(
  options: SessionStoreOptions = {},
): SessionStore {
  const sessionsDirectory = resolve(options.sessionsDirectory ?? DEFAULT_SESSIONS_DIRECTORY);

  return {
    async createSession({ cwd, reuseEmpty = false }) {
      const prepared = await ensureSessionsDirectory(sessionsDirectory);
      if (!prepared.ok) {
        return prepared;
      }
      if (cwd.length === 0) {
        return failure("SUSAN_SESSION_SCHEMA", "cwd must be a non-empty string");
      }
      const resolvedCwd = resolve(cwd);
      if (reuseEmpty) {
        const listed = await this.listSessions();
        if (!listed.ok) {
          return listed;
        }
        const latest = listed.value[0];
        if (
          latest !== undefined &&
          latest.recordCount === 0 &&
          latest.header.cwd === resolvedCwd
        ) {
          return this.loadSession(latest.header.id);
        }
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const header: SessionHeader = {
        type: "session",
        version: 5,
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

    ...createSessionAppends(sessionsDirectory),
    ...createSessionQueries(sessionsDirectory),
  };
}
