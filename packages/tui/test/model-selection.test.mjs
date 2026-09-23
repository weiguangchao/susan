import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { modelChoices, loadModelPreferences } from "@susan/harness";
import { ModelSelection } from "../dist/model-selection.js";

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
    const firstProviderId = selection.provider().id;
    selection.setEffort("high");
    selection.select("gateway/b");
    assert.notEqual(selection.provider().id, firstProviderId);
    assert.equal(selection.effort, "medium");
    assert.throws(() => selection.setEffort("low"), /unavailable/);
    selection.setEffort("xhigh");
    selection.select("gateway/a");
    assert.equal(selection.effort, "high");
    await selection.save();
    const restored = new ModelSelection(choices, await loadModelPreferences(home), home);
    restored.select("gateway/b");
    assert.equal(restored.effort, "xhigh");
  } finally { await rm(home, { recursive: true, force: true }); }
});
