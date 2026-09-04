import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseApprovalFlags } from "../src/index.js";
import type { JsonObject } from "../src/index.js";

describe("config loading", () => {
  let configRoot: string;

  beforeEach(async () => {
    configRoot = await mkdtemp(join(tmpdir(), "susan-config-"));
  });

  afterEach(async () => {
    await rm(configRoot, { force: true, recursive: true });
  });

  async function writeConfig(
    value: JsonObject,
    modes: { config?: number; root?: number; sessions?: number } = {},
  ): Promise<string> {
    const sessionsPath = join(configRoot, "sessions");
    const configPath = join(configRoot, "config.json");

    await mkdir(sessionsPath, { recursive: true });
    await writeFile(configPath, JSON.stringify(value), "utf8");
    await chmod(configRoot, modes.root ?? 0o700);
    await chmod(sessionsPath, modes.sessions ?? 0o700);
    await chmod(configPath, modes.config ?? 0o600);

    return configPath;
  }

  it("merges empty defaults in memory without writing the config file", async () => {
    const value = {
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          type: "openai-completion",
          apiKey: "sk-test",
        },
      },
    };
    const configPath = await writeConfig(value);
    const before = {
      content: await readFile(configPath, "utf8"),
      mode: (await stat(configPath)).mode,
      mtimeMs: (await stat(configPath)).mtimeMs,
    };

    const result = await loadConfig({ configPath });

    expect(result).toMatchObject({
      ok: true,
      config: {
        defaultProvider: "deepseek",
        defaultModel: "",
        approval: "ask",
        provider: {
          type: "openai-completion",
          apiKey: "sk-test",
          baseURL: new URL("https://api.deepseek.com"),
        },
      },
    });
    expect(result.ok && result.config.providers.deepseek?.baseURL.href).toBe(
      "https://api.deepseek.com/",
    );
    expect({
      content: await readFile(configPath, "utf8"),
      mode: (await stat(configPath)).mode,
      mtimeMs: (await stat(configPath)).mtimeMs,
    }).toEqual(before);
  });

  it("resolves a custom default provider and allows other entries to lack API keys", async () => {
    const configPath = await writeConfig({
      defaultProvider: "work",
      providers: {
        work: {
          type: "openai-completion",
          apiKey: "sk-work",
          baseURL: "https://gateway.example/v1",
        },
        backup: {
          type: "openai-completion",
        },
      },
    });

    const result = await loadConfig({
      configPath,
      approval: "yolo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.defaultProvider).toBe("work");
      expect(result.config.approval).toBe("yolo");
      expect(result.config.provider.apiKey).toBe("sk-work");
      expect(result.config.provider.baseURL.href).toBe(
        "https://gateway.example/v1",
      );
      expect(result.config.providers.backup?.apiKey).toBeUndefined();
    }
  });

  it("reports an omitted default provider instead of selecting a provider by default", async () => {
    const configPath = await writeConfig({
      providers: {
        deepseek: {
          type: "openai-completion",
          apiKey: "sk-test",
        },
      },
    });

    const result = await loadConfig({ configPath });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "SUSAN_CONFIG_PROVIDER_UNKNOWN",
        issues: [{ path: "providers." }],
      },
    });
  });

  it("rejects unknown fields and invalid values with structured schema issues", async () => {
    const configPath = await writeConfig({
      version: 1,
      unknownField: true,
      approval: "always",
      providers: {
        work: {
          type: "not-a-provider",
          apiKey: "sk-work",
          baseURL: "ftp://example.invalid",
          baseUrl: "https://example.invalid",
        },
      },
    });

    const result = await loadConfig({ configPath });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SUSAN_CONFIG_SCHEMA");
      const paths = result.error.issues.map((issue) => issue.path);
      expect(paths).toContain("unknownField");
      expect(paths).toContain("version");
      expect(paths).toContain("approval");
      expect(paths).toContain("providers.work.type");
      expect(paths).toContain("providers.work.baseURL");
      expect(paths).toContain("providers.work.baseUrl");
    }
  });

  it("reports unknown and unsupported provider types separately", async () => {
    const unknownConfigPath = await writeConfig({
      defaultProvider: "deepseek",
      providers: {
        work: {
          type: "openai-completion",
          apiKey: "sk-work",
        },
      },
    });
    const unknownResult = await loadConfig({ configPath: unknownConfigPath });
    const unsupportedConfigPath = await writeConfig({
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          type: "openai-completion",
          apiKey: "sk-work",
        },
        work: {
          type: "anthropic",
        },
      },
    });
    const unsupportedResult = await loadConfig({
      configPath: unsupportedConfigPath,
    });

    expect(unknownResult).toMatchObject({
      ok: false,
      error: {
        code: "SUSAN_CONFIG_PROVIDER_UNKNOWN",
        issues: [{ path: "providers.deepseek" }],
      },
    });
    expect(unsupportedResult).toMatchObject({
      ok: false,
      error: {
        code: "SUSAN_CONFIG_PROVIDER_TYPE_UNSUPPORTED",
        issues: [{ path: "providers.work.type" }],
      },
    });
  });

  it("requires an API key only for the resolved default provider", async () => {
    const configPath = await writeConfig({
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          type: "openai-completion",
        },
      },
    });

    const result = await loadConfig({ configPath });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "SUSAN_CONFIG_API_KEY_MISSING",
        issues: [{ path: "providers.deepseek.apiKey" }],
      },
    });
  });

  it("reports missing, blank, and invalid config files", async () => {
    const missingResult = await loadConfig({
      configPath: join(configRoot, "config.json"),
    });
    const blankConfigPath = join(configRoot, "config.json");
    await writeFile(blankConfigPath, " \n\t", "utf8");
    await chmod(configRoot, 0o700);
    await chmod(blankConfigPath, 0o600);
    const blankResult = await loadConfig({ configPath: blankConfigPath });
    await writeFile(blankConfigPath, "{", "utf8");
    const parseResult = await loadConfig({ configPath: blankConfigPath });

    expect(missingResult).toMatchObject({
      ok: false,
      error: { code: "SUSAN_CONFIG_MISSING" },
    });
    expect(blankResult).toMatchObject({
      ok: false,
      error: { code: "SUSAN_CONFIG_PARSE" },
    });
    expect(parseResult).toMatchObject({
      ok: false,
      error: { code: "SUSAN_CONFIG_PARSE" },
    });
  });

  it("fails closed on overly permissive root, sessions, and config modes", async () => {
    const rootConfigPath = await writeConfig(
      { providers: {} },
      { root: 0o755 },
    );
    const rootResult = await loadConfig({ configPath: rootConfigPath });
    expect(rootResult).toMatchObject({
      ok: false,
      error: {
        code: "SUSAN_CONFIG_PERMISSION",
        issues: [{ path: configRoot }],
      },
    });

    const sessionsConfigPath = await writeConfig(
      { providers: {} },
      { sessions: 0o750 },
    );
    const sessionsResult = await loadConfig({
      configPath: sessionsConfigPath,
    });
    expect(sessionsResult).toMatchObject({
      ok: false,
      error: {
        code: "SUSAN_CONFIG_PERMISSION",
        issues: [{ path: join(configRoot, "sessions") }],
      },
    });

    const configConfigPath = await writeConfig(
      { providers: {} },
      { config: 0o640 },
    );
    const configResult = await loadConfig({ configPath: configConfigPath });
    expect(configResult).toMatchObject({
      ok: false,
      error: {
        code: "SUSAN_CONFIG_PERMISSION",
        issues: [{ path: configConfigPath }],
      },
    });

    expect((await stat(configConfigPath)).mode & 0o777).toBe(0o640);
  });
});

describe("approval flags", () => {
  it("parses approval flags and rejects their conflict", () => {
    expect(parseApprovalFlags(["--approval", "yolo"])).toEqual({
      ok: true,
      approval: "yolo",
    });
    expect(parseApprovalFlags(["--approval=ask"])).toEqual({
      ok: true,
      approval: "ask",
    });
    expect(parseApprovalFlags(["--yolo"])).toEqual({
      ok: true,
      approval: "yolo",
    });

    const conflict = parseApprovalFlags(["--approval", "ask", "--yolo"]);
    expect(conflict).toEqual({
      ok: false,
      issue: {
        path: "--approval/--yolo",
        code: "flag_conflict",
        message: "--approval and --yolo cannot be used together",
      },
    });
  });
});
