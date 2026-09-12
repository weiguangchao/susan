import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:process";
import { z } from "zod";
import type {
  ProviderAdapter,
  ProviderType,
  ResolvedProviderConfig,
  ReasoningEffort,
} from "./provider";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  REASONING_EFFORTS,
  REASONING_EFFORT_VALUES,
} from "./provider";

const providerTypeSchema = z.enum([
  "anthropic",
  "openai-completion",
  "responses",
] as const satisfies readonly ProviderType[]);

const reasoningEffortSchema = z.enum(REASONING_EFFORT_VALUES);

const providerAliasSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !/^\d+$/.test(value),
    "Provider alias must not be an integer-like string",
  );

const modelEntrySchema = z.strictObject({
  input: z.array(z.enum(["text", "image"])).min(1).optional(),
  id: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

const modelCatalogSchema = z
  .array(modelEntrySchema)
  .min(1)
  .superRefine((models, context) => {
    const seen = new Set<string>();
    for (const [index, model] of models.entries()) {
      if (seen.has(model.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `Duplicate model id: ${model.id}`,
        });
      }
      seen.add(model.id);
    }
  });

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
  models: modelCatalogSchema.optional(),
});

const configSchema = z.strictObject({
  defaultProvider: providerAliasSchema.optional(),
  defaultModel: z.string().min(1).optional(),
  defaultReasoningEffort: reasoningEffortSchema.optional(),
  providers: z
    .record(providerAliasSchema, providerEntrySchema)
    .default({}),
});

export const DEFAULT_SUSAN_HOME = join(homedir(), ".susan");

export const DEFAULT_CONFIG_PATH = join(DEFAULT_SUSAN_HOME, "config.json");

export type ProviderConfigEntry = z.input<typeof providerEntrySchema>;

export type Config = z.input<typeof configSchema>;

export type ResolvedModelEntry = {
  input?: readonly ("text" | "image")[];
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
};

export type ResolvedProviderEntry = {
  type: ProviderType;
  apiKey?: string;
  baseURL: URL;
  models?: readonly ResolvedModelEntry[];
};

export type ActiveModelConfiguration = {
  modelInput?: readonly ("text" | "image")[];
  providerAlias: string;
  provider: ResolvedProviderConfig;
  model: string;
  reasoningEffort: ReasoningEffort;
  contextWindow: number;
  maxOutputTokens: number;
};

export type ActiveModelSelection = {
  providerAlias: string;
  model: string;
  reasoningEffort: ReasoningEffort;
};

export type ResolvedConfig = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  providers: Readonly<Record<string, ResolvedProviderEntry>>;
  provider?: ResolvedProviderConfig;
  activeModel?: ActiveModelConfiguration;
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
  | "SUSAN_CONFIG_PROVIDER_TYPE_UNSUPPORTED"
  | "SUSAN_CONFIG_IO";

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
};

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

function hasApprovalField(config: Config): boolean {
  return (
    typeof config === "object" &&
    config !== null &&
    Object.prototype.hasOwnProperty.call(config, "approval")
  );
}

export function resolveConfig(
  providerAdapters: ReadonlyMap<ProviderType, ProviderAdapter>,
  config: Config,
  configPath: string = DEFAULT_CONFIG_PATH,
): ConfigResult {
  if (hasApprovalField(config)) {
    return configError(configPath, "SUSAN_CONFIG_SCHEMA", [
      {
        path: "approval",
        code: "unsupported_field",
        message: "The approval field is not supported and must be removed",
      },
    ]);
  }

  const parsedResult = configSchema.safeParse(config);

  if (!parsedResult.success) {
    return configError(
      configPath,
      "SUSAN_CONFIG_SCHEMA",
      schemaIssues(parsedResult.error),
    );
  }

  const parsed = parsedResult.data;
  if (
    parsed.defaultProvider === undefined &&
    (parsed.defaultModel === undefined) !==
      (parsed.defaultReasoningEffort === undefined)
  ) {
    return configError(configPath, "SUSAN_CONFIG_SCHEMA", [
      {
        path: "defaultModel/defaultReasoningEffort",
        code: "model_preference_pair",
        message:
          "defaultModel and defaultReasoningEffort must both be omitted or both be present when defaultProvider is omitted",
      },
    ]);
  }

  const unsupportedIssues = Object.entries(parsed.providers)
    .filter(([, entry]) => !providerAdapters.has(entry.type))
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

  const defaultProvider =
    parsed.defaultProvider === undefined
      ? undefined
      : parsed.providers[parsed.defaultProvider];

  if (parsed.defaultProvider !== undefined && defaultProvider === undefined) {
    return configError(configPath, "SUSAN_CONFIG_PROVIDER_UNKNOWN", [
      {
        path: `providers.${parsed.defaultProvider}`,
        code: "provider_missing",
        message: `Default provider ${parsed.defaultProvider} is not configured`,
      },
    ]);
  }

  if (defaultProvider !== undefined && defaultProvider.apiKey === undefined) {
    return configError(configPath, "SUSAN_CONFIG_API_KEY_MISSING", [
      {
        path: `providers.${parsed.defaultProvider}.apiKey`,
        code: "api_key_missing",
        message: "Default provider requires an API key",
      },
    ]);
  }

  if (
    defaultProvider !== undefined &&
    parsed.defaultModel !== undefined &&
    !(defaultProvider.models ?? []).some(
      (model) => model.id === parsed.defaultModel,
    )
  ) {
    return configError(configPath, "SUSAN_CONFIG_SCHEMA", [
      {
        path: "defaultModel",
        code: "model_missing",
        message: "defaultModel must belong to the default provider Model Catalog",
      },
    ]);
  }

  if (
    defaultProvider !== undefined &&
    parsed.defaultReasoningEffort !== undefined &&
    !REASONING_EFFORTS[defaultProvider.type].includes(
      parsed.defaultReasoningEffort,
    )
  ) {
    return configError(configPath, "SUSAN_CONFIG_SCHEMA", [
      {
        path: "defaultReasoningEffort",
        code: "reasoning_effort_unsupported",
        message:
          "defaultReasoningEffort must belong to the default provider Provider Type",
      },
    ]);
  }

  const resolvedProviders: Record<string, ResolvedProviderEntry> = {};
  for (const [alias, entry] of Object.entries(parsed.providers)) {
    resolvedProviders[alias] = {
      type: entry.type,
      apiKey: entry.apiKey,
      baseURL: new URL(
        entry.baseURL ?? providerAdapters.get(entry.type)!.defaultBaseURL,
      ),
      models: entry.models,
    };
  }

  const resolvedProvider =
    defaultProvider === undefined
      ? undefined
      : {
          type: defaultProvider.type,
          apiKey: defaultProvider.apiKey!,
          baseURL: resolvedProviders[parsed.defaultProvider!].baseURL,
        };

  const selectedModel =
    parsed.defaultModel === undefined
      ? undefined
      : defaultProvider?.models?.find(
          (model) => model.id === parsed.defaultModel,
        );
  const activeModel =
    parsed.defaultProvider === undefined ||
    parsed.defaultModel === undefined ||
    parsed.defaultReasoningEffort === undefined ||
    defaultProvider === undefined
      ? undefined
      : {
          providerAlias: parsed.defaultProvider,
          provider: resolvedProvider!,
          model: parsed.defaultModel,
          modelInput: selectedModel?.input,
          reasoningEffort: parsed.defaultReasoningEffort,
          contextWindow:
            selectedModel?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
          maxOutputTokens:
            selectedModel?.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
        };

  return {
    ok: true,
    config: {
      defaultProvider: parsed.defaultProvider,
      defaultModel: parsed.defaultModel,
      defaultReasoningEffort: parsed.defaultReasoningEffort,
      providers: resolvedProviders,
      ...(resolvedProvider === undefined ? {} : { provider: resolvedProvider }),
      ...(activeModel === undefined ? {} : { activeModel }),
    },
  };
}

export async function loadConfig(
  providerAdapters: ReadonlyMap<ProviderType, ProviderAdapter>,
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
    providerAdapters,
    fileResult.config,
    configPath,
  );
}

export async function updateConfigActiveModel(
  providerAdapters: ReadonlyMap<ProviderType, ProviderAdapter>,
  configPath: string,
  selection: ActiveModelSelection,
): Promise<ConfigResult> {
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

  const merged: Config = {
    ...fileResult.config,
    defaultProvider: selection.providerAlias,
    defaultModel: selection.model,
    defaultReasoningEffort: selection.reasoningEffort,
  };
  const resolved = resolveConfig(providerAdapters, merged, configPath);
  if (!resolved.ok) {
    return resolved;
  }

  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(merged, null, 2)}\n`, {
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

  return resolved;
}
