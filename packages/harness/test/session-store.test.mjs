import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Agent, MockProvider, resolveSusanHome } from "../dist/index.js";

const provider = {
  id: "test",
  label: "test",
  stream() {
    return {
      async *[Symbol.asyncIterator]() {},
      async final() {
        return {
          content: [{ type: "text", text: "reply" }],
          stopReason: "end_turn",
          usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0 },
        };
      },
    };
  },
};

async function run(agent, prompt) {
  for await (const _event of agent.run(prompt)) { /* drain */ }
}

function inputHash(input) {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

describe("session persistence", () => {
  it("uses the Susan home environment override", () => {
    assert.equal(resolveSusanHome("../example"), path.resolve("../example"));
    assert.equal(resolveSusanHome(""), path.join(os.homedir(), ".susan"));
  });

  it("appends messages to a dated JSONL file and rotates after clear", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "susan-home-"));
    try {
      const agent = new Agent({
        root: home,
        provider,
        sessionHome: home,
      });
      await run(agent, "first");
      await run(agent, "second");

      const now = new Date();
      const directory = path.join(
        home, "session", String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, "0"),
      );
      let files = await fs.readdir(directory);
      assert.equal(files.length, 1);
      const firstName = files[0];
      assert.match(firstName, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{12}\.jsonl$/);
      assert.ok(firstName.endsWith(`-${inputHash("first")}.jsonl`));
      const first = (await fs.readFile(path.join(directory, firstName), "utf8"))
        .trim().split("\n").map(JSON.parse);
      assert.deepEqual(first.map((line) => line.type), ["session", "message", "message", "message", "message"]);
      assert.deepEqual(first.filter((line) => line.type === "message").map((line) => line.message.role),
        ["user", "assistant", "user", "assistant"]);
      assert.equal(first[2].usage.inputTokens, 2);
      assert.equal(first[0].root, home);

      agent.clearSession();
      await run(agent, "third");
      files = await fs.readdir(directory);
      assert.equal(files.length, 2);
      const other = files.find((file) => file !== firstName);
      assert.ok(other.endsWith(`-${inputHash("third")}.jsonl`));
      const second = (await fs.readFile(path.join(directory, other), "utf8"))
        .trim().split("\n").map(JSON.parse);
      assert.equal(second[1].message.content[0].text, "third");
      assert.equal(second.length, 3);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("keeps separate files for sessions with the same first input", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "susan-home-"));
    try {
      const first = new Agent({ root: home, provider, sessionHome: home });
      const second = new Agent({ root: home, provider, sessionHome: home });
      await Promise.all([run(first, "same input"), run(second, "same input")]);
      const now = new Date();
      const directory = path.join(home, "session", String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, "0"));
      const files = await fs.readdir(directory);
      assert.equal(files.length, 2);
      assert.ok(files.every((file) => file.endsWith(`-${inputHash("same input")}.jsonl`)));
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("records tool results and assistant turns in replay order", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "susan-home-"));
    try {
      const agent = new Agent({
        root: home,
        provider: new MockProvider(),
        sessionHome: home,
      });
      await run(agent, "hello");
      const now = new Date();
      const directory = path.join(home, "session", String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, "0"));
      const [filename] = await fs.readdir(directory);
      const records = (await fs.readFile(path.join(directory, filename), "utf8"))
        .trim().split("\n").map(JSON.parse).slice(1);
      assert.deepEqual(records.map((record) => record.message.role),
        ["user", "assistant", "user", "assistant"]);
      assert.equal(records[1].message.content.some((block) => block.type === "tool_use"), true);
      assert.equal(records[2].message.content[0].type, "tool_result");
      assert.deepEqual(records.map((record) => record.message), agent.session.snapshot());
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
