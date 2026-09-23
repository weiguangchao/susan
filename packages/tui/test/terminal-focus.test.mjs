import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { Box, Static, Text, render } from "ink";
import { createElement } from "react";
import { Composer } from "../dist/components/Composer.js";
import { useTerminalFocus } from "../dist/use-terminal-focus.js";

function FocusedComposer() {
  const focused = useTerminalFocus();
  return createElement(Composer, {
    isActive: true,
    terminalFocused: focused,
    placeholder: "type here",
    initialHistory: [],
    onSubmit() {},
  });
}

function StreamingScreen({ lines, completed = false }) {
  const focused = useTerminalFocus();
  return createElement(Box, { flexDirection: "column" },
    createElement(Static, { items: completed ? [{ id: "answer" }] : [] },
      (item) => createElement(Text, { key: item.id },
        Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n"))),
    completed ? null : createElement(Text, null,
      Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n")),
    createElement(Composer, { isActive: true, terminalFocused: focused,
      placeholder: "type here", initialHistory: [], onSubmit() {} }),
    createElement(Text, null, "status"));
}

async function waitForFrame(frames, pattern, after = 0) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const frame = frames.slice(after).find((output) => pattern.test(output));
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`No frame matched ${pattern}; last frame: ${frames.at(-1)}`);
}

test("terminal focus changes the cursor fill and restores focus reporting on exit", async () => {
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

  const app = render(createElement(FocusedComposer),
    { stdin, stdout, stderr: stdout, patchConsole: false });
  try {
    await waitForFrame(frames, /type here/);
    assert.ok(frames.includes("\x1b[?1004h"));

    let after = frames.length;
    stdin.write("\x1b[O");
    const emptyBlurred = await waitForFrame(frames, /\x1b\[\?25h/, after);
    assert.doesNotMatch(emptyBlurred, /▯/);
    assert.match(emptyBlurred, /\x1b\[5G/);
    assert.ok(frames.includes("\x1b]12;#ffffff\x07"));
    after = frames.length;
    stdin.write("\x1b[I");
    await waitForFrame(frames, /\x1b\[\?25l/, after);
    assert.ok(frames.includes("\x1b]112\x07"));

    after = frames.length;
    stdin.write("abc");
    await waitForFrame(frames, /abc/, after);
    after = frames.length;
    stdin.write("\x1b[O");
    const blurred = await waitForFrame(frames, /\x1b\[\?25h/, after);
    assert.doesNotMatch(blurred, /▯/);
    assert.doesNotMatch(blurred, /\[O/);
    assert.match(blurred, /\x1b\[8G/);

    after = frames.length;
    stdin.write("\x1b[I");
    await waitForFrame(frames, /\x1b\[\?25l/, after);
  } finally {
    app.unmount();
  }
  assert.ok(frames.includes("\x1b[?1004l"));
});

test("unfocused cursor stays on the input row when streaming fills the terminal", async () => {
  const frames = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) { frames.push(String(chunk)); callback(); },
  });
  stdout.columns = 50;
  stdout.rows = 12;
  stdout.isTTY = true;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const app = render(createElement(StreamingScreen, { lines: 7 }),
    { stdin, stdout, stderr: stdout, patchConsole: false, maxFps: 1000 });
  try {
    await waitForFrame(frames, /line 6/);
    let after = frames.length;
    stdin.write("\x1b[O");
    await waitForFrame(frames, /\x1b\[\?25h/, after);
    after = frames.length;
    app.rerender(createElement(StreamingScreen, { lines: 8 }));
    await waitForFrame(frames, /line 7/, after);
    await waitForFrame(frames, /\x1b\[\?25h/, after);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const cursorMoves = [...frames.slice(after).join("").matchAll(/\x1b\[(\d+)A\x1b\[5G\x1b\[\?25h/g)]
      .map((match) => Number(match[1]));
    assert.ok(cursorMoves.length > 0);
    assert.deepEqual(cursorMoves, cursorMoves.map(() => 2));

    for (let turn = 0; turn < 5; turn++) {
      after = frames.length;
      stdin.write("\x1b[I");
      await waitForFrame(frames, /\x1b\[\?25l/, after);
      after = frames.length;
      stdin.write("\x1b[O");
      await waitForFrame(frames, /\x1b\[\?25h/, after);
      const focusOutput = frames.slice(after).join("");
      assert.doesNotMatch(focusOutput, /\n|\x1b\[2J/);
      assert.match(focusOutput, /\x1b\[2A\x1b\[5G\x1b\[\?25h/);
    }

    after = frames.length;
    app.rerender(createElement(StreamingScreen, { lines: 8, completed: true }));
    await waitForFrame(frames, /status/, after);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const completion = frames.slice(after).join("");
    assert.equal((completion.match(/status/g) ?? []).length, 1);
    after = frames.length;
    stdin.write("\x1b[I");
    const refocused = await waitForFrame(frames, /\x1b\[\?25l/, after);
    assert.match(refocused, /\x1b\[2B\x1b\[1G/);

    for (let turn = 0; turn < 5; turn++) {
      after = frames.length;
      stdin.write("\x1b[O");
      await waitForFrame(frames, /\x1b\[\?25h/, after);
      after = frames.length;
      stdin.write("\x1b[I");
      await waitForFrame(frames, /\x1b\[\?25l/, after);
      assert.doesNotMatch(frames.slice(after).join(""), /\x1b\[2J/);
    }
  } finally {
    app.unmount();
  }
});
