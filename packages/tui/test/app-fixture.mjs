import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import { App } from "../dist/App.js";
import { InputHistory } from "../dist/input-history.js";

export function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForFrame(frames, pattern) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const frame = frames.at(-1) ?? "";
    if (pattern.test(frame)) return frame;
    await sleep(10);
  }
  assert.fail(`No frame matched ${pattern}; last frame: ${frames.at(-1)}`);
}

export const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 };

/** Renders the real App against `provider` and types `prompt` into it. */
export async function startApp(provider, prompt, { columns = 100, ready = /ask susan to do something/, setup = async () => {} } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "susan-reasoning-"));
  await setup(home);
  const previousHome = process.env.SUSAN_HOME;
  process.env.SUSAN_HOME = home;

  const frames = [];
  const output = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      const frame = String(chunk);
      output.push(frame);
      // Every App frame draws the composer prompt; other writes are bare escapes.
      if (frame.includes("❯")) frames.push(frame);
      callback();
    },
  });
  stdout.columns = columns;
  stdout.rows = 30;
  stdout.isTTY = true;

  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const app = render(createElement(App, {
    root: home,
    provider,
    mocked: false,
    selection: null,
    inputHistory: await InputHistory.load(home),
  }), { stdin, stdout, stderr: stdout, debug: true, patchConsole: false });

  await waitForFrame(frames, ready);
  stdin.write(prompt);
  await waitForFrame(frames, new RegExp(`❯ ${prompt}`));
  // Ink swaps in the composer's input handler in an effect that can land after
  // the frame, so the first enter may reach a handler that still sees an empty
  // box. Enter on an empty box is ignored, so pressing it again is safe.
  for (let attempt = 0; !/Working/.test(frames.at(-1) ?? ""); attempt++) {
    assert.ok(attempt < 20, "the prompt was never submitted");
    stdin.write("\r");
    await sleep(50);
  }

  return {
    frames,
    output,
    stdin,
    stdout,
    home,
    async stop() {
      app.unmount();
      if (previousHome === undefined) delete process.env.SUSAN_HOME;
      else process.env.SUSAN_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    },
  };
}

