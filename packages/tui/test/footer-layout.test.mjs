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

for (const { rows, columns, mocked } of [
  { rows: 30, columns: 100, mocked: true },
  { rows: 24, columns: 80, mocked: true },
  { rows: 16, columns: 50, mocked: true },
  { rows: 24, columns: 80, mocked: false },
]) {
  test(`startup footer fills ${columns}x${rows} terminal (mocked=${mocked})`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "susan-footer-"));
    const previousHome = process.env.SUSAN_HOME;
    process.env.SUSAN_HOME = home;
    const frames = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) { frames.push(String(chunk)); callback(); },
    });
    stdout.columns = columns;
    stdout.rows = rows;
    stdout.isTTY = true;
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    stdin.ref = () => {};
    stdin.unref = () => {};
    const provider = { id: "test", label: "test-model", stream() { throw Error("unused"); } };
    const app = render(createElement(App, {
      root: "/tmp/project", provider, mocked, selection: null,
      inputHistory: await InputHistory.load(home),
    }), { stdin, stdout, stderr: stdout, patchConsole: false });
    try {
      const deadline = Date.now() + 1000;
      while (!frames.some((frame) => frame.includes("ask susan to do something"))) {
        assert.ok(Date.now() < deadline, "startup frame did not render");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const staticOutput = frames.find((frame) => frame.startsWith("▌ susan"));
      const footer = frames.find((frame) => frame.includes("ask susan to do something"));
      assert.ok(staticOutput?.startsWith("▌ susan"), "banner must remain visible");
      assert.ok(footer?.includes("/tmp/project"), "current project must remain visible");
      assert.equal(staticOutput.split("\n").length - 1 + footer.split("\n").length, rows);
      assert.equal(footer.endsWith("\n"), false, "bottom row must not scroll away");
      if (columns === 80 && rows === 24 && mocked) {
        stdout.rows = 20; stdout.emit("resize");
        await new Promise((resolve) => setTimeout(resolve, 30));
        const after = frames.length;
        stdout.rows = 28; stdout.emit("resize");
        const deadline = Date.now() + 1000;
        while (!frames.slice(after).includes("\n".repeat(8))) {
          assert.ok(Date.now() < deadline, "expanded terminal was not padded");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const resizeFooter = frames.slice(after).find((frame) => frame.includes("ask susan to do something"));
        assert.ok(resizeFooter?.includes("/tmp/project"));
        assert.equal(resizeFooter.endsWith("\n"), false);
      }
    } finally {
      app.unmount();
      if (previousHome === undefined) delete process.env.SUSAN_HOME;
      else process.env.SUSAN_HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  });
}
