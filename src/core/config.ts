import type {
  ProviderType,
  ResolvedProviderConfig,
} from "./provider.js";

export type ApprovalPolicy = "ask" | "yolo";

export type ProviderConfigEntry = {
  type: ProviderType;
  apiKey?: string;
  baseURL?: string;
};

export type Config = {
  version: 1;
  defaultProvider?: string;
  defaultModel?: string;
  approval?: ApprovalPolicy;
  providers?: Readonly<Record<string, ProviderConfigEntry>>;
};

export type ResolvedConfig = {
  defaultProvider: string;
  defaultModel: string;
  approval: ApprovalPolicy;
  providers: Readonly<Record<string, ResolvedProviderConfig>>;
};

export type ConfigIssue = {
  path: string;
  code: string;
  message: string;
};

export type ConfigErrorCode =
  | "SUSAN_CONFIG_PARSE"
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
