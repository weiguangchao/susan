import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLI_USAGE,
  createSessionPickerState,
  createSessionStore,
  formatCliError,
  formatConfigError,
  parseCli,
  reduceSessionPickerState,
  resolveSessionLaunch,
  resolveSessionPickerIntent,
} from "../src/index.js";
import {
  CLEAR_TERMINAL_SEQUENCE,
  clearTerminal,
  runCli,
} from "../src/run.js";

describe("CLI terminal startup", () => {
  it("clears the screen and scrollback exactly once before Ink takes over", () => {
    const writes: string[] = [];

    clearTerminal({
      write(value) {
        writes.push(value);
        return true;
      },
    });

    expect(writes).toEqual([CLEAR_TERMINAL_SEQUENCE]);
    expect(CLEAR_TERMINAL_SEQUENCE).toBe("\u001B[2J\u001B[3J\u001B[H");
  });
});

describe("CLI flags", () => {
  it("starts a new Session with no resume flags", () => {
    expect(parseCli([])).toEqual({
      ok: true,
      flags: {
        resume: { kind: "none" },
      },
    });
  });

  it("rejects the removed approval flags as unknown arguments", () => {
    for (const args of [
      ["--yolo"],
      ["--approval", "ask"],
      ["--approval=yolo"],
    ]) {
      expect(parseCli(args)).toEqual({
        ok: false,
        error: {
          code: "SUSAN_CLI_USAGE",
          message: `Unknown argument: ${args[0]}`,
        },
      });
    }
  });

  it("accepts a Susan Home parent directory", () => {
    expect(parseCli(["--config", "/tmp/project"])).toEqual({
      ok: true,
      flags: {
        susanHomeParent: "/tmp/project",
        resume: { kind: "none" },
      },
    });
    expect(parseCli(["--config=/tmp/project"])).toEqual({
      ok: true,
      flags: {
        susanHomeParent: "/tmp/project",
        resume: { kind: "none" },
      },
    });
  });

  it("opens the resume picker, a Session id, or the last Session", () => {
    expect(parseCli(["--resume"])).toEqual({
      ok: true,
      flags: {
        resume: { kind: "picker" },
      },
    });
    expect(
      parseCli(["--resume", "11111111-1111-1111-1111-111111111111"]),
    ).toEqual({
      ok: true,
      flags: {
        resume: {
          kind: "id",
          id: "11111111-1111-1111-1111-111111111111",
        },
      },
    });
    expect(parseCli(["--resume", "--last"])).toEqual({
      ok: true,
      flags: {
        resume: { kind: "last" },
      },
    });
    expect(
      parseCli(["--config=/tmp/project", "--resume", "--last"]),
    ).toEqual({
      ok: true,
      flags: {
        susanHomeParent: "/tmp/project",
        resume: { kind: "last" },
      },
    });
  });

  it("rejects conflicting or unknown CLI flags", () => {
    expect(parseCli(["--last"])).toEqual({
      ok: false,
      error: {
        code: "SUSAN_CLI_USAGE",
        message: "--last requires --resume",
      },
    });
    expect(
      parseCli([
        "--resume",
        "11111111-1111-1111-1111-111111111111",
        "--last",
      ]),
    ).toEqual({
      ok: false,
      error: {
        code: "SUSAN_CLI_USAGE",
        message: "--resume <id> and --last cannot be used together",
      },
    });
    expect(parseCli(["--unknown"])).toEqual({
      ok: false,
      error: {
        code: "SUSAN_CLI_USAGE",
        message: "Unknown argument: --unknown",
      },
    });
    expect(parseCli(["--config"])).toEqual({
      ok: false,
      error: {
        code: "SUSAN_CLI_USAGE",
        message: "--config requires a Susan Home parent directory",
      },
    });
    expect(parseCli(["--resume="])).toEqual({
      ok: false,
      error: {
        code: "SUSAN_CLI_USAGE",
        message: "--resume requires a Session id",
      },
    });
  });

  it("prints usage text for CLI errors", () => {
    const parsed = parseCli(["--unknown"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    const text = formatCliError(parsed.error);
    expect(text).toContain("susan: Unknown argument: --unknown");
    expect(text).toContain(CLI_USAGE);
  });

  it("returns nonzero and prints usage for every removed approval flag form", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    let captured = "";

    try {
      for (const args of [
        ["--yolo"],
        ["--approval", "ask"],
        ["--approval=yolo"],
      ]) {
        expect(await runCli(args)).toBe(1);
      }
    } finally {
      captured = stderr.mock.calls
        .map((call) => String(call[0]))
        .join("");
      stderr.mockRestore();
    }

    expect(captured).toContain("Unknown argument");
    expect(captured).toContain(CLI_USAGE);
  });

  it("rejects a --config path that is not an existing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "susan-cli-config-"));
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    let captured = "";
    try {
      const missing = join(root, "missing");
      expect(await runCli(["--config", missing])).toBe(1);
      const filePath = join(root, "file");
      await writeFile(filePath, "{}");
      expect(await runCli(["--config", filePath])).toBe(1);
    } finally {
      captured = stderr.mock.calls
        .map((call) => String(call[0]))
        .join("");
      stderr.mockRestore();
      await rm(root, { force: true, recursive: true });
    }

    expect(captured).toContain("Susan Home parent does not exist");
    expect(captured).toContain("Susan Home parent is not a directory");
    expect(captured).not.toContain("SUSAN_CONFIG_MISSING");
  });

  it("loads Config from <dir>/.susan and keeps Session Store there", async () => {
    const root = await mkdtemp(join(tmpdir(), "susan-cli-home-"));
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    let captured = "";
    try {
      expect(await runCli(["--config", root])).toBe(1);
    } finally {
      captured = stderr.mock.calls
        .map((call) => String(call[0]))
        .join("");
      stderr.mockRestore();
    }

    try {
      expect(captured).toContain("SUSAN_CONFIG_MISSING");
      expect(captured).toContain(join(root, ".susan", "config.json"));
      expect((await stat(join(root, ".susan"))).isDirectory()).toBe(true);
      expect((await stat(join(root, ".susan", "sessions"))).isDirectory()).toBe(
        true,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

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

    const none = await resolveSessionLaunch(store, { kind: "none" });
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

    expect(await resolveSessionLaunch(store, { kind: "none" })).toEqual({
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

describe("config error presentation", () => {
  it("shows a missing Config path and the minimal example", () => {
    const view = formatConfigError({
      code: "SUSAN_CONFIG_MISSING",
      configPath: "/tmp/.susan/config.json",
      issues: [
        {
          path: "/tmp/.susan/config.json",
          code: "file_missing",
          message: "Config file does not exist",
        },
      ],
    });

    expect(view.code).toBe("SUSAN_CONFIG_MISSING");
    expect(view.configPath).toBe("/tmp/.susan/config.json");
    expect(view.issues[0]?.message).toBe("Config file does not exist");
    expect(view.example).toContain('"defaultProvider": "deepseek"');
    expect(view.example).toContain('"defaultModel": "deepseek-v4-flash"');
    expect(view.example).not.toContain('"approval"');
    expect(view.example).toContain('"type": "openai-completion"');
    expect(view.example).toContain('"apiKey": "sk-..."');
    expect(view.example).toContain('"baseURL": "https://api.deepseek.com"');
    expect(view.hint).toBe("r 重新读取 · Esc 退出");
  });

  it("never displays a complete API key", () => {
    const view = formatConfigError({
      code: "SUSAN_CONFIG_SCHEMA",
      configPath: "/tmp/.susan/config.json",
      issues: [
        {
          path: "providers.deepseek.apiKey",
          code: "invalid_type",
          message: "Invalid API key sk-live-secret-value-12345",
        },
      ],
    });

    expect(JSON.stringify(view)).not.toContain("sk-live-secret-value-12345");
    expect(view.issues[0]?.message).toContain("sk-...");
    expect(view.example).toBeNull();
  });
});

describe("session picker", () => {
  const sessions = [
    {
      header: {
        type: "session" as const,
        version: 4 as const,
        id: "11111111-1111-1111-1111-111111111111",
        createdAt: "2026-09-03T00:00:00.000Z",
        cwd: "/tmp/one",
      },
      title: "First session.",
      recordCount: 1,
      updatedAt: "2026-09-03T00:01:00.000Z",
      filePath: "/tmp/one.jsonl",
    },
    {
      header: {
        type: "session" as const,
        version: 4 as const,
        id: "22222222-2222-2222-2222-222222222222",
        createdAt: "2026-09-03T00:02:00.000Z",
        cwd: "/tmp/two",
      },
      title: "Second session.",
      recordCount: 1,
      updatedAt: "2026-09-03T00:03:00.000Z",
      filePath: "/tmp/two.jsonl",
    },
  ];

  it("moves the selection and keeps it in range", () => {
    let state = createSessionPickerState(sessions);
    expect(state.selectedIndex).toBe(0);

    state = reduceSessionPickerState(
      state,
      resolveSessionPickerIntent({ input: "", downArrow: true }),
    );
    expect(state.selectedIndex).toBe(1);

    state = reduceSessionPickerState(
      state,
      resolveSessionPickerIntent({ input: "", downArrow: true }),
    );
    expect(state.selectedIndex).toBe(1);

    state = reduceSessionPickerState(
      state,
      resolveSessionPickerIntent({ input: "k" }),
    );
    expect(state.selectedIndex).toBe(0);
  });

  it("selects, creates a new Session, or exits from the picker", () => {
    expect(resolveSessionPickerIntent({ input: "", return: true })).toEqual({
      type: "select",
    });
    expect(resolveSessionPickerIntent({ input: "n" })).toEqual({
      type: "new",
    });
    expect(resolveSessionPickerIntent({ input: "", escape: true })).toEqual({
      type: "exit",
    });
  });
});

describe("package metadata", () => {
  it("publishes as @weiguangchao/susan with the susan bin", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      name: string;
      bin: Record<string, string>;
      engines: { node: string };
      files: string[];
      type: string;
      scripts: Record<string, string>;
    };

    expect(pkg.name).toBe("@weiguangchao/susan");
    expect(pkg.bin.susan).toBe("./dist/cli.js");
    expect(pkg.engines.node).toBe(">=22 <26");
    expect(pkg.files).toContain("dist");
    expect(pkg.type).toBe("module");
    expect(pkg.scripts).toMatchObject({
      dev: "tsx src/cli.ts --config .",
    });
  });
});
