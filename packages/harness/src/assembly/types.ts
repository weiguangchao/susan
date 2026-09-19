import type {
  ActiveModelSelection,
  ConfigError,
  ResolvedModelEntry,
} from "../core/config";
import type { Harness } from "../core/harness";
import type { ProviderType, ReasoningEffort } from "../core/provider";
import type { SessionHeader, SessionSummary } from "../core/session";

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
export type AssemblyFailure =
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
  { kind: "updated"; config: AssemblyConfigView } | AssemblyFailure;
export interface HarnessAssembly {
  assemble(options: AssembleOptions): Promise<AssemblyResult>;
  reload(): Promise<ConfigUpdateResult>;
  applyModelSelection(
    selection: ActiveModelSelection,
  ): Promise<ConfigUpdateResult>;
}
