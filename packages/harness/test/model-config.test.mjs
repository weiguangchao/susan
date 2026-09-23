import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";
import {
  loadModelConfig, loadModelPreferences, reasoningChoices, saveModelPreferences,
} from "../dist/index.js";

let home;
before(async () => { home = await mkdtemp(path.join(os.tmpdir(), "susan-config-")); });
after(async () => { await rm(home, { recursive: true, force: true }); });

it("offers the OpenAI API effort values for both endpoints", () => {
  const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  assert.deepEqual(Object.keys(reasoningChoices("openai-completion")), levels);
  assert.deepEqual(Object.keys(reasoningChoices("responses")), levels);
});

it("loads configured providers and hides reasoning levels set to null", async () => {
  await writeFile(path.join(home, "confg.json"), JSON.stringify({ providers: {
    gateway: {
      baseUrl: "http://localhost:1234/v1", type: "responses", apiKey: "test",
      model: [{ id: "test-model", contextWindow: 32000,
        outputToken: 4000, reasoningEffort: { low: null, high: "high" } }],
    },
  } }));
  const choices = await loadModelConfig(home);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].model.id, "test-model");
  assert.equal(choices[0].efforts.low, undefined);
  assert.equal(choices[0].efforts.high, "high");
});

it("stores reasoning selection by provider and model", async () => {
  await saveModelPreferences({ "gateway/test-model": "high", "other/test-model": "medium" }, home);
  assert.deepEqual(await loadModelPreferences(home), {
    "gateway/test-model": "high", "other/test-model": "medium",
  });
});

it("rejects malformed model limits before starting", async () => {
  await writeFile(path.join(home, "confg.json"), JSON.stringify({ providers: {
    gateway: { baseUrl: "http://localhost:1234/v1", type: "responses", apiKey: "test",
      model: { id: "bad", contextWindow: 10, outputToken: 11 } },
  } }));
  await assert.rejects(loadModelConfig(home), /outputToken exceeds contextWindow/);
});
