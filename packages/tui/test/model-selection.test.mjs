import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { Agent, modelChoices, loadModelPreferences } from "@susan/harness";
import { runCommand } from "../dist/commands.js";
import { ModelSelection } from "../dist/model-selection.js";
import { startFakeOpenAI } from "../../harness/test/fakes/openai.mjs";

it("remembers each model's reasoning level when switching and after restart", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "susan-model-"));
  try {
    const choices = modelChoices({ providers: {
      gateway: { type: "responses", baseUrl: "http://localhost:1234/v1", apiKey: "test",
        model: [
          { name: "A", id: "a", contextWindow: 10000, outputToken: 1000 },
          { name: "B", id: "b", contextWindow: 10000, outputToken: 1000,
            reasoningEffort: { low: null } },
        ] },
    } });
    const selection = new ModelSelection(choices, {}, home);
    assert.equal(selection.effort, undefined);
    assert.equal(selection.label, "A (gateway/a)");
    const firstProviderId = selection.provider().id;
    selection.setEffort("high");
    selection.select("gateway/b");
    assert.notEqual(selection.provider().id, firstProviderId);
    assert.equal(selection.effort, undefined);
    assert.throws(() => selection.setEffort("low"), /unavailable/);
    selection.setEffort("xhigh");
    selection.select("gateway/a");
    assert.equal(selection.effort, "high");
    await selection.save();
    const restored = new ModelSelection(choices, await loadModelPreferences(home), home);
    restored.select("gateway/b");
    assert.equal(restored.effort, "xhigh");
    const notices = [];
    const ctx = { selection: restored, busy: false, onModelChange() {},
      notice(_level, message) { notices.push(message); } };
    assert.equal(runCommand("/reasoning", ctx), true);
    assert.deepEqual(notices.pop().split("\n").slice(0, 2), ["  default", "  none"]);
    assert.equal(runCommand("/reasoning default", ctx), true);
    assert.equal(restored.effort, undefined);
    assert.equal(runCommand("/reasoning", ctx), true);
    assert.deepEqual(notices.pop().split("\n").slice(0, 2), ["* default", "  none"]);
    await restored.save();
    assert.equal((await loadModelPreferences(home))["gateway/b"], undefined);
    const reset = new ModelSelection(choices, await loadModelPreferences(home), home);
    reset.select("gateway/b");
    assert.equal(reset.effort, undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("restores only the last model used for a session", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "susan-last-model-"));
  try {
    const choices = modelChoices({ providers: {
      gateway: { type: "responses", baseUrl: "http://localhost:1234/v1", apiKey: "test",
        model: [
          { name: "A", id: "a", contextWindow: 10000, outputToken: 1000 },
          { name: "B", id: "b", contextWindow: 10000, outputToken: 1000 },
        ] },
    } });
    const selection = new ModelSelection(choices, {}, home);
    selection.select("gateway/b");
    await selection.save();
    assert.equal(new ModelSelection(choices, await loadModelPreferences(home), home).key, "gateway/a");

    await selection.recordUse();
    assert.equal((await loadModelPreferences(home)).lastUsedModel, "gateway/b");
    const restored = new ModelSelection(choices, await loadModelPreferences(home), home);
    assert.equal(restored.key, "gateway/b");
    restored.select("gateway/a");
    await restored.save();
    assert.equal(new ModelSelection(choices, await loadModelPreferences(home), home).key, "gateway/b");

    await restored.recordUse();
    assert.equal(new ModelSelection(choices, await loadModelPreferences(home), home).key, "gateway/a");
    assert.equal(new ModelSelection(choices.slice(0, 1), await loadModelPreferences(home), home).key, "gateway/a");
    assert.equal(new ModelSelection(choices.slice(1), await loadModelPreferences(home), home).key, "gateway/b");
  } finally { await rm(home, { recursive: true, force: true }); }
});

it("sends none explicitly and omits effort for default", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "susan-effort-"));
  const fake = await startFakeOpenAI();
  try {
    const choices = modelChoices({ providers: {
      gateway: { type: "openai-completion", baseUrl: fake.url, apiKey: "test",
        model: { name: "A", id: "a", contextWindow: 10000, outputToken: 1000 } },
    } });
    const selection = new ModelSelection(choices, {}, home);
    selection.setEffort("none");
    for await (const _event of new Agent({ root: home, provider: selection.provider() }).run("list files")) {}
    assert.equal(fake.log[0].reasoning_effort, "none");
    fake.log.length = 0;
    selection.setEffort("default");
    for await (const _event of new Agent({ root: home, provider: selection.provider() }).run("list files")) {}
    assert.equal(fake.log[0].reasoning_effort, undefined);
  } finally {
    await fake.close();
    await rm(home, { recursive: true, force: true });
  }
});
