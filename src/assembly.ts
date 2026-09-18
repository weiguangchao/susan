import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  createProviderClient,
  loadConfig,
  resolveConfig,
  resolveSusanHome,
  updateConfigActiveModel,
} from "./config";
import type {
  ActiveModelSelection,
  ConfigError,
  ResolvedConfig,
  ResolvedModelEntry,
  SusanHome,
} from "./core/config";
import { createBuiltInToolSet } from "./core/built-in-tools";
import { createHarness, type Harness } from "./core/harness";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  type ProviderType,
  type ReasoningEffort,
} from "./core/provider";
import {
  createSessionStore,
  type SessionHeader,
  type SessionStore,
  type SessionSummary,
  type SessionTranscript,
} from "./core/session";

export type AssemblyOptions = { susanHomeParent?: string };
export type SessionSelection =
  | { kind: "new" }
  | { kind: "last" }
  | { kind: "id"; id: string }
  | { kind: "picker" };
export type AssembleOptions = {
  session: SessionSelection;
  newSessionCwd: string;
};
export type AssemblyConfigView = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  providers: readonly {
    alias: string;
    type: ProviderType;
    host: string;
    models: readonly ResolvedModelEntry[];
  }[];
};
export type AssemblyError = {
  stage:
    | "options"
    | "home"
    | "session"
    | "cwd"
    | "history"
    | "harness"
    | "operation";
  code: string;
  message: string;
  path?: string;
};
type AssemblyFailure =
  | { kind: "config-error"; error: ConfigError }
  | { kind: "startup-error"; error: AssemblyError };
export type AssemblyResult =
  | {
      kind: "ready";
      harness: Harness;
      session: SessionHeader;
      inputHistory: readonly string[];
      config: AssemblyConfigView;
    }
  | { kind: "session-picker"; sessions: readonly SessionSummary[] }
  | AssemblyFailure;
export type ConfigUpdateResult =
  | { kind: "updated"; config: AssemblyConfigView }
  | AssemblyFailure;
export interface HarnessAssembly {
  assemble(options: AssembleOptions): Promise<AssemblyResult>;
  reload(): Promise<ConfigUpdateResult>;
  applyModelSelection(
    selection: ActiveModelSelection,
  ): Promise<ConfigUpdateResult>;
}

function failure(
  stage: AssemblyError["stage"],
  code: string,
  message: string,
  path?: string,
): AssemblyFailure {
  return {
    kind: "startup-error",
    error: { stage, code, message, ...(path === undefined ? {} : { path }) },
  };
}
function configView(config: ResolvedConfig): AssemblyConfigView {
  return {
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
    defaultReasoningEffort: config.defaultReasoningEffort,
    providers: Object.entries(config.providers).map(([alias, provider]) => ({
      alias,
      type: provider.type,
      host: provider.baseURL.host,
      models: structuredClone(provider.models ?? []),
    })),
  };
}
function modelOptions(config: ResolvedConfig) {
  const active = config.activeModel;
  return {
    provider:
      active === undefined ? undefined : createProviderClient(active.provider),
    model: active?.model,
    modelInput: active?.modelInput,
    reasoningEffort: active?.reasoningEffort,
    contextWindow: active?.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    maxOutputTokens: active?.maxOutputTokens ?? DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
  };
}

async function validateCwd(cwd: string): Promise<AssemblyFailure | undefined> {
  try {
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
      throw new Error("Session cwd must be an accessible absolute directory");
    await access(cwd, constants.R_OK | constants.X_OK);
  } catch (error) {
    return failure(
      "cwd",
      "SUSAN_ASSEMBLY_CWD_UNAVAILABLE",
      error instanceof Error ? error.message : "Session cwd is unavailable",
      cwd,
    );
  }
}

export function createHarnessAssembly(
  options: AssemblyOptions = {},
): HarnessAssembly {
  const parent = options.susanHomeParent;
  let home: SusanHome | undefined;
  let store: SessionStore | undefined;
  let config: ResolvedConfig | undefined;
  let current: { harness: Harness; session: SessionHeader } | undefined;
  let operating = false;

  async function operate<T extends AssemblyResult | ConfigUpdateResult>(
    action: () => Promise<T>,
  ): Promise<T | AssemblyFailure> {
    if (operating || current?.harness.getSnapshot().status === "running") {
      return failure(
        "operation",
        "SUSAN_ASSEMBLY_BUSY",
        "Harness Assembly is busy",
      );
    }
    operating = true;
    try {
      return await action();
    } catch (error) {
      return failure(
        "harness",
        "SUSAN_ASSEMBLY_INTERNAL",
        error instanceof Error ? error.message : "Unable to assemble Harness",
      );
    } finally {
      operating = false;
    }
  }

  async function initialize(): Promise<AssemblyFailure | undefined> {
    if (
      parent !== undefined &&
      (typeof parent !== "string" || !isAbsolute(parent))
    )
      return failure(
        "options",
        "SUSAN_ASSEMBLY_INVALID_OPTIONS",
        "Susan Home parent must be absolute",
        parent,
      );
    if (home === undefined) {
      const resolved = await resolveSusanHome(parent);
      if (!resolved.ok)
        return {
          kind: "startup-error",
          error: { stage: "home", ...resolved.error },
        };
      home = resolved.value;
      store = createSessionStore({ sessionsDirectory: home.sessionsDirectory });
    }
    if (config === undefined) {
      const loaded = await loadConfig({ configPath: home.configPath });
      if (!loaded.ok) return { kind: "config-error", error: loaded.error };
      config = loaded.config;
    }
  }

  async function installConfig(
    next: ResolvedConfig,
  ): Promise<ConfigUpdateResult> {
    if (current !== undefined) {
      const configured = await current.harness.dispatch({
        type: "configure-model",
        ...modelOptions(next),
      });
      if (!configured.ok)
        return failure(
          "operation",
          configured.error.code,
          configured.error.message,
        );
    }
    config = next;
    return { kind: "updated", config: configView(next) };
  }

  return {
    assemble(request) {
      return operate(async (): Promise<AssemblyResult> => {
        if (
          typeof request?.newSessionCwd !== "string" ||
          !isAbsolute(request.newSessionCwd)
        )
          return failure(
            "options",
            "SUSAN_ASSEMBLY_INVALID_OPTIONS",
            "newSessionCwd must be absolute",
            request?.newSessionCwd,
          );
        if (
          !request.session ||
          !["new", "last", "id", "picker"].includes(request.session.kind)
        )
          return failure(
            "options",
            "SUSAN_ASSEMBLY_INVALID_OPTIONS",
            "A valid Session selection is required",
          );
        const error = await initialize();
        if (error !== undefined) return error;
        let session: SessionTranscript | undefined;
        const selection = request.session;
        if (selection.kind === "picker") {
          const list = await store!.listSessions();
          if (!list.ok)
            return {
              kind: "startup-error",
              error: { stage: "session", ...list.error },
            };
          if (list.value.length > 0)
            return { kind: "session-picker", sessions: list.value };
        } else if (selection.kind === "id" || selection.kind === "last") {
          const loaded =
            selection.kind === "id"
              ? await store!.loadSession(selection.id)
              : await store!.loadLastSession();
          if (!loaded.ok)
            return {
              kind: "startup-error",
              error: { stage: "session", ...loaded.error },
            };
          session = loaded.value ?? undefined;
        }
        const cwd = session?.header.cwd ?? request.newSessionCwd;
        const cwdError = await validateCwd(cwd);
        if (cwdError !== undefined) return cwdError;
        const history = await store!.loadInputHistory();
        if (!history.ok)
          return {
            kind: "startup-error",
            error: { stage: "history", ...history.error },
          };
        if (current?.harness.getSnapshot().status === "running")
          return failure(
            "operation",
            "SUSAN_ASSEMBLY_BUSY",
            "Harness Assembly is busy",
          );
        if (
          session === undefined &&
          current !== undefined &&
          current.session.cwd === cwd &&
          current.harness.getSnapshot().messages.length === 0
        ) {
          return {
            kind: "ready",
            harness: current.harness,
            session: { ...current.session },
            inputHistory: history.value,
            config: configView(config!),
          };
        }
        if (session === undefined) {
          const created = await store!.createSession({ cwd, reuseEmpty: true });
          if (!created.ok)
            return {
              kind: "startup-error",
              error: { stage: "session", ...created.error },
            };
          session = created.value;
        }
        if (current?.harness.getSnapshot().status === "running")
          return failure(
            "operation",
            "SUSAN_ASSEMBLY_BUSY",
            "Harness Assembly is busy",
          );
        const harness = createHarness({
          sessionStore: store!,
          session,
          ...modelOptions(config!),
          tools: createBuiltInToolSet({ sessionCwd: cwd }),
        });
        current = { harness, session: session.header };
        return {
          kind: "ready",
          harness: current.harness,
          session: { ...current.session },
          inputHistory: history.value,
          config: configView(config!),
        };
      });
    },
    reload() {
      return operate(async (): Promise<ConfigUpdateResult> => {
        // initialize also supports retrying a startup Config Error on this object.
        if (home === undefined) {
          const error = await initialize();
          if (error !== undefined) return error;
        }
        const loaded = await loadConfig({ configPath: home!.configPath });
        if (!loaded.ok) return { kind: "config-error", error: loaded.error };
        return installConfig(loaded.config);
      });
    },
    applyModelSelection(selection) {
      return operate(async (): Promise<ConfigUpdateResult> => {
        if (config === undefined || home === undefined)
          return failure(
            "operation",
            "SUSAN_ASSEMBLY_NOT_READY",
            "Config has not been loaded",
          );
        const selected = resolveConfig(
          {
            defaultProvider: selection.providerAlias,
            defaultModel: selection.model,
            defaultReasoningEffort: selection.reasoningEffort,
            providers: Object.fromEntries(
              Object.entries(config.providers).map(([alias, provider]) => [
                alias,
                {
                  ...provider,
                  baseURL: provider.baseURL.href,
                  models: provider.models?.map((model) => ({
                    ...model,
                    input:
                      model.input === undefined ? undefined : [...model.input],
                  })),
                },
              ]),
            ),
          },
          home.configPath,
        );
        if (!selected.ok)
          return { kind: "config-error", error: selected.error };
        const saved = await updateConfigActiveModel(home.configPath, selection);
        if (!saved.ok) return { kind: "config-error", error: saved.error };
        return installConfig(selected.config);
      });
    },
  };
}
