import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { platform } from "node:process";
import { failure, success } from "./result";
import type { SessionStoreResult } from "./types";

export async function ensureSessionsDirectory(
  sessionsDirectory: string,
): Promise<SessionStoreResult<void>> {
  try {
    await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
    const info = await stat(sessionsDirectory);
    if (!info.isDirectory()) {
      return failure("SUSAN_SESSION_DIRECTORY", "Session path is not a directory", sessionsDirectory);
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

export async function findSessionFilePath(
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

export async function readSessionFile(
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
