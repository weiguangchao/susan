import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { platform } from "node:process";
import { z } from "zod";
import type {
  ProviderType,
  ResolvedProviderConfig,
} from "./provider.js";

export type ApprovalPolicy = "ask" | "yolo";

const providerTypeSchema = z.enum([
  "anthropic",
  "openai-completion",
  "responses",
] as const satisfies readonly ProviderType[]);

const providerEntrySchema = z.strictObject({
  type: providerTypeSchema,
  apiKey: z.string().min(1).optional(),
  baseURL: z
    .string()
    .url("baseURL must be an absolute http(s) URL")
    .refine(
      (value) => value.startsWith("http:") || value.startsWith("https:"),
      "baseURL must be an absolute http(s) URL",
    )
    .optional(),
});

const configSchema = z.strictObject({
  version: z.literal(1).default(1),
  defaultProvider: z.string().min(1).default("deepseek"),
  defaultModel: z.string().min(1).default("deepseek-v4-flash"),
  approval: z.enum(["ask", "yolo"]).default("ask"),
  providers: z
    .record(z.string().min(1), providerEntrySchema)
    .default({}),
});

const registeredProviderTypes: ReadonlyMap<ProviderType, string> = new Map([
  ["openai-completion", "https://api.deepseek.com"],
]);

export const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".susan",
  "config.json",
);

export type ProviderConfigEntry = z.input<typeof providerEntrySchema>;

export type Config = z.input<typeof configSchema>;

export type ResolvedProviderEntry = {
  type: ProviderType;
  apiKey?: string;
  baseURL: URL;
};

export type ResolvedConfig = {
  version: 1;
  defaultProvider: string;
  defaultModel: string;
  approval: ApprovalPolicy;
  providers: Readonly<Record<string, ResolvedProviderEntry>>;
  provider: ResolvedProviderConfig;
};

export type ConfigIssue = {
  path: string;
  code: string;
  message: string;
};

export type ConfigErrorCode =
  | "SUSAN_CONFIG_PARSE"
  | "SUSAN_CONFIG_MISSING"
  | "SUSAN_CONFIG_SCHEMA"
  | "SUSAN_CONFIG_PERMISSION"
  | "SUSAN_CONFIG_PROVIDER_UNKNOWN"
  | "SUSAN_CONFIG_API_KEY_MISSING"
  | "SUSAN_CONFIG_PROVIDER_TYPE_UNSUPPORTED";

export type ConfigError = {
  code: ConfigErrorCode;
  configPath: string;
  issues: readonly ConfigIssue[];
};

export type ConfigResult =
  | { readonly ok: true; readonly config: ResolvedConfig }
  | { readonly ok: false; readonly error: ConfigError };

export type ConfigLoadOptions = {
  readonly configPath?: string;
  readonly approval?: ApprovalPolicy;
};

export type ApprovalFlagsResult =
  | { readonly ok: true; readonly approval?: ApprovalPolicy }
  | { readonly ok: false; readonly issue: ConfigIssue };

type ConfigFileResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly error: ConfigError };

function configError(
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

function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0
    ? "(root)"
    : path.map((segment) => String(segment)).join(".");
}

function schemaIssues(error: z.ZodError): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        issues.push({
          path: issuePath([...issue.path, key]),
          code: issue.code,
          message: `Unrecognized key: ${String(key)}`,
        });
      }
      continue;
    }

    issues.push({
      path: issuePath(issue.path),
      code: issue.code,
      message: issue.message,
    });
  }

  return issues;
}

function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;
}

async function checkConfigPermissions(configPath: string): Promise<ConfigIssue[]> {
  if (platform === "win32") {
    return [];
  }

  const rootPath = dirname(configPath);
  const permissionTargets = [
    { path: rootPath, expectedMode: 0o700 },
    { path: join(rootPath, "sessions"), expectedMode: 0o700 },
    { path: configPath, expectedMode: 0o600 },
  ];
  const issues: ConfigIssue[] = [];

  for (const target of permissionTargets) {
    let targetMode: number;
    try {
      targetMode = (await stat(target.path)).mode;
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        continue;
      }

      issues.push({
        path: target.path,
        code: "permission_check_failed",
        message: `Unable to check permissions: ${target.path}`,
      });
      continue;
    }

    if ((targetMode & 0o077) !== 0) {
      issues.push({
        path: target.path,
        code: "permission_mode",
        message: `Expected ${formatMode(target.expectedMode)} or stricter, got ${formatMode(targetMode)}`,
      });
    }
  }

  return issues;
}

async function readConfigFile(configPath: string): Promise<ConfigFileResult> {
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

    throw error;
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

export function resolveConfig(
  config: Config,
  flags: { readonly approval?: ApprovalPolicy } = {},
  configPath: string = DEFAULT_CONFIG_PATH,
): ConfigResult {
  const parsedResult = configSchema.safeParse(config);

  if (!parsedResult.success) {
    return configError(
      configPath,
      "SUSAN_CONFIG_SCHEMA",
      schemaIssues(parsedResult.error),
    );
  }

  const parsed = parsedResult.data;
  const unsupportedIssues = Object.entries(parsed.providers)
    .filter(([, entry]) => !registeredProviderTypes.has(entry.type))
    .map(([alias, entry]) => ({
      path: `providers.${alias}.type`,
      code: "provider_type_unsupported",
      message: `Provider type ${entry.type} is not registered in this version`,
    }));

  if (unsupportedIssues.length > 0) {
    return configError(
      configPath,
      "SUSAN_CONFIG_PROVIDER_TYPE_UNSUPPORTED",
      unsupportedIssues,
    );
  }

  const provider = parsed.providers[parsed.defaultProvider];

  if (provider === undefined) {
    return configError(configPath, "SUSAN_CONFIG_PROVIDER_UNKNOWN", [
      {
        path: `providers.${parsed.defaultProvider}`,
        code: "provider_missing",
        message: `Default provider ${parsed.defaultProvider} is not configured`,
      },
    ]);
  }

  if (provider.apiKey === undefined) {
    return configError(configPath, "SUSAN_CONFIG_API_KEY_MISSING", [
      {
        path: `providers.${parsed.defaultProvider}.apiKey`,
        code: "api_key_missing",
        message: "Default provider requires an API key",
      },
    ]);
  }

  const resolvedProviders: Record<string, ResolvedProviderEntry> = {};
  for (const [alias, entry] of Object.entries(parsed.providers)) {
    resolvedProviders[alias] = {
      type: entry.type,
      apiKey: entry.apiKey,
      baseURL: new URL(
        entry.baseURL ?? registeredProviderTypes.get(entry.type)!,
      ),
    };
  }

  const resolvedProvider: ResolvedProviderConfig = {
    type: provider.type,
    apiKey: provider.apiKey,
    baseURL: resolvedProviders[parsed.defaultProvider].baseURL,
  };

  return {
    ok: true,
    config: {
      version: 1,
      defaultProvider: parsed.defaultProvider,
      defaultModel: parsed.defaultModel,
      approval: flags.approval ?? parsed.approval,
      providers: resolvedProviders,
      provider: resolvedProvider,
    },
  };
}

export async function loadConfig(
  options: ConfigLoadOptions = {},
): Promise<ConfigResult> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const permissionIssues = await checkConfigPermissions(configPath);

  if (permissionIssues.length > 0) {
    return configError(
      configPath,
      "SUSAN_CONFIG_PERMISSION",
      permissionIssues,
    );
  }

  const fileResult = await readConfigFile(configPath);
  if (!fileResult.ok) {
    return fileResult;
  }

  return resolveConfig(
    fileResult.config,
    { approval: options.approval },
    configPath,
  );
}

export function parseApprovalFlags(
  args: readonly string[],
): ApprovalFlagsResult {
  let approval: ApprovalPolicy | undefined;
  let yolo = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--yolo") {
      yolo = true;
    } else if (arg === "--approval") {
      const value = args[index + 1];
      if (value !== "ask" && value !== "yolo") {
        return {
          ok: false,
          issue: invalidApprovalFlagIssue(),
        };
      }
      approval = value;
      index += 1;
    } else if (arg.startsWith("--approval=")) {
      const value = arg.slice("--approval=".length);
      if (value !== "ask" && value !== "yolo") {
        return {
          ok: false,
          issue: invalidApprovalFlagIssue(),
        };
      }
      approval = value;
    }

    if (approval !== undefined && yolo) {
      return {
        ok: false,
        issue: {
          path: "--approval/--yolo",
          code: "flag_conflict",
          message: "--approval and --yolo cannot be used together",
        },
      };
    }
  }

  return {
    ok: true,
    approval: yolo ? "yolo" : approval,
  };
}

function invalidApprovalFlagIssue(): ConfigIssue {
  return {
    path: "--approval",
    code: "invalid_enum",
    message: "--approval must be ask or yolo",
  };
}
