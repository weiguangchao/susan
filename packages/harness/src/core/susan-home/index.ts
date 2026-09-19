import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { platform } from "node:process";

export const DEFAULT_SUSAN_HOME = join(homedir(), ".susan");

export const DEFAULT_CONFIG_PATH = join(DEFAULT_SUSAN_HOME, "config.json");

export type SusanHome = {
  readonly path: string;
  readonly configPath: string;
  readonly sessionsDirectory: string;
};

export type SusanHomeErrorCode =
  | "SUSAN_HOME_PARENT_MISSING"
  | "SUSAN_HOME_PARENT_NOT_DIRECTORY"
  | "SUSAN_HOME_NOT_DIRECTORY"
  | "SUSAN_HOME_IO";

export type SusanHomeError = {
  readonly code: SusanHomeErrorCode;
  readonly path: string;
  readonly message: string;
};

export type SusanHomeResult =
  | { readonly ok: true; readonly value: SusanHome }
  | { readonly ok: false; readonly error: SusanHomeError };

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;
}

function susanHomeError(
  code: SusanHomeErrorCode,
  path: string,
  message: string,
): { readonly ok: false; readonly error: SusanHomeError } {
  return {
    ok: false,
    error: { code, path, message },
  };
}

export function formatSusanHomeError(error: SusanHomeError): string {
  return `susan: ${error.message}\n`;
}

export async function resolveSusanHome(
  parentDir?: string,
): Promise<SusanHomeResult> {
  const parent = resolve(parentDir ?? homedir());

  let parentInfo;
  try {
    parentInfo = await stat(parent);
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ENOENT") {
      return susanHomeError(
        "SUSAN_HOME_PARENT_MISSING",
        parent,
        `Susan Home parent does not exist: ${parent}`,
      );
    }
    if (code === "ENOTDIR") {
      return susanHomeError(
        "SUSAN_HOME_PARENT_NOT_DIRECTORY",
        parent,
        `Susan Home parent is not a directory: ${parent}`,
      );
    }
    return susanHomeError(
      "SUSAN_HOME_IO",
      parent,
      error instanceof Error
        ? error.message
        : `Unable to inspect Susan Home parent: ${parent}`,
    );
  }

  if (!parentInfo.isDirectory()) {
    return susanHomeError(
      "SUSAN_HOME_PARENT_NOT_DIRECTORY",
      parent,
      `Susan Home parent is not a directory: ${parent}`,
    );
  }

  const path = join(parent, ".susan");
  try {
    const homeInfo = await stat(path);
    if (!homeInfo.isDirectory()) {
      return susanHomeError(
        "SUSAN_HOME_NOT_DIRECTORY",
        path,
        `Susan Home is not a directory: ${path}`,
      );
    }
  } catch (error) {
    if (nodeErrorCode(error) !== "ENOENT") {
      return susanHomeError(
        "SUSAN_HOME_IO",
        path,
        error instanceof Error
          ? error.message
          : `Unable to inspect Susan Home: ${path}`,
      );
    }

    try {
      await mkdir(path, { mode: 0o700 });
      if (platform !== "win32") {
        await chmod(path, 0o700);
      }
    } catch (createError) {
      return susanHomeError(
        "SUSAN_HOME_IO",
        path,
        createError instanceof Error
          ? createError.message
          : `Unable to create Susan Home: ${path}`,
      );
    }
  }

  return {
    ok: true,
    value: {
      path,
      configPath: join(path, "config.json"),
      sessionsDirectory: join(path, "sessions"),
    },
  };
}
