import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, it } from "node:test";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_OUTPUT_TOKEN, loadModelConfig } from "../dist/index.js";

let server;
let origin;
let home;
let listing;
const requests = [];

before(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (!listing) { res.writeHead(503); res.end("down"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(listing));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "susan-discovery-"));
  requests.length = 0;
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function writeConfig(providers) {
  return writeFile(path.join(home, "config.json"), JSON.stringify({ providers }));
}

it("loads models from an OpenAI-compatible endpoint and saves them", async () => {
  listing = { object: "list", data: [
    { id: "plain", object: "model" },
    { id: "routed", object: "model", context_length: 200000, top_provider: { max_completion_tokens: 32000 } },
    { id: "windowed", object: "model", context_window: 256000, max_context_window: 1000000 },
    { id: "max-only", object: "model", max_context_window: 64000 },
  ] };
  await writeConfig({ gateway: { baseUrl: `${origin}/v1`, type: "openai-completion", apiKey: "key-1" } });
  const choices = await loadModelConfig(home);
  assert.equal(requests[0].url, "/v1/models?client_version=99.0.0");
  assert.equal(requests[0].headers.authorization, "Bearer key-1");
  assert.deepEqual(choices.map((choice) => choice.model), [
    { id: "plain", contextWindow: DEFAULT_CONTEXT_WINDOW, outputToken: DEFAULT_OUTPUT_TOKEN },
    { id: "routed", contextWindow: 200000, outputToken: 32000 },
    { id: "windowed", contextWindow: 256000, outputToken: DEFAULT_OUTPUT_TOKEN },
    { id: "max-only", contextWindow: 64000, outputToken: DEFAULT_OUTPUT_TOKEN },
  ]);
  const saved = JSON.parse(await readFile(path.join(home, "models-cache.json"), "utf8"));
  assert.deepEqual(saved, { gateway: choices.map((choice) => choice.model) });
});

it("reads the Codex model catalog", async () => {
  listing = { models: [
    { slug: "gpt-test", context_window: 272000, max_context_window: 872000, max_tokens: 128000,
      supported_reasoning_levels: [{ effort: "low", description: "Fast" }, { effort: "ultra", description: "Most" }] },
    { slug: "gemini-test", context_window: 1048576, max_context_window: 1048576, supported_reasoning_levels: [] },
  ] };
  await writeConfig({ proxy: { baseUrl: `${origin}/v1`, type: "responses", apiKey: "k" } });
  const choices = await loadModelConfig(home);
  assert.deepEqual(choices.map((choice) => choice.model), [
    { id: "gpt-test", contextWindow: 272000, outputToken: 128000, reasoningLevels: ["low", "ultra"] },
    { id: "gemini-test", contextWindow: 1048576, outputToken: DEFAULT_OUTPUT_TOKEN, reasoningLevels: [] },
  ]);
  assert.deepEqual(choices.map((choice) => choice.efforts), [{ low: "low", ultra: "ultra" }, {}]);
  const saved = JSON.parse(await readFile(path.join(home, "models-cache.json"), "utf8"));
  assert.deepEqual(saved.proxy[0].reasoningLevels, ["low", "ultra"]);
});

it("reads Anthropic model limits", async () => {
  listing = { data: [{ type: "model", id: "claude-test", display_name: "Test",
    created_at: "2026-01-01T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000 }],
  has_more: false, first_id: "claude-test", last_id: "claude-test" };
  await writeConfig({ claude: { baseUrl: origin, type: "anthropic", apiKey: "key-2" } });
  const choices = await loadModelConfig(home);
  assert.equal(requests[0].url.split("?")[0], "/v1/models");
  assert.equal(requests[0].headers["x-api-key"], "key-2");
  assert.deepEqual(choices[0].model, { id: "claude-test", contextWindow: 1000000, outputToken: 128000 });
  assert.ok("max" in choices[0].efforts);
});

it("keeps configured models and uses saved models when the endpoint fails", async () => {
  listing = { object: "list", data: [{ id: "remote", object: "model" }] };
  const providers = {
    gateway: { baseUrl: `${origin}/v1`, type: "responses", apiKey: "k" },
    fixed: { baseUrl: `${origin}/v1`, type: "responses", apiKey: "k",
      model: { id: "local", contextWindow: 1000, outputToken: 100 } },
  };
  await writeConfig(providers);
  await loadModelConfig(home);
  listing = null;
  const choices = await loadModelConfig(home);
  assert.deepEqual(choices.map((choice) => `${choice.providerName}/${choice.model.id}`),
    ["gateway/remote", "fixed/local"]);
  assert.equal(requests.length, 2);
});

it("fails when the endpoint is down and nothing was saved for the provider", async () => {
  listing = null;
  await writeFile(path.join(home, "models-cache.json"), JSON.stringify({
    gateway: { baseUrl: `${origin}/v1`, type: "responses", models: [{ id: "old", contextWindow: 1000, outputToken: 100 }] },
  }));
  await writeConfig({ gateway: { baseUrl: `${origin}/v1`, type: "responses", apiKey: "k" } });
  await assert.rejects(loadModelConfig(home), /gateway: cannot load models from/);
});
