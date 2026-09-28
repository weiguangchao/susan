import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { MockProvider } from "@susan/harness";
import { render } from "ink";
import { createElement } from "react";
import { App } from "../dist/App.js";
import { InputHistory } from "../dist/input-history.js";

async function waitFor(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("agent reply did not finish");
}

test("completed reply remains above the footer on a 24-row terminal", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "susan-session-end-"));
  const previousHome = process.env.SUSAN_HOME;
  process.env.SUSAN_HOME = home;
  const frames = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) { frames.push(String(chunk)); callback(); },
  });
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.isTTY = true;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const app = render(createElement(App, {
    root: home, provider: new MockProvider(), mocked: true, selection: null,
    inputHistory: await InputHistory.load(home),
  }), { stdin, stdout, stderr: stdout, patchConsole: false });

  try {
    await waitFor(() => frames.join("").includes("ask susan to do something"));
    stdin.write("hello");
    await waitFor(() => frames.join("").includes("hello"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    stdin.write("\r");
    await waitFor(() => frames.join("").includes("Here is what the tool returned"));
    await waitFor(() => frames.join("").includes("ask susan to do something", frames.join("").lastIndexOf("Here is what the tool returned")));

    const bytes = frames.join("");
    assert.doesNotMatch(bytes, /\x1b\[3J/, "completing a run must preserve scrollback");
    const commit = bytes.lastIndexOf("\x1b[0J");
    assert.notEqual(commit, -1, "completed run should replace its live region");
    const plain = bytes.slice(commit).replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g, "");
    const lines = plain.split("\n");
    const answer = lines.findIndex((line) => line.includes("Here is what the tool returned"));
    const footer = lines.findIndex((line) => line.includes("ask susan to do something"));
    assert.ok(answer >= 0 && footer > answer, "answer and input must be in the final repaint");
    assert.ok(footer - answer < stdout.rows,
      `answer was pushed above the ${stdout.rows}-row screen by ${footer - answer} rows`);
  } finally {
    app.unmount();
    if (previousHome === undefined) delete process.env.SUSAN_HOME;
    else process.env.SUSAN_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
