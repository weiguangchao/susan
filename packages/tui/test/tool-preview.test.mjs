import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { deferred, startApp, waitForFrame, usage } from "./app-fixture.mjs";

function scripted(batches) {
  const pending = deferred();
  const answer = deferred();
  const requests = [];
  return {
    pending, answer, requests,
    id: "test", label: "test-model",
    stream(request) {
      const batch = batches[requests.length];
      requests.push(request);
      return {
        async *[Symbol.asyncIterator]() {
          if (batch) {
            for (const call of batch) yield { type: "tool_use_start", ...call };
            await pending.promise;
          } else {
            yield { type: "text_delta", text: "Finished." };
            await answer.promise;
          }
        },
        async final() {
          return { content: batch?.map(call => ({ type: "tool_use", ...call })) ??
            [{ type: "text", text: "Finished." }], stopReason: batch ? "tool_use" : "end_turn", usage };
        },
      };
    },
  };
}

const call = (id, name, input) => ({ id, name, input });

test("partial read appears only when complete, keeps source numbers and canonical content", async () => {
  const provider = scripted([[call("read1", "read", { path: "sample.txt", offset: 3, limit: 7 })]]);
  const app = await startApp(provider, "inspect", { setup: home =>
    writeFile(path.join(home, "sample.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten") });
  try {
    const waiting = app.frames.at(-1);
    assert.match(waiting, /Working/);
    assert.doesNotMatch(waiting, /preparing|read|sample.txt/);
    provider.pending.release();
    const complete = await waitForFrame(app.frames, /Finished\./);
    assert.match(complete, /read sample.txt:L3-9 ✔/);
    assert.match(complete, /3 three\n\s*4 four\n\s*5 five\n\s*6 six\n\s*7 seven/);
    assert.match(complete, /… 2L · Total 7L/);
    assert.doesNotMatch(complete, /8 eight/);
    const results = provider.requests[1].messages.at(-1).content;
    assert.deepEqual(results, [{ type: "tool_result", toolUseId: "read1", isError: false,
      content: "3\tthree\n4\tfour\n5\tfive\n6\tsix\n7\tseven\n8\teight\n9\tnine\n\n... [1 more lines]" }]);
    provider.answer.release();
    const done = await waitForFrame(app.frames, /ask susan to do something/);
    assert.match(done, /read sample.txt:L3-9 ✔/);
    assert.doesNotMatch(done, /Working/);
  } finally {
    provider.pending.release(); provider.answer.release(); await app.stop();
  }
});

test("write and edit preview the captured file contents across consecutive turns", async () => {
  const provider = scripted([
    [call("w", "write", { path: "created.txt", content: "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta" })],
    [call("e", "edit", { path: "created.txt", old_string: "zeta", new_string: "changed\ninserted" })],
  ]);
  const app = await startApp(provider, "change");
  try {
    provider.pending.release();
    const frame = await waitForFrame(app.frames, /Finished\./);
    assert.match(frame, /write created.txt.*✔\n1 alpha\n2 beta\n3 gamma\n4 delta\n5 epsilon\n… 3L · Total 8L/);
    assert.match(frame, /edit created.txt ✔\n4 delta\n5 epsilon\n6 changed\n7 inserted\n8 eta\n… 4L · Total 9L/);
    assert.equal(provider.requests[1].messages.at(-1).content[0].content, "Created created.txt (8 lines, 45 bytes).");
    assert.equal(provider.requests[2].messages.at(-1).content[0].content, "Replaced 1 occurrence in created.txt.");
    assert.ok(frame.indexOf("write created.txt") < frame.indexOf("edit created.txt"));
  } finally {
    provider.pending.release(); provider.answer.release(); await app.stop();
  }
});

test("batched ls, grep and bash keep call order and compact unnumbered output", async () => {
  const provider = scripted([[
    call("b", "bash", { command: "sleep 0.1; printf 'out-one\\nout-two\\n'; printf 'err-one\\n' >&2" }),
    call("l", "ls", { path: "files" }),
    call("g", "grep", { path: "files", pattern: "match" }),
  ]]);
  const app = await startApp(provider, "inspect", { setup: async home => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(home, "files"));
    await writeFile(path.join(home, "files", "a.txt"), "match A\nmatch B");
  } });
  try {
    provider.pending.release();
    const frame = await waitForFrame(app.frames, /Finished\./);
    assert.match(frame, /✔\nout-one\nout-two\n\[stderr\]\nerr-one/);
    assert.match(frame, /ls files ✔\nfiles\/a.txt \(15 bytes\)/);
    assert.match(frame, /grep \/match\/ in files ✔\nfiles\/a.txt: match A\nfiles\/a.txt: match B/);
    assert.doesNotMatch(frame, /Total/);
    assert.ok(frame.indexOf("bash sleep") < frame.indexOf("ls files"));
    assert.ok(frame.indexOf("ls files") < frame.indexOf("grep /match/"));
    assert.deepEqual(provider.requests[1].messages.at(-1).content, [
      { type: "tool_result", toolUseId: "b", isError: false, content: "out-one\nout-two\n[stderr]\nerr-one" },
      { type: "tool_result", toolUseId: "l", isError: false, content: "files/a.txt (15 bytes)" },
      { type: "tool_result", toolUseId: "g", isError: false, content: "files/a.txt:1: match A\nfiles/a.txt:2: match B" },
    ]);
  } finally {
    provider.pending.release(); provider.answer.release(); await app.stop();
  }
});

test("empty outcomes and rejected file calls remain readable without gutters or totals", async () => {
  const provider = scripted([[
    call("r", "read", { path: "empty.txt" }),
    call("w", "write", { path: "new.txt", content: "" }),
    call("e", "edit", { path: "erase.txt", old_string: "erase", new_string: "" }),
    call("l", "ls", { path: "empty" }),
    call("g", "grep", { path: "empty", pattern: "absent" }),
    call("b", "bash", { command: "true" }),
    call("f", "read", { path: "missing.txt" }),
    call("bad", "write", { path: "bad.txt" }),
    call("unknown", "unknown", {}),
  ]]);
  const app = await startApp(provider, "inspect", { setup: async home => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(home, "empty"));
    await writeFile(path.join(home, "empty.txt"), "");
    await writeFile(path.join(home, "erase.txt"), "erase");
  } });
  try {
    provider.pending.release();
    const frame = await waitForFrame(app.frames, /Finished\./);
    assert.match(frame, /read empty.txt ✔\n\(file is empty\)/);
    assert.match(frame, /write new.txt \(0 lines\) ✔\n\(file is empty\)/);
    assert.match(frame, /edit erase.txt ✔\n\(file is empty\)/);
    assert.match(frame, /ls empty ✔\n\(empty directory\)/);
    assert.match(frame, /grep \/absent\/ in empty ✔\nNo matches/);
    assert.match(frame, /bash true ✔\n\(no output\)/);
    assert.match(frame, /read missing.txt ✖\nError: file not found: missing.txt/);
    assert.match(frame, /invalid input for write/);
    assert.match(frame, /unknown ✖\nunknown tool: unknown/);
    assert.doesNotMatch(frame, /Total|\n\s*\d+ /);
  } finally {
    provider.pending.release(); provider.answer.release(); await app.stop();
  }
});

test("a running command stays invisible until interruption freezes a failure in scrollback", async () => {
  const provider = scripted([[call("slow", "bash", { command: "touch started; sleep 30" })]]);
  const app = await startApp(provider, "inspect");
  try {
    provider.pending.release();
    const { access } = await import("node:fs/promises");
    for (let i = 0; ; i++) {
      if (await access(path.join(app.home, "started")).then(() => true, () => false)) break;
      assert.ok(i < 100, "command did not start");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.doesNotMatch(app.frames.at(-1), /bash|touch started|preparing/);
    app.stdin.write("\x1b");
    const frame = await waitForFrame(app.frames, /ask susan to do something/);
    assert.match(frame, /bash touch started; sleep 30 ✖\nnot finished/);
    assert.match(frame, /interrupted/);
    assert.doesNotMatch(frame, /Working|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  } finally {
    provider.pending.release(); provider.answer.release(); await app.stop();
  }
});

test("capped command output counts retained logical lines and preserves its cap notice", async () => {
  const provider = scripted([[call("big", "bash", { command: "printf '%s\\n' {1..10000}" })]]);
  const app = await startApp(provider, "inspect");
  try {
    provider.pending.release();
    const frame = await waitForFrame(app.frames, /Finished\./);
    assert.match(frame, /✔\n1\n2\n3\n4\n5\n… 9995L · Total 10000L/);
    assert.match(frame, /tool output truncated at 30000 characters/);
    assert.match(provider.requests[1].messages.at(-1).content[0].content, /truncated \d+ characters/);
  } finally {
    provider.pending.release(); provider.answer.release(); await app.stop();
  }
});

test("long source lines wrap, stay bounded and reflow with the completed transcript", async () => {
  const provider = scripted([[call("long", "read", { path: "long.txt" })]]);
  const app = await startApp(provider, "inspect", { columns: 40, setup: home =>
    writeFile(path.join(home, "long.txt"), "word ".repeat(1000)) });
  try {
    provider.pending.release();
    const frame = await waitForFrame(app.frames, /Finished\./);
    assert.match(frame, /read long.txt:L1-1 ✔/);
    assert.match(frame, /1 word word/);
    assert.match(frame, /long preview lines clipped/);
    assert.doesNotMatch(frame, /Total/);
    for (const line of frame.slice(frame.indexOf("› inspect")).split("\n")) assert.ok(line.length <= 40, `overwide row: ${line}`);
    assert.ok(frame.length < 5000, "the preview does not retain an entire long source line");
    assert.equal(provider.requests[1].messages.at(-1).content[0].content.length, 5002);
    provider.answer.release();
    await waitForFrame(app.frames, /ask susan to do something/);
    const before = app.output.length;
    app.stdout.columns = 80;
    app.stdout.emit("resize");
    for (let i = 0; !app.output.slice(before).join("").includes("read long.txt:L1-1 ✔"); i++) {
      assert.ok(i < 100); await new Promise(resolve => setTimeout(resolve, 10));
    }
    const resized = app.output.slice(before).findLast(frame => frame.includes("read long.txt:L1-1 ✔"));
    assert.match(resized, /read long.txt:L1-1 ✔/);
    assert.equal(resized.split("read long.txt:L1-1 ✔").length - 1, 1);
    assert.match(resized, /ask susan to do something/);
    for (const line of resized.split("\n")) assert.ok(line.length <= 80, JSON.stringify(line));
  } finally {
    provider.pending.release(); provider.answer.release(); await app.stop();
  }
});

test("capped search displays the tool cap separately from its five match preview", async () => {
  const provider = scripted([[call("cap", "grep", { pattern: "needle", include: "many.txt" })]]);
  const app = await startApp(provider, "inspect", { setup: home =>
    writeFile(path.join(home, "many.txt"), "needle\n".repeat(210)) });
  try {
    provider.pending.release();
    const frame = await waitForFrame(app.frames, /Finished\./);
    assert.equal((frame.match(/many.txt: needle/g) ?? []).length, 5);
    assert.match(frame, /… 195L · Total 200L\n... \[capped at 200 matches\]/);
    assert.doesNotMatch(frame, /Total 210L|many.txt:1:/);
    assert.match(provider.requests[1].messages.at(-1).content[0].content, /many.txt:200: needle/);
  } finally {
    provider.pending.release(); provider.answer.release(); await app.stop();
  }
});

test("edit preview centers on the actual change inside a contextual replacement", async () => {
  const context = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
  const provider = scripted([[call("context", "edit", {
    path: "context.txt", old_string: context + "old", new_string: context + "new",
  })]]);
  const app = await startApp(provider, "change", { setup: home =>
    writeFile(path.join(home, "context.txt"), context + "old\nk\nl\nm\nn") });
  try {
    provider.pending.release();
    const frame = await waitForFrame(app.frames, /Finished\./);
    assert.match(frame, /edit context.txt ✔\n 9 i\n10 j\n11 new\n12 k\n13 l/);
    assert.match(frame, /… 10L · Total 15L/);
  } finally {
    provider.pending.release(); provider.answer.release(); await app.stop();
  }
});
