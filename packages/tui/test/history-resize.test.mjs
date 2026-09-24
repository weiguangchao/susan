import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { render } from "ink";
import { createElement } from "react";
import { App } from "../dist/App.js";
import { InputHistory } from "../dist/input-history.js";

async function waitFor(frames, pattern, start = 0) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const output = frames.slice(start).join("");
    if (pattern.test(output)) return output;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`missing ${pattern} in resized output: ${JSON.stringify(frames.slice(start).join("").slice(-1500))}`);
}

test("completed output reflows when terminal width grows", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "susan-resize-"));
  const previousHome = process.env.SUSAN_HOME;
  process.env.SUSAN_HOME = home;
  const frames = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) { frames.push(String(chunk)); callback(); },
  });
  stdout.columns = 40;
  stdout.rows = 24;
  stdout.isTTY = true;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const provider = { id: "test", label: "test-model", stream() { throw Error("unused"); } };
  const inputHistory = await InputHistory.load(home);
  const app = render(createElement(App, {
    root: "/tmp/project", provider, mocked: true, selection: null,
    inputHistory,
  }), { stdin, stdout, stderr: stdout, patchConsole: false });
  try {
    await waitFor(frames, /ask susan to do something/);
    const command = `/${"x".repeat(85)}`;
    stdin.write(command);
    await waitFor(frames, /x{12}/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    stdin.write("\r");
    await waitFor(frames, /unknown command/);
    const beforeResize = frames.length;
    stdout.columns = 120;
    stdout.emit("resize");
    const repainted = await waitFor(frames, /unknown command/, beforeResize);
    const plain = repainted.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g, "");
    assert.ok(plain.includes(`unknown command: ${command} - try /help`));
    assert.equal(plain.split(`unknown command: ${command}`).length - 1, 1);
    const beforeShrink = frames.length;
    stdout.columns = 32;
    stdout.emit("resize");
    const shrunk = await waitFor(frames, /unknown command/, beforeShrink);
    assert.ok(shrunk.includes("ask susan to do something"));
    const beforeRestore = frames.length;
    stdout.columns = 120;
    stdout.emit("resize");
    const restored = await waitFor(frames, /unknown command/, beforeRestore);
    const restoredPlain = restored.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g, "");
    assert.ok(restoredPlain.includes(`unknown command: ${command} - try /help`));
  } finally {
    app.unmount();
    await inputHistory.record("test cleanup");
    if (previousHome === undefined) delete process.env.SUSAN_HOME;
    else process.env.SUSAN_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
