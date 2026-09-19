import type { SessionStoreErrorCode, SessionStoreResult } from "./types";

export function success<T>(value: T): SessionStoreResult<T> {
  return { ok: true, value };
}

export function failure<T = void>(
  code: SessionStoreErrorCode,
  message: string,
  path?: string,
): SessionStoreResult<T> {
  return {
    ok: false,
    error: path === undefined ? { code, message } : { code, message, path },
  };
}
