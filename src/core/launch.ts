import type { ResumeMode } from "./cli";
import type {
  SessionStore,
  SessionStoreError,
  SessionSummary,
  SessionTranscript,
} from "./session";

export type SessionLaunch =
  | { readonly kind: "new" }
  | { readonly kind: "resume"; readonly session: SessionTranscript }
  | { readonly kind: "picker"; readonly sessions: readonly SessionSummary[] }
  | { readonly kind: "error"; readonly error: SessionStoreError };

export async function resolveSessionLaunch(
  store: SessionStore,
  resume: ResumeMode,
): Promise<SessionLaunch> {
  if (resume.kind === "none") {
    return { kind: "new" };
  }

  if (resume.kind === "id") {
    const loaded = await store.loadSession(resume.id);
    if (!loaded.ok) {
      return { kind: "error", error: loaded.error };
    }
    return { kind: "resume", session: loaded.value };
  }

  if (resume.kind === "last") {
    const last = await store.loadLastSession();
    if (!last.ok) {
      return { kind: "error", error: last.error };
    }
    if (last.value === null) {
      return { kind: "new" };
    }
    return { kind: "resume", session: last.value };
  }

  const list = await store.listSessions();
  if (!list.ok) {
    return { kind: "error", error: list.error };
  }
  if (list.value.length === 0) {
    return { kind: "new" };
  }
  return { kind: "picker", sessions: list.value };
}
