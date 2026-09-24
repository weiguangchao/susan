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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFrame(frames, pattern) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const frame = frames.at(-1) ?? "";
    if (pattern.test(frame)) return frame;
    await sleep(10);
  }
  assert.fail(`No frame matched ${pattern}; last frame: ${frames.at(-1)}`);
}

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 };

/** Renders the real App against `provider` and types `prompt` into it. */
async function startApp(provider, prompt, { columns = 100, ready = /ask susan to do something/ } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "susan-reasoning-"));
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
  await waitForFrame(frames, new RegExp(`› ${prompt}`));
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
    stdin,
    async stop() {
      app.unmount();
      if (previousHome === undefined) delete process.env.SUSAN_HOME;
      else process.env.SUSAN_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    },
  };
}

const OPENING = "The user says the status bar flickers.";
const FILLER = " Either the bar re-renders on every delta or the numbers change width.".repeat(8);
const SECOND = "Confirmed, the percentage changes width mid-stream.";
const ANSWER = "The flicker is layout, not repaint.";

/**
 * Two model turns: think, call `ls`, then think again and answer. Each gate
 * holds the stream at a point the test wants to look at.
 */
function thinkActThinkProvider(gates) {
  let request = 0;
  return {
    id: "test",
    label: "test-model",
    stream() {
      const turn = ++request;
      return {
        async *[Symbol.asyncIterator]() {
          if (turn === 1) {
            yield { type: "thinking_delta", text: OPENING };
            yield { type: "thinking_delta", text: FILLER };
            await gates.firstBlock.promise;
            yield { type: "thinking_end" };
            yield { type: "tool_use_start", id: "call_1", name: "ls" };
            return;
          }
          yield { type: "thinking_delta", text: SECOND };
          yield { type: "thinking_end" };
          yield { type: "text_delta", text: ANSWER };
          await gates.answer.promise;
        },
        async final() {
          if (turn === 1) {
            return {
              content: [
                { type: "thinking", thinking: OPENING + FILLER },
                { type: "tool_use", id: "call_1", name: "ls", input: { path: "." } },
              ],
              stopReason: "tool_use",
              usage,
            };
          }
          return {
            content: [{ type: "thinking", thinking: SECOND }, { type: "text", text: ANSWER }],
            stopReason: "end_turn",
            usage,
          };
        },
      };
    },
  };
}

test("reasoning streams in full, then stays in the transcript as its own block", async () => {
  const gates = { firstBlock: deferred(), answer: deferred() };
  const session = await startApp(thinkActThinkProvider(gates), "why");
  try {
    // The opening sentence is well over 400 characters from the end, so the
    // old sliding tail would have cut it off.
    const streaming = await waitForFrame(session.frames, /Thinking · \d/);
    assert.match(streaming, new RegExp(OPENING.replace(/\./g, "\\.")));
    assert.match(streaming, /Working · \d/);

    gates.firstBlock.release();
    await waitForFrame(session.frames, new RegExp(ANSWER.replace(/\./g, "\\.")));
    gates.answer.release();
    const done = await waitForFrame(session.frames, /ask susan to do something/);

    const headers = done.match(/✳ Thinking · \d[\d.ms]*/g) ?? [];
    assert.equal(headers.length, 2, "each reasoning block keeps its own header");
    const first = done.indexOf(OPENING);
    const tool = done.indexOf("✔ ls");
    const second = done.indexOf(SECOND);
    const answer = done.lastIndexOf(ANSWER);
    assert.ok(first >= 0 && tool > first, "first block sits above the tool row");
    assert.ok(second > tool, "second block sits below the tool row");
    assert.ok(answer > second, "the answer follows the reasoning that led to it");
    assert.doesNotMatch(done, /Working/);
  } finally {
    gates.firstBlock.release();
    gates.answer.release();
    await session.stop();
  }
});

test("interrupting mid-thought keeps the partial block with a frozen timer", async () => {
  const provider = {
    id: "test",
    label: "test-model",
    stream(request) {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "thinking_delta", text: OPENING };
          await new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
        async final() { throw new Error("unreachable"); },
      };
    },
  };
  const session = await startApp(provider, "why");
  try {
    await waitForFrame(session.frames, /Thinking · \d/);
    session.stdin.write("\x1b");
    const stopped = await waitForFrame(session.frames, /interrupted/);
    assert.match(stopped, new RegExp(OPENING.replace(/\./g, "\\.")));
    assert.doesNotMatch(stopped, /Working/);
    const header = stopped.match(/Thinking · [\d.ms]+/)?.[0];
    assert.ok(header, "the partial block keeps its header and duration");

    await sleep(300);
    assert.equal(session.frames.at(-1).match(/Thinking · [\d.ms]+/)?.[0], header,
      "the partial block's timer does not keep ticking");
  } finally {
    await session.stop();
  }
});

test("a turn without reasoning shows no thinking header", async () => {
  const gate = deferred();
  const provider = {
    id: "test",
    label: "test-model",
    stream() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text_delta", text: ANSWER };
          await gate.promise;
        },
        async final() {
          return { content: [{ type: "text", text: ANSWER }], stopReason: "end_turn", usage };
        },
      };
    },
  };
  const session = await startApp(provider, "why");
  try {
    const running = await waitForFrame(session.frames, /Working · \d/);
    assert.doesNotMatch(running, /Thinking/);
    gate.release();
    const done = await waitForFrame(session.frames, /ask susan to do something/);
    assert.doesNotMatch(done, /Thinking/);
  } finally {
    gate.release();
    await session.stop();
  }
});

test("the working row stays on one line on a narrow terminal", async () => {
  const gate = deferred();
  const provider = {
    id: "test",
    label: "test-model",
    stream() {
      return {
        async *[Symbol.asyncIterator]() { await gate.promise; },
        async final() { return { content: [], stopReason: "end_turn", usage }; },
      };
    },
  };
  const session = await startApp(provider, "why", { columns: 14, ready: /test-model/ });
  try {
    const running = await waitForFrame(session.frames, /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/);
    const row = running.split("\n").find((line) => /Working/.test(line));
    assert.ok(row, "spinner row keeps its label");
    assert.match(row, /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working/, "spinner is not shrunk away");
  } finally {
    gate.release();
    await session.stop();
  }
});
