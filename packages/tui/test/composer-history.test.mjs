import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { render } from "ink";
import { createElement } from "react";
import { Composer } from "../dist/components/Composer.js";

async function waitForFrame(frames, pattern) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const frame = frames.at(-1) ?? "";
    if (pattern.test(frame)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`No frame matched ${pattern}; last frame: ${frames.at(-1)}`);
}

test("up and down browse shared history and restore a draft after a model change", async () => {
  const frames = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      frames.push(String(chunk));
      callback();
    },
  });
  stdout.columns = 80;
  stdout.rows = 20;
  stdout.isTTY = true;

  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const submitted = [];
  const props = { isActive: true, initialHistory: ["provider A input"],
    onSubmit(value) { submitted.push(value); } };
  const app = render(createElement(Composer, { ...props, placeholder: "model A" }),
    { stdin, stdout, stderr: stdout, debug: true, patchConsole: false });
  try {
    await waitForFrame(frames, /model A/);
    stdin.write("draft");
    await waitForFrame(frames, /draft/);
    app.rerender(createElement(Composer, { ...props, placeholder: "model B" }));
    stdin.write("\x1b[A");
    await waitForFrame(frames, /provider A input/);
    stdin.write("\x1b[B");
    await waitForFrame(frames, /draft/);
    stdin.write("\r");
    await waitForFrame(frames, /model B/);
    assert.deepEqual(submitted, ["draft"]);
    stdin.write("\x1b[A");
    await waitForFrame(frames, /draft/);
    stdin.write("\x1b[A");
    await waitForFrame(frames, /provider A input/);
  } finally {
    app.unmount();
  }
});
