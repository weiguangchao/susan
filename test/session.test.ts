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
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionStore } from "../src/index.js";
import type { CompletionMessage } from "../src/index.js";

describe("session store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "susan-session-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("creates a versioned JSONL session with safe permissions", async () => {
    const sessionsDirectory = join(root, "sessions");
    const store = createSessionStore({ sessionsDirectory });

    const result = await store.createSession({ cwd: root });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { header, filePath, records } = result.value;
    expect(header.type).toBe("session");
    expect(header.version).toBe(1);
    expect(header.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(header.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(header.cwd).toBe(root);
    expect(basename(filePath)).toMatch(
      /^\d{8}T\d{6}Z-[0-9a-f-]{36}\.jsonl$/,
    );
    expect(records).toEqual([]);
    expect((await stat(sessionsDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await readFile(filePath, "utf8")).toBe(`${JSON.stringify(header)}\n`);
  });

  it("appends messages in stable-boundary order without rewriting earlier lines", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });
    const created = await store.createSession({ cwd: root });
    if (!created.ok) {
      throw new Error("session was not created");
    }
    const { header, filePath } = created.value;
    const messages: CompletionMessage[] = [
      { role: "user", content: "Read the file." },
      {
        role: "assistant",
        content: "I will read it.",
        toolCalls: [
          { id: "call-1", name: "read_file", arguments: { path: "/tmp/a" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: { ok: true, result: { content: "example" } },
      },
      { role: "assistant", content: "Done." },
    ];

    for (const message of messages) {
      const appended = await store.appendMessage(header.id, message);
      expect(appended.ok).toBe(true);
    }

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[0]!)).toEqual(header);
    expect(lines.slice(1).map((line) => JSON.parse(line))).toEqual(
      messages.map((message) => ({ type: "message", message })),
    );
  });

  it("recovers a torn final JSON line and continues appending safely", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });
    const created = await store.createSession({ cwd: root });
    if (!created.ok) {
      throw new Error("session was not created");
    }
    const { header, filePath } = created.value;
    const userMessage: CompletionMessage = {
      role: "user",
      content: "Continue after restart.",
    };
    await store.appendMessage(header.id, userMessage);
    await writeFile(
      filePath,
      '{"type":"message","message":{"role":"assistant","content":"partial',
      { encoding: "utf8", flag: "a" },
    );

    const recovered = await store.loadSession(header.id);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.records).toEqual([
        { type: "message", message: userMessage },
      ]);
    }

    const finalMessage: CompletionMessage = {
      role: "assistant",
      content: "Recovered.",
    };
    const appended = await store.appendMessage(header.id, finalMessage);
    expect(appended.ok).toBe(true);

    const reloaded = await store.loadSession(header.id);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value.records).toEqual([
        { type: "message", message: userMessage },
        { type: "message", message: finalMessage },
      ]);
    }
    expect((await readFile(filePath, "utf8")).endsWith("\n")).toBe(true);
  });

  it("starts a new session for /clear while preserving the old transcript", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });
    const first = await store.createSession({ cwd: root });
    if (!first.ok) {
      throw new Error("first session was not created");
    }
    const firstMessage: CompletionMessage = {
      role: "user",
      content: "Old session.",
    };
    await store.appendMessage(first.value.header.id, firstMessage);

    const second = await store.createSession({ cwd: root });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }

    expect(second.value.header.id).not.toBe(first.value.header.id);
    expect(second.value.filePath).not.toBe(first.value.filePath);
    const oldSession = await store.loadSession(first.value.header.id);
    expect(oldSession.ok).toBe(true);
    if (oldSession.ok) {
      expect(oldSession.value.records).toEqual([
        { type: "message", message: firstMessage },
      ]);
    }
  });

  it("provides picker summaries, ID resume, and last resume", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });
    const first = await store.createSession({ cwd: join(root, "one") });
    if (!first.ok) {
      throw new Error("first session was not created");
    }
    await store.appendMessage(first.value.header.id, {
      role: "user",
      content: "x".repeat(50),
    });
    const second = await store.createSession({ cwd: join(root, "two") });
    if (!second.ok) {
      throw new Error("second session was not created");
    }
    await store.appendMessage(second.value.header.id, {
      role: "user",
      content: "Second session.",
    });

    const list = await store.listSessions();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toHaveLength(2);
      expect(list.value[0]?.header.id).toBe(second.value.header.id);
      expect(list.value[1]?.title).toBe("x".repeat(40));
      expect(list.value[1]?.header.cwd).toBe(join(root, "one"));
    }

    const resumed = await store.loadSession(second.value.header.id);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.value.messages).toEqual([
        { role: "user", content: "Second session." },
      ]);
    }

    const last = await store.loadLastSession();
    expect(last.ok).toBe(true);
    if (last.ok) {
      expect(last.value?.header.id).toBe(second.value.header.id);
    }
  });

  it("returns null for last resume when there are no sessions", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });
    const result = await store.loadLastSession();
    expect(result).toMatchObject({ ok: true, value: null });
  });

  it("fails closed when the sessions directory is overly permissive", async () => {
    const sessionsDirectory = join(root, "sessions");
    await mkdir(sessionsDirectory, { mode: 0o700 });
    await chmod(sessionsDirectory, 0o750);
    const store = createSessionStore({ sessionsDirectory });

    const result = await store.createSession({ cwd: root });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SUSAN_SESSION_PERMISSION" },
    });
  });
});
