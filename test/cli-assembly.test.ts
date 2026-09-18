import { Console } from "node:console";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../src/run";
import { createSessionStore } from "../src/core/session";
import { terminalInput, terminalOutput, stripAnsi } from "./terminal-fixture";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(config = "{}") {
  const root = await mkdtemp(join(tmpdir(), "susan-cli-assembly-"));
  roots.push(root);
  await mkdir(join(root, ".susan"), { mode: 0o700 });
  const configPath = join(root, ".susan", "config.json");
  await writeFile(configPath, config, { mode: 0o600 });
  vi.stubGlobal("console", { ...console, Console });
  const stdin = terminalInput();
  const frames: string[] = [];
  const stdout = terminalOutput((chunk) => frames.push(stripAnsi(chunk)));
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin);
  vi.spyOn(process, "stdout", "get").mockReturnValue(stdout);
  const store = createSessionStore({
    sessionsDirectory: join(root, ".susan", "sessions"),
  });
  return { root, configPath, stdin, frames, store };
}

it("cancels the startup Session Picker without creating another Session", async () => {
  const { root, store, stdin, frames } = await fixture();
  const saved = await store.createSession({ cwd: root });
  expect(saved.ok).toBe(true);
  const running = runCli([
    "--config",
    relative(process.cwd(), root),
    "--resume",
  ]);
  await expect.poll(() => frames.join("\n")).toContain("Session");
  stdin.push("\u001b");
  expect(await running).toBe(0);
  const sessions = await store.listSessions();
  expect(sessions.ok && sessions.value.length).toBe(1);
});

it("reloads a startup Config Error and retries the original Session id", async () => {
  const { root, configPath, store, stdin, frames } = await fixture("invalid");
  const saved = await store.createSession({ cwd: root });
  if (!saved.ok) throw new Error(saved.error.message);
  await store.appendMessage(saved.value.header.id, {
    role: "user",
    content: "original session input",
  });
  const running = runCli(["--config", root, "--resume", saved.value.header.id]);
  await expect.poll(() => frames.join("\n")).toContain("SUSAN_CONFIG_PARSE");
  await writeFile(configPath, "{}");
  stdin.push("r");
  await expect
    .poll(() => frames.join("\n"))
    .toContain("original session input");
  stdin.push("\u0003");
  expect(await running).toBe(0);
});

it("exits nonzero for an unavailable restored cwd without changing process cwd", async () => {
  const { root, store } = await fixture();
  const saved = await store.createSession({ cwd: join(root, "missing") });
  if (!saved.ok) throw new Error(saved.error.message);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const originalCwd = process.cwd();
  expect(
    await runCli(["--config", root, "--resume", saved.value.header.id]),
  ).toBe(1);
  expect(stderr.mock.calls.flat().join("")).toContain("missing");
  expect(process.cwd()).toBe(originalCwd);
});
