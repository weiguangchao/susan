import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { failure } from "./errors";
import type { AssemblyFailure } from "./types";

export async function validateCwd(
  cwd: string,
): Promise<AssemblyFailure | undefined> {
  try {
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
      throw new Error("Session cwd must be an accessible absolute directory");
    await access(cwd, constants.R_OK | constants.X_OK);
  } catch (error) {
    return failure(
      "cwd",
      "SUSAN_ASSEMBLY_CWD_UNAVAILABLE",
      error instanceof Error ? error.message : "Session cwd is unavailable",
      cwd,
    );
  }
}
