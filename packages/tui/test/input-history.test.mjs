import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { InputHistory } from "../dist/input-history.js";

it("keeps one input history across model changes and restarts", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "susan-history-"));
  try {
    const history = await InputHistory.load(home);
    await history.record("first provider input");
    await history.record("/model gateway/other-model");
    await history.record("second provider input");

    assert.deepEqual(history.entries, [
      "second provider input", "/model gateway/other-model", "first provider input",
    ]);
    const restored = await InputHistory.load(home);
    assert.deepEqual(restored.entries, history.entries);
    const file = path.join(home, "input-history.json");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), history.entries);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("serializes rapid writes and keeps the latest 100 inputs", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "susan-history-"));
  try {
    const history = await InputHistory.load(home);
    await Promise.all(Array.from({ length: 105 }, (_, index) => history.record(`input ${index}`)));
    const restored = await InputHistory.load(home);
    assert.equal(restored.entries.length, 100);
    assert.equal(restored.entries[0], "input 104");
    assert.equal(restored.entries.at(-1), "input 5");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
