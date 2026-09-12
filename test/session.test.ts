import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionStore } from "../src/index";
import type {
  CompletionMessage,
  CompactionEntry,
  ProviderUsage,
} from "../src/index";

const SESSION_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "session",
);

describe("session store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "susan-session-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  async function installSessionFixture(name: string) {
    const sessionsDirectory = join(root, "sessions");
    await mkdir(sessionsDirectory, { mode: 0o700 });
    const raw = await readFile(join(SESSION_FIXTURES_DIR, name), "utf8");
    const header = JSON.parse(raw.split("\n")[0]!) as { id: string };
    const filePath = join(
      sessionsDirectory,
      `20260101T000000Z-${header.id}.jsonl`,
    );
    await writeFile(filePath, raw, { mode: 0o600 });
    return {
      store: createSessionStore({ sessionsDirectory }),
      filePath,
      raw,
      sessionId: header.id,
    };
  }

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
    expect(header.version).toBe(5);
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
        content: [{ type: "text", text: "example" }],
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

  it("restores Pi-form Tool Results and rejects the retired envelope", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });
    const created = await store.createSession({ cwd: root });
    if (!created.ok) {
      throw new Error("session was not created");
    }
    const message = {
      role: "tool" as const,
      toolCallId: "call-1",
      content: [{ type: "text" as const, text: "甲" }],
      details: {
        truncation: {
          truncatedBy: "lines",
          nextOffset: 2,
        },
      },
    };
    await store.appendMessage(created.value.header.id, message);
    const loaded = await store.loadSession(created.value.header.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.messages[0]).toEqual(message);
    }

    await writeFile(
      created.value.filePath,
      `${JSON.stringify(created.value.header)}\n${JSON.stringify({
        type: "message",
        message: {
          role: "tool",
          toolCallId: "call-1",
          content: {
            ok: false,
            error: { code: "ENOENT", message: "Missing", path: "/secret" },
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    expect(await store.loadSession(created.value.header.id)).toMatchObject({
      ok: false,
      error: { code: "SUSAN_SESSION_SCHEMA" },
    });
  });

  it("appends and restores a Compaction Checkpoint without rewriting the Session Transcript", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });
    const created = await store.createSession({ cwd: root });
    if (!created.ok) {
      throw new Error("session was not created");
    }
    const message: CompletionMessage = { role: "user", content: "Keep me." };
    const checkpoint: CompactionEntry = {
      type: "compaction",
      summary: "Goal\n- Continue the task",
      firstKeptEntryId: "message:0",
      retainedTail: [message],
      details: { readFiles: [], modifiedFiles: [] },
      tokensBefore: 42_000,
      timestamp: "2026-09-03T01:00:00.000Z",
    };

    await store.appendMessage(created.value.header.id, message);
    const appended = await store.appendCompaction(
      created.value.header.id,
      checkpoint,
    );

    expect(appended).toEqual({ ok: true, value: undefined });
    const loaded = await store.loadSession(created.value.header.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.records).toEqual([
        { type: "message", message },
        checkpoint,
      ]);
      expect(loaded.value.messages).toEqual([message]);
    }
  });

  it("appends and restores Provider usage for Session totals", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });
    const created = await store.createSession({ cwd: root });
    if (!created.ok) {
      throw new Error("session was not created");
    }
    const usages: ProviderUsage[] = [
      { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      { inputTokens: 180, outputTokens: 30, totalTokens: 210 },
      {
        inputTokens: 260,
        outputTokens: 40,
        totalTokens: 300,
        cachedInputTokens: 150,
      },
    ];

    for (const [index, usage] of usages.entries()) {
      expect(await store.appendUsage(created.value.header.id, usage)).toEqual({
        ok: true,
        value: undefined,
      });
      if (index === 1) {
        expect(
          await store.appendUsage(
            created.value.header.id,
            usage,
            { model: "deepseek-v4-flash", reasoningEffort: "max" },
          ),
        ).toEqual({ ok: true, value: undefined });
      }
    }

    const loaded = await store.loadSession(created.value.header.id);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.records).toEqual([
        { type: "usage", usage: usages[0] },
        { type: "usage", usage: usages[1] },
        {
          type: "usage",
          usage: usages[1],
          model: "deepseek-v4-flash",
          reasoningEffort: "max",
        },
        { type: "usage", usage: usages[2] },
      ]);
      expect(loaded.value.messages).toEqual([]);
    }
  });

  it("persists Cached Input Tokens on the current Session Format Version", async () => {
    const { store, filePath, sessionId } = await installSessionFixture(
      "pending-read.jsonl",
    );
    const usage: ProviderUsage = {
      inputTokens: 120,
      outputTokens: 5,
      totalTokens: 125,
      cachedInputTokens: 60,
    };

    expect(await store.appendUsage(sessionId, usage)).toEqual({
      ok: true,
      value: undefined,
    });

    const text = await readFile(filePath, "utf8");
    const lastLine = text.trimEnd().split("\n").at(-1)!;
    expect(JSON.parse(lastLine)).toEqual({
      type: "usage",
      usage: {
        inputTokens: 120,
        outputTokens: 5,
        totalTokens: 125,
        cachedInputTokens: 60,
      },
    });
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

  it("reuses only the latest empty Session in the same working directory", async () => {
    const store = createSessionStore({
      sessionsDirectory: join(root, "sessions"),
    });
    const first = await store.createSession({ cwd: root, reuseEmpty: true });
    const reused = await store.createSession({ cwd: root, reuseEmpty: true });
    if (!first.ok || !reused.ok) {
      throw new Error("sessions were not created");
    }

    expect(reused.value.header.id).toBe(first.value.header.id);
    const afterReuse = await store.listSessions();
    expect(afterReuse.ok && afterReuse.value).toHaveLength(1);

    await store.appendMessage(first.value.header.id, {
      role: "user",
      content: "This Session is no longer empty.",
    });
    const next = await store.createSession({ cwd: root, reuseEmpty: true });
    if (!next.ok) {
      throw new Error("next session was not created");
    }
    expect(next.value.header.id).not.toBe(first.value.header.id);

    const otherDirectory = await store.createSession({
      cwd: join(root, "other"),
      reuseEmpty: true,
    });
    if (!otherDirectory.ok) {
      throw new Error("other-directory session was not created");
    }
    expect(otherDirectory.value.header.id).not.toBe(next.value.header.id);
  });

  it("loads global input history from all persisted sessions", async () => {
    const sessionsDirectory = join(root, "sessions");
    const store = createSessionStore({ sessionsDirectory });
    const first = await store.createSession({ cwd: root });
    const second = await store.createSession({ cwd: root });
    if (!first.ok || !second.ok) {
      throw new Error("sessions were not created");
    }

    await store.appendMessage(first.value.header.id, {
      role: "user",
      content: "First historical input",
    });
    await store.appendMessage(first.value.header.id, {
      role: "assistant",
      content: "First response",
    });
    await store.appendMessage(second.value.header.id, {
      role: "user",
      content: "Second historical input",
    });
    await utimes(
      first.value.filePath,
      new Date("2026-09-03T01:00:00.000Z"),
      new Date("2026-09-03T01:00:00.000Z"),
    );
    await utimes(
      second.value.filePath,
      new Date("2026-09-03T02:00:00.000Z"),
      new Date("2026-09-03T02:00:00.000Z"),
    );

    const restarted = createSessionStore({ sessionsDirectory });
    const history = await restarted.loadInputHistory();

    expect(history).toMatchObject({
      ok: true,
      value: ["First historical input", "Second historical input"],
    });
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

  it("does not load or rewrite a retired Session Format Version fixture", async () => {
    const { store, filePath, raw, sessionId } = await installSessionFixture(
      "completed-legacy-read-file.jsonl",
    );

    expect(await store.loadSession(sessionId)).toMatchObject({
      ok: false,
      error: {
        code: "SUSAN_SESSION_SCHEMA",
        message: "Unsupported Session Format Version",
      },
    });
    expect(await readFile(filePath, "utf8")).toBe(raw);
  });

  it.each([
    "pending-legacy-read-file.jsonl",
    "awaiting-approval-exit.jsonl",
  ] as const)(
    "skips the retired %s fixture when listing sessions",
    async (name) => {
      const { store, filePath, raw, sessionId } =
        await installSessionFixture(name);

      expect(await store.loadSession(sessionId)).toMatchObject({
        ok: false,
        error: { code: "SUSAN_SESSION_SCHEMA" },
      });
      const listed = await store.listSessions();
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value).toEqual([]);
      }
      expect(await readFile(filePath, "utf8")).toBe(raw);
    },
  );

  it("loads the current pending-read fixture without rewriting historical JSONL", async () => {
    const { store, filePath, raw, sessionId } = await installSessionFixture(
      "pending-read.jsonl",
    );

    const loaded = await store.loadSession(sessionId);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.header.version).toBe(5);
    expect(await readFile(filePath, "utf8")).toBe(raw);
  });

  it("rejects an unknown future Session Format Version fixture", async () => {
    const { store, sessionId } = await installSessionFixture(
      "future-session-format.jsonl",
    );

    expect(await store.loadSession(sessionId)).toMatchObject({
      ok: false,
      error: {
        code: "SUSAN_SESSION_SCHEMA",
        message: "Unsupported Session Format Version",
      },
    });
  });
});
