import { render } from "ink";
import {
  createProviderClient,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  updateConfigActiveModel,
} from "./config.js";
import type { ApprovalPolicy, ConfigError, ResolvedConfig } from "./core/config.js";
import { formatCliError, parseCli, type ResumeMode } from "./core/cli.js";
import { formatConfigError } from "./core/config-error.js";
import { createHarness, type Harness } from "./core/harness.js";
import { resolveSessionLaunch } from "./core/launch.js";
import type {
  ModelPickerCatalog,
} from "./core/model-picker.js";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
} from "./core/provider.js";
import { readFileTool } from "./core/read-file.js";
import {
  createSessionStore,
  type SessionStore,
  type SessionSummary,
  type SessionTranscript,
} from "./core/session.js";
import { ConfigErrorApp } from "./ui/config-error.js";
import { SessionPickerApp } from "./ui/session-picker.js";
import { TuiApp } from "./ui/tui.js";

const TTY_REQUIRED = "susan: TUI requires an interactive terminal\n";

type SessionStart =
  | { readonly ok: true; readonly session: SessionTranscript }
  | { readonly ok: false; readonly exitCode: number };

export async function runCli(argv: readonly string[]): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed.ok) {
    process.stderr.write(formatCliError(parsed.error));
    return 1;
  }

  const store = createSessionStore();
  const inputHistory = await loadInputHistory(store);
  if (!inputHistory.ok) {
    process.stderr.write(
      `susan: ${inputHistory.error.message}\n`,
    );
    return 1;
  }
  const loadedConfig = await loadResolvedConfig(
    parsed.flags.approval,
    parsed.flags.configPath,
  );
  if (!loadedConfig.ok) {
    return loadedConfig.exitCode;
  }
  let config = loadedConfig.config;
  const configPath = parsed.flags.configPath ?? DEFAULT_CONFIG_PATH;

  const started = await resolveStartupSession(store, parsed.flags.resume);
  if (!started.ok) {
    return started.exitCode;
  }

  if (!isInteractive()) {
    process.stderr.write(TTY_REQUIRED);
    return 1;
  }

  let harness;
  try {
    harness = createSusanHarness(config, store, started.session);
  } catch (error) {
    process.stderr.write(
      `susan: ${error instanceof Error ? error.message : "Unable to start Session"}\n`,
    );
    return 1;
  }

  const instance = render(
    <TuiApp
      harness={harness}
      inputHistory={inputHistory.value}
      startNewSession={() => createNewSusanSession(config, store)}
      modelCatalog={modelPickerCatalog(config)}
      applyModelSelection={async (selection) => {
        const updated = await updateConfigActiveModel(configPath, selection);
        if (!updated.ok) {
          return {
            ok: false,
            message: formatConfigError(updated.error).heading,
          };
        }
        const activeModel = updated.config.activeModel;
        if (activeModel === undefined) {
          return { ok: false, message: "模型配置未完整" };
        }
        config = {
          ...updated.config,
          approval: config.approval,
        };
        return {
          ok: true,
          command: {
            type: "configure-model",
            provider: createProviderClient(activeModel.provider),
            model: activeModel.model,
            reasoningLevel: activeModel.reasoningEffort,
            contextWindow: activeModel.contextWindow,
            maxOutputTokens: activeModel.maxOutputTokens,
          },
        };
      }}
    />,
  );
  await instance.waitUntilExit();
  return 0;
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function loadInputHistory(
  store: SessionStore,
): Promise<
  | { readonly ok: true; readonly value: readonly string[] }
  | { readonly ok: false; readonly error: { readonly message: string } }
> {
  const result = await store.loadInputHistory();
  if (result.ok) {
    return result;
  }
  return { ok: false, error: result.error };
}

type ConfigStart =
  | { readonly ok: true; readonly config: ResolvedConfig }
  | { readonly ok: false; readonly exitCode: number };

async function loadResolvedConfig(
  approval: ApprovalPolicy | undefined,
  configPath: string | undefined,
): Promise<ConfigStart> {
  while (true) {
    const loaded = await loadConfig({ approval, configPath });
    if (loaded.ok) {
      return { ok: true, config: loaded.config };
    }
    if (!isInteractive()) {
      process.stderr.write(formatConfigErrorText(loaded.error));
      return { ok: false, exitCode: 1 };
    }
    const action = await showConfigError(loaded.error);
    if (action === "exit") {
      return { ok: false, exitCode: 0 };
    }
  }
}

function formatConfigErrorText(error: ConfigError): string {
  const view = formatConfigError(error);
  const lines = [
    `susan: ${view.heading}`,
    view.code,
    view.configPath,
    ...view.issues.map((issue) => `${issue.path}: ${issue.message}`),
  ];
  if (view.example !== null) {
    lines.push("", "最小 Config 示例：", view.example);
  }
  return `${lines.join("\n")}\n`;
}

async function resolveStartupSession(
  store: SessionStore,
  resume: ResumeMode,
): Promise<SessionStart> {
  const launch = await resolveSessionLaunch(store, resume);
  if (launch.kind === "error") {
    process.stderr.write(`susan: ${launch.error.message}\n`);
    return { ok: false, exitCode: 1 };
  }
  if (launch.kind === "resume") {
    return { ok: true, session: launch.session };
  }
  if (launch.kind === "new") {
    return createSessionResult(store, true);
  }
  if (!isInteractive()) {
    process.stderr.write(TTY_REQUIRED);
    return { ok: false, exitCode: 1 };
  }

  const picked = await showSessionPicker(launch.sessions);
  if (picked === "exit") {
    return { ok: false, exitCode: 0 };
  }
  if (picked === "new") {
    return createSessionResult(store, true);
  }
  const loaded = await store.loadSession(picked);
  if (!loaded.ok) {
    process.stderr.write(`susan: ${loaded.error.message}\n`);
    return { ok: false, exitCode: 1 };
  }
  return { ok: true, session: loaded.value };
}

async function createSessionResult(
  store: SessionStore,
  reuseEmpty = false,
): Promise<SessionStart> {
  const created = await store.createSession({
    cwd: process.cwd(),
    reuseEmpty,
  });
  if (!created.ok) {
    process.stderr.write(`susan: ${created.error.message}\n`);
    return { ok: false, exitCode: 1 };
  }
  return { ok: true, session: created.value };
}

async function showConfigError(
  error: ConfigError,
): Promise<"reload" | "exit"> {
  return new Promise((resolve) => {
    const instance = render(
      <ConfigErrorApp
        view={formatConfigError(error)}
        onReload={() => {
          instance.unmount();
          resolve("reload");
        }}
        onExit={() => {
          instance.unmount();
          resolve("exit");
        }}
      />,
    );
  });
}

async function showSessionPicker(
  sessions: readonly SessionSummary[],
): Promise<string | "new" | "exit"> {
  return new Promise((resolve) => {
    const instance = render(
      <SessionPickerApp
        sessions={sessions}
        onSelect={(sessionId) => {
          instance.unmount();
          resolve(sessionId);
        }}
        onNew={() => {
          instance.unmount();
          resolve("new");
        }}
        onExit={() => {
          instance.unmount();
          resolve("exit");
        }}
      />,
    );
  });
}

function createSusanHarness(
  config: ResolvedConfig,
  store: SessionStore,
  session: SessionTranscript,
): Harness {
  if (session.header.cwd !== process.cwd()) {
    try {
      process.chdir(session.header.cwd);
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `Unable to restore Session cwd ${session.header.cwd}: ${error.message}`
          : `Unable to restore Session cwd ${session.header.cwd}`,
      );
    }
  }

  const activeModel = config.activeModel;
  return createHarness({
    ...(activeModel === undefined
      ? {}
      : { provider: createProviderClient(activeModel.provider) }),
    sessionStore: store,
    session,
    model: activeModel?.model,
    reasoningLevel: activeModel?.reasoningEffort,
    contextWindow:
      activeModel?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    maxOutputTokens:
      activeModel?.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
    approvalPolicy: config.approval,
    tools: [readFileTool],
  });
}

function modelPickerCatalog(config: ResolvedConfig): ModelPickerCatalog {
  return {
    defaultProviderAlias: config.defaultProvider,
    preferredProviderAlias: config.preferredProviderAlias,
    preferredModel: config.defaultModel,
    preferredReasoningEffort: config.defaultReasoningEffort,
    providers: Object.entries(config.providers).map(([alias, provider]) => ({
      alias,
      type: provider.type,
      models: provider.models ?? [],
    })),
  };
}

async function createNewSusanSession(
  config: ResolvedConfig,
  store: SessionStore,
): Promise<Harness> {
  const created = await store.createSession({ cwd: process.cwd() });
  if (!created.ok) {
    throw new Error(created.error.message);
  }
  return createSusanHarness(config, store, created.value);
}
