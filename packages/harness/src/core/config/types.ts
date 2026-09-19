import type { z } from "zod";
import type { ProviderType, ResolvedProviderConfig, ReasoningEffort } from "../provider";
import type { configSchema, providerEntrySchema } from "./schema";

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

export type ConfigFileResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly error: ConfigError };
