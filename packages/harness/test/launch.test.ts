import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionStore } from "../src/index";
import { resolveSessionLaunch } from "../src/core/launch";
describe("session launch", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "susan-cli-"));
    await mkdir(join(root, "sessions"), { recursive: true });
    await chmod(join(root, "sessions"), 0o700);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("creates a new Session when none can be resumed", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });

    const none = await resolveSessionLaunch(store, { kind: "new" });
    expect(none).toEqual({ kind: "new" });

    const picker = await resolveSessionLaunch(store, { kind: "picker" });
    expect(picker).toEqual({ kind: "new" });

    const last = await resolveSessionLaunch(store, { kind: "last" });
    expect(last).toEqual({ kind: "new" });
  });

  it("starts a new Session by default even when an older Session exists", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });
    const existing = await store.createSession({ cwd: root });
    if (!existing.ok) {
      throw new Error("session was not created");
    }
    await store.appendMessage(existing.value.header.id, {
      role: "user",
      content: "Previous process input.",
    });

    expect(await resolveSessionLaunch(store, { kind: "new" })).toEqual({
      kind: "new",
    });
  });

  it("resumes by picker, Session id, or last Session", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });
    const first = await store.createSession({ cwd: join(root, "one") });
    const second = await store.createSession({ cwd: join(root, "two") });
    if (!first.ok || !second.ok) {
      throw new Error("sessions were not created");
    }
    await store.appendMessage(first.value.header.id, {
      role: "user",
      content: "First session.",
    });
    await store.appendMessage(second.value.header.id, {
      role: "user",
      content: "Second session.",
    });

    const picker = await resolveSessionLaunch(store, { kind: "picker" });
    expect(picker.kind).toBe("picker");
    if (picker.kind === "picker") {
      expect(picker.sessions.map((session) => session.header.id)).toEqual([
        second.value.header.id,
        first.value.header.id,
      ]);
    }

    const byId = await resolveSessionLaunch(store, {
      kind: "id",
      id: first.value.header.id,
    });
    expect(byId.kind).toBe("resume");
    if (byId.kind === "resume") {
      expect(byId.session.header.id).toBe(first.value.header.id);
      expect(byId.session.header.cwd).toBe(join(root, "one"));
    }

    const last = await resolveSessionLaunch(store, { kind: "last" });
    expect(last.kind).toBe("resume");
    if (last.kind === "resume") {
      expect(last.session.header.id).toBe(second.value.header.id);
    }
  });

  it("reports a missing Session id instead of creating a new Session", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });
    const missing = await resolveSessionLaunch(store, {
      kind: "id",
      id: "11111111-1111-1111-1111-111111111111",
    });

    expect(missing).toMatchObject({
      kind: "error",
      error: { code: "SUSAN_SESSION_NOT_FOUND" },
    });
  });
});
