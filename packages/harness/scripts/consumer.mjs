// Executed by ordinary Node in the temporary installed consumer, never in the workspace.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as api from "@weiguangchao/susan-harness";

const expected = JSON.parse(await readFile(new URL("public-api.json", import.meta.url), "utf8"));
assert.deepEqual(Object.keys(api).sort(), expected.values.sort());
for (const path of ["core/harness", "dist/index.js", "src/index.ts", "package.json"]) {
  await assert.rejects(import("@weiguangchao/susan-harness/" + path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
}
const root = await mkdtemp(join(tmpdir(), "susan-consumer-"));
const originalCwd = process.cwd();
const wires = [];
let rejectImages = false;
let holdRequest;
let onHeld;
const server = createServer(async (request, response) => {
  try {
    let body = "";
    for await (const chunk of request) body += chunk;
    const wire = JSON.parse(body);
    wires.push(wire);
    if (holdRequest) {
      onHeld();
      await holdRequest;
    }
    if (rejectImages) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "unsupported image format" } }));
      return;
    }
    const last = wire.messages.at(-1);
    const call = last?.role === "user" && typeof last.content === "string" && last.content === "read image";
    if (!wire.stream) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ index: 0, message: { content: "done" }, finish_reason: "stop" }] }));
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    const delta = call ? { tool_calls: [{ index: 0, id: "read-image", type: "function", function: { name: "read", arguments: '{"path":"large.bmp"}' } }] } : { content: "done" };
    for (const chunk of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] },
    ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  } catch (error) { response.destroy(error); }
});
const ready = (result) => { assert.equal(result.kind, "ready", JSON.stringify(result)); return result; };
const ok = (result) => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const config = {
    defaultProvider: "local", defaultModel: "vision", defaultReasoningEffort: "low",
    providers: { local: { type: "openai-completion", apiKey: "consumer-secret", baseURL,
      models: [{ id: "vision", input: ["text", "image"] }, { id: "text", input: ["text"] }] } },
  };
  const home = join(root, ".susan");
  const configPath = join(home, "config.json");
  const assembly = api.createHarnessAssembly({ susanHomeParent: root });
  await assert.rejects(readFile(configPath), { code: "ENOENT" });
  const options = { session: { kind: "new" }, newSessionCwd: root };
  assert.equal((await assembly.assemble(options)).kind, "config-error");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  assert.equal((await assembly.reload()).kind, "updated");
  const first = ready(await assembly.assemble(options));
  assert.equal(wires.length, 0);
  assert.equal(process.cwd(), originalCwd);
  assert.ok(!JSON.stringify(first.config).includes("consumer-secret"));
  assert.equal(ready(await assembly.assemble(options)).harness, first.harness);
  assert.equal(ready(await api.createHarnessAssembly({ susanHomeParent: root }).assemble(options)).session.id, first.session.id);

  // A valid BMP exceeds the removed dimension and encoded-size limits.
  const width = 2400, height = 600, rowBytes = Math.ceil(width * 3 / 4) * 4;
  const bmp = Buffer.alloc(54 + rowBytes * height, 127);
  bmp.fill(0, 0, 54); bmp.write("BM"); bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18); bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(rowBytes * height, 34);
  await writeFile(join(root, "large.bmp"), bmp);
  assert.ok(bmp.toString("base64").length > 4.5 * 1024 * 1024);
  ok(await first.harness.dispatch({ type: "submit", content: "read image" }));
  assert.equal(first.harness.getSnapshot().status, "idle");
  assert.equal(first.harness.getSnapshot().messages.at(-1).content, "done");
  assert.equal(wires.length, 2);
  const imageURL = `data:image/bmp;base64,${bmp.toString("base64")}`;
  assert.equal(wires[1].messages.at(-1).content[1].image_url.url, imageURL);
  const store = api.createSessionStore({ sessionsDirectory: join(home, "sessions") });
  const transcript = ok(await store.loadSession(first.session.id));
  const image = transcript.messages.find((message) => message.role === "tool").content.find((block) => block.type === "image");
  assert.equal(image.mimeType, "image/bmp");
  assert.deepEqual(Buffer.from(image.data, "base64"), bmp);

  // Picker locks config; restoring uses Header cwd and does not issue requests.
  const next = api.createHarnessAssembly({ susanHomeParent: root });
  const picker = await next.assemble({ ...options, session: { kind: "picker" } });
  assert.equal(picker.kind, "session-picker");
  assert.ok(picker.sessions.some((session) => session.header.id === first.session.id));
  await writeFile(configPath, JSON.stringify({ ...config, defaultModel: "text" }));
  const resumed = ready(await next.assemble({ session: { kind: "id", id: first.session.id }, newSessionCwd: tmpdir() }));
  assert.equal(resumed.session.cwd, root);
  assert.equal(resumed.harness.getSnapshot().model, "vision");
  assert.deepEqual(resumed.inputHistory, ["read image"]);
  assert.equal(wires.length, 2);
  assert.equal((await next.reload()).kind, "updated");
  ok(await resumed.harness.dispatch({ type: "submit", content: "text followup" }));
  assert.ok(!JSON.stringify(wires.at(-1)).includes("image_url"));
  assert.equal((await next.applyModelSelection({ providerAlias: "local", model: "vision", reasoningEffort: "low" })).kind, "updated");
  ok(await resumed.harness.dispatch({ type: "submit", content: "vision followup" }));
  assert.ok(JSON.stringify(wires.at(-1)).includes(imageURL));
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).defaultModel, "vision");

  // Failures preserve the same Harness and its pending transcript.
  rejectImages = true;
  const failed = await resumed.harness.dispatch({ type: "submit", content: "rejected image" });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.providerFailure.httpStatus, 400);
  assert.equal(resumed.harness.getSnapshot().status, "pending");
  const persisted = ok(await store.loadSession(first.session.id));
  assert.deepEqual(persisted.messages.find((message) => message.role === "tool").content, transcript.messages.find((message) => message.role === "tool").content);
  const beforeReload = wires.length;
  assert.equal((await next.reload()).kind, "updated");
  assert.equal(resumed.harness.getSnapshot().status, "pending");
  assert.equal(wires.length, beforeReload);
  await writeFile(configPath, "{");
  assert.equal((await next.reload()).kind, "config-error");
  assert.equal((await next.applyModelSelection({ providerAlias: "local", model: "text", reasoningEffort: "low" })).kind, "config-error");
  assert.equal(resumed.harness.getSnapshot().model, "vision");
  assert.equal((await next.assemble({ ...options, session: { kind: "id", id: "missing" } })).kind, "startup-error");
  assert.equal((await next.assemble({ ...options, newSessionCwd: "relative" })).kind, "startup-error");
  await writeFile(configPath, JSON.stringify(config));
  const last = ready(await api.createHarnessAssembly({ susanHomeParent: root }).assemble({ ...options, session: { kind: "last" } }));
  assert.equal(last.session.id, first.session.id);
  assert.equal(last.harness.getSnapshot().status, "pending");
  assert.equal(wires.length, beforeReload);
  rejectImages = false;
  let release;
  holdRequest = new Promise((resolve) => { release = resolve; });
  const held = new Promise((resolve) => { onHeld = resolve; });
  const retry = resumed.harness.dispatch({ type: "retry" });
  await held;
  try {
    assert.equal((await next.reload()).kind, "startup-error");
    assert.equal((await next.assemble(options)).kind, "startup-error");
    assert.equal((await next.applyModelSelection({ providerAlias: "local", model: "text", reasoningEffort: "low" })).kind, "startup-error");
  } finally { release(); holdRequest = undefined; }
  ok(await retry);
  const fresh = ready(await next.assemble(options));
  assert.notEqual(fresh.session.id, first.session.id);
  assert.equal(fresh.harness.getSnapshot().model, "vision");

  // Empty stores and incomplete model configuration are valid startup branches.
  for (const kind of ["last", "picker"]) {
    const parent = join(root, `empty-${kind}`);
    await mkdir(join(parent, ".susan"), { recursive: true, mode: 0o700 });
    await writeFile(join(parent, ".susan/config.json"), "{}", { mode: 0o600 });
    const empty = api.createHarnessAssembly({ susanHomeParent: parent });
    const started = ready(await empty.assemble({ ...options, session: { kind } }));
    assert.equal(started.harness.getSnapshot().model, undefined);
    assert.deepEqual(started.harness.getSnapshot().messages, []);
    assert.equal((await empty.reload()).kind, "updated");
  }
  assert.equal((await api.createHarnessAssembly({ susanHomeParent: "relative" }).assemble(options)).kind, "startup-error");
  const missingCwdSession = ok(await store.createSession({ cwd: join(root, "absent") }));
  assert.equal((await next.assemble({ ...options, session: { kind: "id", id: missingCwdSession.header.id } })).kind, "startup-error");
  assert.equal(ready(await next.assemble(options)).harness, fresh.harness);

  // Model selection merges the latest file without reloading its other fields.
  const external = structuredClone(config);
  external.providers.local.baseURL = "https://changed.example/v1";
  await writeFile(configPath, JSON.stringify(external));
  const selected = await next.applyModelSelection({ providerAlias: "local", model: "text", reasoningEffort: "low" });
  assert.equal(selected.kind, "updated");
  assert.equal(selected.config.providers[0].host, new URL(baseURL).host);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).providers.local.baseURL, external.providers.local.baseURL);
  const reloaded = await next.reload();
  assert.equal(reloaded.kind, "updated");
  assert.equal(reloaded.config.providers[0].host, "changed.example");

  // Independent batteries and a custom Provider/Tool use only public contracts.
  const tools = api.createBuiltInToolSet({ sessionCwd: root });
  assert.deepEqual(tools.map((tool) => tool.name), ["read", "write", "edit", "bash", "grep", "find", "ls"]);
  const resolved = api.resolveConfig(config);
  assert.equal(resolved.ok, true);
  const client = api.createProviderClient(resolved.config.activeModel.provider);
  assert.equal((await client.complete({ model: "vision", messages: [] }, new AbortController().signal)).assistant.content, "done");
  const customSession = ok(await store.createSession({ cwd: root }));
  let calls = 0;
  const custom = api.createHarness({
    sessionStore: store, session: customSession, model: "custom", reasoningEffort: "low", contextWindow: 128000, maxOutputTokens: 1000,
    tools: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: {} }, execute: async () => api.textToolResult("custom tool") }],
    provider: { type: "openai-completion", complete: async () => { throw new Error("unexpected compaction"); }, async *stream() {
      yield { type: "response-complete", response: ++calls === 1
        ? { assistant: { role: "assistant", toolCalls: [{ id: "custom", name: "echo", arguments: {} }] }, finishReason: "tool_calls" }
        : { assistant: { role: "assistant", content: "custom done" }, finishReason: "stop" } };
    } },
  });
  ok(await custom.dispatch({ type: "submit", content: "custom" }));
  assert.equal(calls, 2);
  assert.equal(custom.getSnapshot().messages.at(-1).content, "custom done");
  assert.equal(process.cwd(), originalCwd);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
