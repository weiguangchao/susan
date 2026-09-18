import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHarnessAssembly } from "../src/assembly";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "susan-assembly-"));
  roots.push(root);
  const configPath = join(root, ".susan", "config.json");
  const assembly = createHarnessAssembly({ susanHomeParent: root });
  await expect(stat(join(root, ".susan"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await mkdir(join(root, ".susan"), { mode: 0o700 });
  await writeFile(configPath, "{}", { mode: 0o600 });
  return { root, configPath, assembly };
}

it("assembles without a model or process cwd changes and reuses the current empty Session", async () => {
  const { root, assembly } = await fixture();
  const cwd = process.cwd();
  const options = { session: { kind: "new" as const }, newSessionCwd: root };
  const first = await assembly.assemble(options);
  expect(first.kind).toBe("ready");
  if (first.kind !== "ready") throw new Error(JSON.stringify(first));
  expect(first.harness.getSnapshot()).toMatchObject({
    cwd: root,
    status: "idle",
    messages: [],
  });
  expect(process.cwd()).toBe(cwd);
  expect(await assembly.assemble(options)).toMatchObject({
    kind: "ready",
    harness: first.harness,
    session: first.session,
  });
});

function modelConfig(model = "first", host = "https://example.test/v1") {
  return {
    defaultProvider: "local",
    defaultModel: model,
    defaultReasoningEffort: "minimal",
    providers: {
      local: {
        type: "openai-completion",
        apiKey: "test-secret",
        baseURL: host,
        models: [{ id: "first" }, { id: "second" }],
      },
    },
  };
}
it("locks Config through picker and new, and reloads the same Harness only on success", async () => {
  const { root, configPath, assembly } = await fixture();
  await writeFile(configPath, JSON.stringify(modelConfig()));
  const first = await assembly.assemble({
    session: { kind: "new" },
    newSessionCwd: root,
  });
  if (first.kind !== "ready") throw new Error(JSON.stringify(first));
  const next = createHarnessAssembly({ susanHomeParent: root });
  expect(
    (await next.assemble({ session: { kind: "picker" }, newSessionCwd: root }))
      .kind,
  ).toBe("session-picker");
  await writeFile(configPath, JSON.stringify(modelConfig("second")));
  const resumed = await next.assemble({
    session: { kind: "id", id: first.session.id },
    newSessionCwd: root,
  });
  if (resumed.kind !== "ready") throw new Error(JSON.stringify(resumed));
  expect(resumed.harness.getSnapshot().model).toBe("first");
  expect(JSON.stringify(resumed.config)).not.toContain("test-secret");
  expect(await next.reload()).toMatchObject({
    kind: "updated",
    config: { defaultModel: "second" },
  });
  expect(resumed.harness.getSnapshot().model).toBe("second");
  await writeFile(configPath, "{");
  expect((await next.reload()).kind).toBe("config-error");
  expect(resumed.harness.getSnapshot().model).toBe("second");
  expect(
    await next.assemble({ session: { kind: "new" }, newSessionCwd: root }),
  ).toMatchObject({ kind: "ready", harness: resumed.harness });
});
it("saves model defaults into the latest file but keeps external fields locked until reload", async () => {
  const { root, configPath, assembly } = await fixture();
  await writeFile(configPath, JSON.stringify(modelConfig()));
  const first = await assembly.assemble({
    session: { kind: "new" },
    newSessionCwd: root,
  });
  if (first.kind !== "ready") throw new Error(JSON.stringify(first));
  await writeFile(
    configPath,
    JSON.stringify(modelConfig("first", "https://changed.test/v1")),
  );
  expect(
    await assembly.applyModelSelection({
      providerAlias: "local",
      model: "second",
      reasoningEffort: "low",
    }),
  ).toMatchObject({
    kind: "updated",
    config: { defaultModel: "second", providers: [{ host: "example.test" }] },
  });
  expect(first.harness.getSnapshot()).toMatchObject({
    model: "second",
    reasoningEffort: "low",
  });
  expect(await assembly.reload()).toMatchObject({
    kind: "updated",
    config: { defaultModel: "second", providers: [{ host: "changed.test" }] },
  });
  await writeFile(configPath, "invalid");
  expect(
    (
      await assembly.applyModelSelection({
        providerAlias: "local",
        model: "first",
        reasoningEffort: "minimal",
      })
    ).kind,
  ).toBe("config-error");
  expect(first.harness.getSnapshot().model).toBe("second");
});

it("recovers an initial Config Error by reloading the same object", async () => {
  const { root, configPath, assembly } = await fixture();
  await rm(configPath);
  expect(
    (
      await assembly.assemble({
        session: { kind: "last" },
        newSessionCwd: root,
      })
    ).kind,
  ).toBe("config-error");
  await writeFile(configPath, "{}", { mode: 0o600 });
  expect((await assembly.reload()).kind).toBe("updated");
  expect(
    (
      await assembly.assemble({
        session: { kind: "last" },
        newSessionCwd: root,
      })
    ).kind,
  ).toBe("ready");
});

it("returns structured path and missing-id failures without replacing the current Session", async () => {
  const { root, assembly } = await fixture();
  const request = { session: { kind: "new" as const }, newSessionCwd: root };
  expect(
    await createHarnessAssembly({ susanHomeParent: "relative" }).assemble(
      request,
    ),
  ).toMatchObject({ kind: "startup-error", error: { stage: "options" } });
  expect(
    await assembly.assemble({ ...request, newSessionCwd: "relative" }),
  ).toMatchObject({ kind: "startup-error", error: { stage: "options" } });
  const first = await assembly.assemble(request);
  if (first.kind !== "ready") throw new Error(JSON.stringify(first));
  expect(
    await assembly.assemble({
      ...request,
      session: { kind: "id", id: "missing" },
    }),
  ).toMatchObject({ kind: "startup-error", error: { stage: "session" } });
  expect(
    await assembly.assemble({
      ...request,
      newSessionCwd: join(root, "missing"),
    }),
  ).toMatchObject({ kind: "startup-error", error: { stage: "cwd" } });
  expect(await assembly.assemble(request)).toMatchObject({
    kind: "ready",
    harness: first.harness,
  });
});

it("re-reads a picked Session, uses Header cwd, and never scans past the latest Session for an empty one", async () => {
  const { root, assembly } = await fixture();
  const { createSessionStore } = await import("../src/core/session");
  const store = createSessionStore({
    sessionsDirectory: join(root, ".susan", "sessions"),
  });
  const older = await store.createSession({ cwd: root });
  if (!older.ok) throw new Error(older.error.message);
  // Persist a newer nonempty Session so new cannot reuse the earlier empty one.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const latest = await store.createSession({ cwd: root });
  if (!latest.ok) throw new Error(latest.error.message);
  await store.appendMessage(latest.value.header.id, {
    role: "user",
    content: "pending request",
  });
  expect(
    (
      await assembly.assemble({
        session: { kind: "picker" },
        newSessionCwd: root,
      })
    ).kind,
  ).toBe("session-picker");
  await store.appendMessage(latest.value.header.id, {
    role: "assistant",
    content: "newly saved response",
  });
  const resumed = await assembly.assemble({
    session: { kind: "id", id: latest.value.header.id },
    newSessionCwd: join(root, "missing"),
  });
  if (resumed.kind !== "ready") throw new Error(JSON.stringify(resumed));
  expect(resumed.harness.getSnapshot()).toMatchObject({
    cwd: root,
    messages: [
      { role: "user", content: "pending request" },
      { role: "assistant", content: "newly saved response" },
    ],
  });
  expect(resumed.inputHistory).toContain("pending request");
  const created = await assembly.assemble({
    session: { kind: "new" },
    newSessionCwd: root,
  });
  if (created.kind !== "ready") throw new Error(JSON.stringify(created));
  expect(created.session.id).not.toBe(older.value.header.id);
  expect(created.session.id).not.toBe(latest.value.header.id);
});

it("rejects Session and Config operations during an Agent Loop and preserves Pending on reload", async () => {
  const { createServer } = await import("node:http");
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing port");
  try {
    const { root, configPath, assembly } = await fixture();
    await writeFile(
      configPath,
      JSON.stringify(
        modelConfig("first", `http://127.0.0.1:${address.port}/v1`),
      ),
    );
    const first = await assembly.assemble({
      session: { kind: "new" },
      newSessionCwd: root,
    });
    if (first.kind !== "ready") throw new Error(JSON.stringify(first));
    const requested = once(server, "request");
    const run = first.harness.dispatch({
      type: "submit",
      content: "keep pending",
    });
    const [, response] = await requested;
    for (const result of [
      await assembly.assemble({
        session: { kind: "new" },
        newSessionCwd: root,
      }),
      await assembly.reload(),
      await assembly.applyModelSelection({
        providerAlias: "local",
        model: "second",
        reasoningEffort: "low",
      }),
    ])
      expect(result).toMatchObject({
        kind: "startup-error",
        error: { code: "SUSAN_ASSEMBLY_BUSY" },
      });
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "test failure", type: "invalid_request_error" },
      }),
    );
    await run;
    const pending = first.harness.getSnapshot();
    expect(pending.status).toBe("pending");
    await writeFile(configPath, JSON.stringify(modelConfig("second")));
    expect((await assembly.reload()).kind).toBe("updated");
    expect(first.harness.getSnapshot()).toMatchObject({
      ...pending,
      model: "second",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("reports Config IO errors as Config Error without discarding the locked configuration", async () => {
  const { root, configPath, assembly } = await fixture();
  const first = await assembly.assemble({
    session: { kind: "new" },
    newSessionCwd: root,
  });
  if (first.kind !== "ready") throw new Error(JSON.stringify(first));
  await rm(configPath);
  await mkdir(configPath, { mode: 0o700 });
  expect(await assembly.reload()).toMatchObject({
    kind: "config-error",
    error: { code: "SUSAN_CONFIG_IO", configPath },
  });
  expect(
    await assembly.assemble({ session: { kind: "new" }, newSessionCwd: root }),
  ).toMatchObject({ kind: "ready", harness: first.harness });
});

it("reloads incomplete model configuration into the existing Harness and blocks requests until selection", async () => {
  const { root, configPath, assembly } = await fixture();
  await writeFile(configPath, JSON.stringify(modelConfig()));
  const first = await assembly.assemble({
    session: { kind: "new" },
    newSessionCwd: root,
  });
  if (first.kind !== "ready") throw new Error(JSON.stringify(first));
  await writeFile(configPath, "{}");
  expect((await assembly.reload()).kind).toBe("updated");
  expect(first.harness.getSnapshot().model).toBeUndefined();
  expect(first.harness.getSnapshot().reasoningEffort).toBeUndefined();
  expect(
    await first.harness.dispatch({
      type: "submit",
      content: "must not request",
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "HARNESS_MODEL_CONFIG_INCOMPLETE" },
  });
  expect(first.harness.getSnapshot().messages).toEqual([]);
});
