import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, startApp, waitForFrame, usage } from "./app-fixture.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const tool = done.indexOf("ls . ✔");
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
