import type { ConfigError, ConfigErrorCode } from "./config.js";

export type ConfigErrorIssueView = {
  readonly path: string;
  readonly message: string;
};

export type ConfigErrorView = {
  readonly heading: string;
  readonly code: ConfigErrorCode;
  readonly configPath: string;
  readonly issues: readonly ConfigErrorIssueView[];
  readonly example: string | null;
  readonly hint: string;
};

const MINIMAL_CONFIG_EXAMPLE = `{
  "providers": {
    "deepseek": {
      "type": "openai-completion",
      "apiKey": "sk-..."
    }
  }
}`;

const HEADINGS: Record<ConfigErrorCode, string> = {
  SUSAN_CONFIG_MISSING: "Config 文件不存在",
  SUSAN_CONFIG_PARSE: "Config 无法解析",
  SUSAN_CONFIG_SCHEMA: "Config schema 无效",
  SUSAN_CONFIG_PERMISSION: "Config 权限不安全",
  SUSAN_CONFIG_PROVIDER_UNKNOWN: "默认 Provider 未配置",
  SUSAN_CONFIG_API_KEY_MISSING: "默认 Provider 缺少 API key",
  SUSAN_CONFIG_PROVIDER_TYPE_UNSUPPORTED: "Provider type 未注册",
};

function redactSecrets(value: string): string {
  return value.replace(/sk-[A-Za-z0-9_-]{4,}/g, "sk-...");
}

export function formatConfigError(error: ConfigError): ConfigErrorView {
  return {
    heading: HEADINGS[error.code],
    code: error.code,
    configPath: redactSecrets(error.configPath),
    issues: error.issues.map((issue) => ({
      path: redactSecrets(issue.path),
      message: redactSecrets(issue.message),
    })),
    example: error.code === "SUSAN_CONFIG_MISSING" ? MINIMAL_CONFIG_EXAMPLE : null,
    hint: "r 重新读取 · Esc 退出",
  };
}
