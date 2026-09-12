import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SUSAN_HOME,
  loadConfig,
  resolveSusanHome,
  updateConfigActiveModel,
} from "../src/index";
import type { JsonObject } from "../src/index";

const MIGRATION_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "migration",
);

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

  async function writeFixtureConfig(filename: string): Promise<string> {
    const fixturePath = join(MIGRATION_FIXTURES_DIR, filename);
    const value = JSON.parse(
      await readFile(fixturePath, "utf8"),
    ) as JsonObject;
    return writeConfig(value);
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
        defaultModel: undefined,
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

  it("resolves Model Catalog defaults and an Active Model Configuration", async () => {
    const configPath = await writeConfig({
      defaultProvider: "deepseek",
      defaultModel: "deepseek-v4-flash",
      defaultReasoningEffort: "max",
      providers: {
        deepseek: {
          type: "openai-completion",
          apiKey: "sk-test",
          models: [
            { id: "deepseek-v4-flash", contextWindow: 96_000 },
            { id: "deepseek-v4-thinking", maxOutputTokens: 8_192 },
          ],
        },
      },
    });

    const result = await loadConfig({ configPath });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.providers.deepseek?.models).toEqual([
        { id: "deepseek-v4-flash", contextWindow: 96_000 },
        { id: "deepseek-v4-thinking", maxOutputTokens: 8_192 },
      ]);
      expect(result.config.activeModel).toEqual({
        providerAlias: "deepseek",
        model: "deepseek-v4-flash",
        reasoningEffort: "max",
        contextWindow: 96_000,
        maxOutputTokens: 16_384,
        provider: {
          type: "openai-completion",
          apiKey: "sk-test",
          baseURL: new URL("https://api.deepseek.com/"),
        },
      });
    }
  });

  it("allows an incomplete model configuration without inventing defaults", async () => {
    const configPath = await writeConfig({
      providers: {
        deepseek: {
          type: "openai-completion",
          apiKey: "sk-test",
          models: [{ id: "deepseek-v4-flash" }],
        },
      },
    });

    const result = await loadConfig({ configPath });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.defaultProvider).toBeUndefined();
      expect(result.config.defaultModel).toBeUndefined();
      expect(result.config.defaultReasoningEffort).toBeUndefined();
      expect(result.config.activeModel).toBeUndefined();
    }
  });

  it("stores omitted-provider model preferences without activating them", async () => {
    const configPath = await writeConfig({
      defaultModel: "deepseek-v4-flash",
      defaultReasoningEffort: "medium",
      providers: {
        deepseek: {
          type: "openai-completion",
          apiKey: "sk-test",
          models: [{ id: "deepseek-v4-flash" }],
        },
      },
    });

    const result = await loadConfig({ configPath });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.defaultProvider).toBeUndefined();
      expect(result.config.defaultModel).toBe("deepseek-v4-flash");
      expect(result.config.defaultReasoningEffort).toBe("medium");
      expect(result.config.activeModel).toBeUndefined();
    }
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
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.defaultProvider).toBe("work");
      expect(result.config.provider?.apiKey).toBe("sk-work");
      expect(result.config.provider?.baseURL.href).toBe(
        "https://gateway.example/v1",
      );
      expect(result.config.providers.backup?.apiKey).toBeUndefined();
    }
  });

  it("keeps an omitted default provider inactive instead of selecting one", async () => {
    const configPath = await writeConfig({
      providers: {
        deepseek: {
          type: "openai-completion",
          apiKey: "sk-test",
        },
      },
    });

    const result = await loadConfig({ configPath });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.defaultProvider).toBeUndefined();
      expect(result.config.activeModel).toBeUndefined();
    }
  });

  it("rejects unknown fields and invalid values with structured schema issues", async () => {
    const configPath = await writeConfig({
      version: 2,
      unknownField: true,
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
      expect(paths).toContain("providers.work.type");
      expect(paths).toContain("providers.work.baseURL");
      expect(paths).toContain("providers.work.baseUrl");
    }
  });

  it("rejects the legacy approval field with a removal-oriented schema error", async () => {
    const configPath = await writeFixtureConfig(
      "legacy-approval-config.json",
    );

    const result = await loadConfig({ configPath });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SUSAN_CONFIG_SCHEMA");
      expect(result.error.issues).toEqual([
        {
          path: "approval",
          code: "unsupported_field",
          message: "The approval field is not supported and must be removed",
        },
      ]);
    }
  });

  it("loads the yolo-only migration fixture without approval", async () => {
    const configPath = await writeFixtureConfig("yolo-only-config.json");

    const result = await loadConfig({ configPath });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.defaultProvider).toBe("deepseek");
      expect("approval" in result.config).toBe(false);
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

  it("rejects malformed Model Catalog and active-selection fields", async () => {
    const cases: readonly JsonObject[] = [
      {
        defaultProvider: "deepseek",
        defaultModel: null,
        providers: {
          deepseek: {
            type: "openai-completion",
            apiKey: "sk-test",
            models: [{ id: "deepseek-v4-flash" }],
          },
        },
      },
      {
        defaultProvider: "deepseek",
        defaultModel: "",
        providers: {
          deepseek: {
            type: "openai-completion",
            apiKey: "sk-test",
            models: [{ id: "deepseek-v4-flash" }],
          },
        },
      },
      {
        defaultProvider: "deepseek",
        providers: {
          deepseek: {
            type: "openai-completion",
            apiKey: "sk-test",
            models: [],
          },
        },
      },
      {
        defaultProvider: "deepseek",
        providers: {
          deepseek: {
            type: "openai-completion",
            apiKey: "sk-test",
            models: [
              { id: "same-model" },
              { id: "same-model" },
            ],
          },
        },
      },
      {
        defaultProvider: "deepseek",
        defaultModel: "missing-model",
        providers: {
          deepseek: {
            type: "openai-completion",
            apiKey: "sk-test",
            models: [{ id: "deepseek-v4-flash" }],
          },
        },
      },
      {
        defaultProvider: "deepseek",
        defaultReasoningEffort: "extreme",
        providers: {
          deepseek: {
            type: "openai-completion",
            apiKey: "sk-test",
            models: [{ id: "deepseek-v4-flash" }],
          },
        },
      },
      {
        defaultModel: "deepseek-v4-flash",
        providers: {
          deepseek: {
            type: "openai-completion",
            apiKey: "sk-test",
            models: [{ id: "deepseek-v4-flash" }],
          },
        },
      },
      {
        providers: {
          "1": {
            type: "openai-completion",
            apiKey: "sk-test",
            models: [{ id: "deepseek-v4-flash" }],
          },
        },
      },
    ];

    for (const value of cases) {
      const configPath = await writeConfig(value);
      const result = await loadConfig({ configPath });
      expect(result.ok).toBe(false);
    }
  });

  it("persists an active model selection by merging the latest Config atomically", async () => {
    const configPath = await writeConfig({
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          type: "openai-completion",
          apiKey: "sk-old",
          baseURL: "https://gateway.example/v1",
          models: [{ id: "deepseek-v4-flash" }],
        },
        backup: {
          type: "openai-completion",
          apiKey: "sk-backup",
          models: [
            { id: "backup-model", contextWindow: 64_000 },
          ],
        },
      },
    });
    const original = await readFile(configPath, "utf8");
    const result = await updateConfigActiveModel(configPath, {
      providerAlias: "backup",
      model: "backup-model",
      reasoningEffort: "high",
    });

    expect(result.ok).toBe(true);
    const persisted = JSON.parse(await readFile(configPath, "utf8")) as JsonObject;
    expect(persisted).toMatchObject({
      defaultProvider: "backup",
      defaultModel: "backup-model",
      defaultReasoningEffort: "high",
    });
    expect(JSON.stringify(persisted)).not.toContain(original);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    if (result.ok) {
      expect(result.config.activeModel).toMatchObject({
        providerAlias: "backup",
        model: "backup-model",
        reasoningEffort: "high",
        contextWindow: 64_000,
        maxOutputTokens: 16_384,
      });
    }
  });

  it("does not rewrite Config when an active model selection is invalid", async () => {
    const configPath = await writeConfig({
      defaultProvider: "deepseek",
      providers: {
        deepseek: {
          type: "openai-completion",
          apiKey: "sk-test",
          models: [{ id: "deepseek-v4-flash" }],
        },
      },
    });
    const before = await readFile(configPath, "utf8");

    const result = await updateConfigActiveModel(configPath, {
      providerAlias: "deepseek",
      model: "not-in-catalog",
      reasoningEffort: "high",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SUSAN_CONFIG_SCHEMA" },
    });
    expect(await readFile(configPath, "utf8")).toBe(before);
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
    await writeFile(blankConfigPath, "null", "utf8");
    const nullResult = await loadConfig({ configPath: blankConfigPath });

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
    expect(nullResult).toMatchObject({
      ok: false,
      error: { code: "SUSAN_CONFIG_SCHEMA" },
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

describe("Susan Home", () => {
  let parent: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), "susan-home-"));
  });

  afterEach(async () => {
    await rm(parent, { force: true, recursive: true });
  });

  it("creates .susan under the parent and does not scaffold Config", async () => {
    const result = await resolveSusanHome(parent);

    expect(result).toEqual({
      ok: true,
      value: {
        path: join(parent, ".susan"),
        configPath: join(parent, ".susan", "config.json"),
        sessionsDirectory: join(parent, ".susan", "sessions"),
      },
    });
    const home = await stat(join(parent, ".susan"));
    expect(home.isDirectory()).toBe(true);
    if (platform !== "win32") {
      expect(home.mode & 0o777).toBe(0o700);
    }
    await expect(stat(join(parent, ".susan", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reuses an existing Susan Home without changing its mode", async () => {
    const homePath = join(parent, ".susan");
    await mkdir(homePath);
    await chmod(homePath, 0o755);

    const result = await resolveSusanHome(parent);

    expect(result).toMatchObject({
      ok: true,
      value: { path: homePath },
    });
    expect((await stat(homePath)).mode & 0o777).toBe(0o755);
  });

  it("defaults to the user home parent", async () => {
    expect(DEFAULT_SUSAN_HOME).toBe(join(homedir(), ".susan"));
    const result = await resolveSusanHome();
    expect(result).toMatchObject({
      ok: true,
      value: {
        path: DEFAULT_SUSAN_HOME,
        configPath: join(DEFAULT_SUSAN_HOME, "config.json"),
        sessionsDirectory: join(DEFAULT_SUSAN_HOME, "sessions"),
      },
    });
  });

  it("resolves a relative parent against process cwd", async () => {
    const previous = process.cwd();
    try {
      process.chdir(parent);
      const result = await resolveSusanHome(".");
      expect(result).toMatchObject({
        ok: true,
        value: { path: join(resolve("."), ".susan") },
      });
    } finally {
      process.chdir(previous);
    }
  });

  it("always appends .susan even when the parent is already named .susan", async () => {
    const nestedParent = join(parent, ".susan");
    await mkdir(nestedParent);

    const result = await resolveSusanHome(nestedParent);

    expect(result).toMatchObject({
      ok: true,
      value: { path: join(nestedParent, ".susan") },
    });
  });

  it("fails when the parent does not exist", async () => {
    const missing = join(parent, "missing");
    expect(await resolveSusanHome(missing)).toEqual({
      ok: false,
      error: {
        code: "SUSAN_HOME_PARENT_MISSING",
        path: missing,
        message: `Susan Home parent does not exist: ${missing}`,
      },
    });
  });

  it("fails when the parent is not a directory", async () => {
    const filePath = join(parent, "file");
    await writeFile(filePath, "not a directory");
    expect(await resolveSusanHome(filePath)).toEqual({
      ok: false,
      error: {
        code: "SUSAN_HOME_PARENT_NOT_DIRECTORY",
        path: filePath,
        message: `Susan Home parent is not a directory: ${filePath}`,
      },
    });
  });

  it("fails when .susan exists and is not a directory", async () => {
    const homePath = join(parent, ".susan");
    await writeFile(homePath, "not a directory");
    expect(await resolveSusanHome(parent)).toEqual({
      ok: false,
      error: {
        code: "SUSAN_HOME_NOT_DIRECTORY",
        path: homePath,
        message: `Susan Home is not a directory: ${homePath}`,
      },
    });
  });
});
