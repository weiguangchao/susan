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

function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

async function waitForFrame(frames, pattern) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const frame = frames.at(-1) ?? "";
    if (pattern.test(frame)) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`No frame matched ${pattern}; last frame: ${frames.at(-1)}`);
}

test("token usage stays visible while running and cache rate accumulates across prompts", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "susan-status-"));
  const inputHistory = await InputHistory.load(home);
  const previousHome = process.env.SUSAN_HOME;
  process.env.SUSAN_HOME = home;

  const frames = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      const frame = String(chunk);
      if (frame.includes("test-model")) frames.push(frame);
      callback();
    },
  });
  stdout.columns = 100;
  stdout.rows = 30;
  stdout.isTTY = true;

  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const first = deferred();
  const second = deferred();
  const finish = deferred();
  let requestCount = 0;
  const provider = {
    id: "test",
    label: "test-model",
    stream() {
      const requestNumber = ++requestCount;
      return {
        async *[Symbol.asyncIterator]() {
          await first.promise;
          yield { type: "text_delta", text: "hello" };
          await second.promise;
          yield { type: "text_delta", text: " world" };
          await finish.promise;
        },
        async final() {
          return {
            content: [{ type: "text", text: "hello world" }],
            stopReason: "end_turn",
            usage: { inputTokens: 42, outputTokens: 5,
              cacheReadTokens: requestNumber === 1 ? 0 : 21 },
          };
        },
      };
    },
  };

  const app = render(createElement(App, {
    root: home,
    provider,
    mocked: false,
    selection: null,
    inputHistory,
  }), { stdin, stdout, stderr: stdout, debug: true, patchConsole: false });

  try {
    const initial = await waitForFrame(frames, /ask susan to do something/);
    assert.doesNotMatch(initial, /cached \(|\b\d+ out\b/);

    stdin.write("hello");
    await waitForFrame(frames, /› hello/);
    stdin.write("\r");
    await waitForFrame(frames, /working - esc to interrupt/);
    const running = await waitForFrame(frames, /[\d.]+k? \/ — \(—%\)/);
    assert.doesNotMatch(running, /cached \(|\b\d+ out\b/);
    assert.doesNotMatch(running, /~\d/);

    first.release();
    const firstOutput = await waitForFrame(frames, /\nhello\n/);
    assert.doesNotMatch(firstOutput, /cached \(/);
    assert.doesNotMatch(firstOutput, /\b\d+ out\b/);
    second.release();
    const secondOutput = await waitForFrame(frames, /\nhello world\n/);
    assert.doesNotMatch(secondOutput, /\b\d+ out\b/);

    finish.release();
    const completed = await waitForFrame(frames, /42 \/ — \(—%\)/);
    assert.doesNotMatch(completed, /cached \(/);
    assert.doesNotMatch(completed, /\b\d+ out\b/);

    stdin.write("again");
    await waitForFrame(frames, /› again/);
    stdin.write("\r");
    const secondCompleted = await waitForFrame(frames, /42 \/ — \(—%\) cached \(25%\)/);
    assert.doesNotMatch(secondCompleted, /~\d/);
  } finally {
    first.release();
    second.release();
    finish.release();
    app.unmount();
    if (previousHome === undefined) delete process.env.SUSAN_HOME;
    else process.env.SUSAN_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
