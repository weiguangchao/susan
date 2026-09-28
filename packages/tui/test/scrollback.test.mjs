import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { Box, Static, Text, render } from "ink";
import { createElement } from "react";

const pause = () => new Promise((resolve) => setTimeout(resolve, 80));

function Screen({ lines, completed = false }) {
  return createElement(Box, { flexDirection: "column" },
    createElement(Static, { items: completed
      ? [{ id: "earlier-turn" }, { id: "answer" }]
      : [{ id: "earlier-turn" }] },
      (item) => createElement(Text, { key: item.id }, item.id === "answer"
        ? Array.from({ length: lines }, (_, index) => `stream-${index}`).join("\n")
        : Array.from({ length: 20 }, (_, index) => `earlier-turn-${index}`).join("\n"))),
    completed ? null : createElement(Text, null,
      Array.from({ length: lines }, (_, index) => `stream-${index}`).join("\n")),
    createElement(Text, null, "footer"));
}

function terminalHistory(bytes, height) {
  const screen = Array(height).fill("");
  const history = [];
  let row = 0;
  let column = 0;
  for (let index = 0; index < bytes.length;) {
    const char = bytes[index];
    if (char === "\x1b") {
      const match = /^\x1b\[([\d;?]*)([A-Za-z])/.exec(bytes.slice(index));
      assert.ok(match, `unhandled terminal escape at ${index}`);
      const amount = Number(match[1].split(";")[0]) || 1;
      switch (match[2]) {
        case "H": {
          const [y = "1", x = "1"] = match[1].split(";");
          row = Math.max(0, Math.min(height - 1, Number(y) - 1));
          column = Math.max(0, Number(x) - 1);
          break;
        }
        case "G": column = amount - 1; break;
        case "A": row = Math.max(0, row - amount); break;
        case "B": row = Math.min(height - 1, row + amount); break;
        case "K": screen[row] = ""; break;
        case "J": {
          for (let y = row; y < height; y++) screen[y] = "";
          break;
        }
        case "h": case "l": case "m": break;
        default: assert.fail(`unhandled terminal control ${match[2]}`);
      }
      index += match[0].length;
      continue;
    }
    if (char === "\n") {
      if (row === height - 1) {
        history.push(screen.shift());
        screen.push("");
      } else row++;
      column = 0;
    } else if (char !== "\r") {
      const line = screen[row];
      screen[row] = line.slice(0, column) + char + line.slice(column + 1);
      column++;
    }
    index++;
  }
  return history;
}

test("growing full-height stream preserves native scrollback", async () => {
  const writes = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) { writes.push(String(chunk)); callback(); },
  });
  stdout.columns = 50;
  stdout.rows = 12;
  stdout.isTTY = true;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const app = render(createElement(Screen, { lines: 11 }),
    { stdin, stdout, stderr: stdout, patchConsole: false, maxFps: 1000 });
  try {
    await pause();
    const firstUpdate = writes.length;
    for (const lines of [12, 13, 14]) {
      app.rerender(createElement(Screen, { lines }));
      await pause();
    }
    const updates = writes.slice(firstUpdate).join("");
    assert.doesNotMatch(updates, /\x1b\[[23]J/,
      "stream updates must not clear the screen or native scrollback");
    assert.doesNotMatch(updates, /earlier-turn/,
      "an earlier turn must not be replayed into scrollback");
    assert.match(updates, /\x1b\[12;1H\n/,
      "each overflow row must scroll into native terminal history");
    assert.match(updates, /stream-13/);
    assert.match(writes.slice(0, firstUpdate).join(""), /footer/);

    const beforeContraction = writes.length;
    app.rerender(createElement(Screen, { lines: 3 }));
    await pause();
    const contraction = writes.slice(beforeContraction).join("");
    assert.doesNotMatch(contraction, /\x1b\[[23]J/,
      "a shrinking live region must also preserve scrollback");
    assert.match(contraction, /earlier-turn-19/,
      "the visible tail of a long transcript must return after contraction");
  } finally {
    app.unmount();
  }
});

test("a large stream chunk writes every displaced line to terminal history", async () => {
  const writes = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) { writes.push(String(chunk)); callback(); },
  });
  stdout.columns = 50;
  stdout.rows = 12;
  stdout.isTTY = true;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const app = render(createElement(Screen, { lines: 11 }),
    { stdin, stdout, stderr: stdout, patchConsole: false, maxFps: 1000 });
  try {
    await pause();
    app.rerender(createElement(Screen, { lines: 30 }));
    await pause();
    const expectedHistory = [
      ...Array.from({ length: 20 }, (_, index) => `earlier-turn-${index}`),
      ...Array.from({ length: 19 }, (_, index) => `stream-${index}`),
    ];
    assert.deepEqual(terminalHistory(writes.join(""), stdout.rows), expectedHistory);
    app.rerender(createElement(Screen, { lines: 30, completed: true }));
    await pause();
    assert.deepEqual(terminalHistory(writes.join(""), stdout.rows), expectedHistory,
      "committing the answer must not duplicate lines already in scrollback");
  } finally {
    app.unmount();
  }
});
