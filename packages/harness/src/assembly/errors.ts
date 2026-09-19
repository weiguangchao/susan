import type { AssemblyError, AssemblyFailure } from "./types";

export function failure(
  stage: AssemblyError["stage"],
  code: string,
  message: string,
  path?: string,
): AssemblyFailure {
  return {
    kind: "startup-error",
    error: { stage, code, message, ...(path === undefined ? {} : { path }) },
  };
}
