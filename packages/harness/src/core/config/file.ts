import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { configError } from "./errors";
import type { Config, ConfigError, ConfigFileResult } from "./types";

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;
}

export async function readConfigFile(configPath: string): Promise<ConfigFileResult> {
  let bytes: Uint8Array;

  try {
    bytes = await readFile(configPath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return configError(configPath, "SUSAN_CONFIG_MISSING", [
        {
          path: configPath,
          code: "file_missing",
          message: "Config file does not exist",
        },
      ]);
    }

    if (nodeErrorCode(error) === "EACCES") {
      return configError(configPath, "SUSAN_CONFIG_PERMISSION", [
        {
          path: configPath,
          code: "permission_denied",
          message: "Config file is not readable",
        },
      ]);
    }

    return configError(configPath, "SUSAN_CONFIG_IO", [{
      path: configPath,
      code: "read_failed",
      message: "Unable to read the Config file",
    }]);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return configError(configPath, "SUSAN_CONFIG_PARSE", [
      {
        path: configPath,
        code: "invalid_utf8",
        message: "Config file must be UTF-8 JSON",
      },
    ]);
  }

  if (text.trim().length === 0) {
    return configError(configPath, "SUSAN_CONFIG_PARSE", [
      {
        path: configPath,
        code: "empty_file",
        message: "Config file is empty",
      },
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return configError(configPath, "SUSAN_CONFIG_PARSE", [
      {
        path: configPath,
        code: "invalid_json",
        message: error instanceof Error ? error.message : "Invalid JSON",
      },
    ]);
  }

  return {
    ok: true,
    config: parsed as Config,
  };
}

export async function writeConfigFile(
  configPath: string,
  config: Config,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: ConfigError }> {
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, configPath);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    return configError(configPath, "SUSAN_CONFIG_IO", [
      {
        path: configPath,
        code: "write_failed",
        message: "Unable to atomically write the Config file",
      },
    ]);
  }

  return { ok: true };
}
