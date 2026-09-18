import { terminalInput, terminalOutput, stripAnsi, latestVisibleFrame, flushEffects } from "./terminal-fixture";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink";
import { expect, it } from "vitest";
import { createHarnessAssembly } from "../src/assembly";
import { createSessionStore } from "../src/core/session";
import { modelPickerCatalog, TuiApp } from "../src/ui/tui";

it("keeps the old Session on reload/new failures, then switches only after ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "susan-tui-assembly-"));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  await mkdir(join(root, ".susan"), { mode: 0o700 });
  const configPath = join(root, ".susan", "config.json");
  await writeFile(configPath, "{}", { mode: 0o600 });
  const store = createSessionStore({
    sessionsDirectory: join(root, ".susan", "sessions"),
  });
  const saved = await store.createSession({ cwd });
  if (!saved.ok) throw new Error(saved.error.message);
  await store.appendMessage(saved.value.header.id, {
    role: "user",
    content: "remember this input",
  });
  const assembly = createHarnessAssembly({ susanHomeParent: root });
  const started = await assembly.assemble({
    session: { kind: "last" },
    newSessionCwd: root,
  });
  if (started.kind !== "ready") throw new Error(JSON.stringify(started));
  const stdin = terminalInput();
  const frames: string[] = [];
  const stdout = terminalOutput((chunk) => frames.push(stripAnsi(chunk)));
  const instance = render(
    <TuiApp
      harness={started.harness}
      assembly={assembly}
      inputHistory={started.inputHistory}
      modelCatalog={modelPickerCatalog(started.config)}
    />,
    { stdin, stdout, interactive: true, patchConsole: false },
  );
  async function key(value: string) {
    stdin.push(value);
    await flushEffects();
    await instance.waitUntilRenderFlush();
  }
  async function command(value: string) {
    await key(value);
    await key("\r");
  }
  async function visible(text: string) {
    await expect.poll(() => latestVisibleFrame(frames)).toContain(text);
  }
  try {
    await instance.waitUntilRenderFlush();
    await writeFile(configPath, "invalid");
    await command("/reload");
    await visible("Config");
    expect(started.harness.getSnapshot()).toMatchObject({
      status: "pending",
      messages: [{ content: "remember this input" }],
    });
    await rm(cwd, { recursive: true });
    await command("/new");
    await visible("ENOENT");
    expect(started.harness.getSnapshot().sessionId).toBe(saved.value.header.id);
    await mkdir(cwd);
    await writeFile(
      configPath,
      JSON.stringify({
        providers: {
          fresh: {
            type: "openai-completion",
            apiKey: "test",
            models: [{ id: "fresh-model" }],
          },
        },
      }),
    );
    await command("/reload");
    await visible("配置已重新加载");
    expect(started.harness.getSnapshot().status).toBe("pending");
    await command("/model");
    await visible("fresh-model");
    // Ink delays a lone ESC to distinguish terminal escape sequences.
    await key("\u001b");
    await expect
      .poll(() => latestVisibleFrame(frames))
      .not.toContain("Provider");
    await command("/new");
    await visible("模型配置未完整");
    expect(latestVisibleFrame(frames)).not.toContain("Pending");
    await key("\u001b[A");
    await visible("remember this input");
    const latest = await store.loadLastSession();
    if (!latest.ok || latest.value === null)
      throw new Error("Missing new Session");
    expect(latest.value.header.id).not.toBe(saved.value.header.id);
    expect(latest.value.header.cwd).toBe(cwd);
    expect(latest.value.messages).toEqual([]);
    await key("\r");
    await visible("fresh-model");
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
    await rm(root, { recursive: true, force: true });
  }
});
