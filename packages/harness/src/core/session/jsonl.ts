import { failure, success } from "./result";
import {
  isSessionHeaderShape,
  isSupportedSessionFormatVersion,
  isSessionHeader,
  isSessionRecord,
} from "./schema";
import type { SessionHeader, SessionRecord, SessionStoreResult } from "./types";

/** 旧格式 Session（version < 5）不迁移也不回放：列表与历史直接跳过。 */
export function isUnsupportedVersionSession(text: string): boolean {
  const firstNewline = text.indexOf("\n");
  const headerLine =
    firstNewline === -1 ? text : text.slice(0, firstNewline);
  try {
    const header: unknown = JSON.parse(headerLine);
    return isSessionHeaderShape(header) && !isSupportedSessionFormatVersion(header.version);
  } catch {
    return false;
  }
}

export function parseSessionText(
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
  if (
    isSessionHeaderShape(header.value) &&
    !isSupportedSessionFormatVersion(header.value.version)
  ) {
    return failure(
      "SUSAN_SESSION_SCHEMA",
      "Unsupported Session Format Version",
      filePath,
    );
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
