import type { ConfigError, ConfigErrorCode, ConfigIssue } from "./types";

export function configError(
  configPath: string,
  code: ConfigErrorCode,
  issues: readonly ConfigIssue[],
): { readonly ok: false; readonly error: ConfigError } {
  return {
    ok: false,
    error: {
      code,
      configPath,
      issues,
    },
  };
}
