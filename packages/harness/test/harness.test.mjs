import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  Agent,
  AnthropicProvider,
  MockProvider,
  OpenAIProvider,
  builtinTools,
  toolByName,
} from "../dist/index.js";
import { startFakeAnthropic } from "./fakes/anthropic.mjs";
import { startFakeOpenAI } from "./fakes/openai.mjs";

/** Drains a run and returns the events, plus a few things worth asserting on. */
async function collect(agent, prompt) {
  const events = [];
  for await (const event of agent.run(prompt)) events.push(event);
  return {
    events,
    types: events.map((e) => e.type),
    text: events
      .filter((e) => e.type === "text_end")
      .map((e) => e.text)
      .join(""),
    tools: events.filter((e) => e.type === "tool_result"),
    done: events.find((e) => e.type === "done")?.reason,
    notices: events.filter((e) => e.type === "notice"),
  };
}

let root;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "susan-test-"));
  await fs.writeFile(path.join(root, "notes.txt"), "alpha\nbeta\nTODO: x\n");
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeAgent(provider, mode = "auto", onPermissionRequest = async () => "allow") {
  return new Agent({ root, provider, permissionMode: mode, onPermissionRequest });
}

describe("anthropic provider", () => {
  let fake;

  before(async () => {
    fake = await startFakeAnthropic();
  });
  after(async () => fake.close());

  const provider = () =>
    new AnthropicProvider({ model: "claude-fake", baseURL: fake.url });

  it("runs a tool call and comes back with an answer", async () => {
    const run = await collect(makeAgent(provider()), "what is in this directory");
    assert.equal(run.done, "end_turn");
    assert.equal(run.tools.length, 1);
    assert.equal(run.tools[0].name, "ls");
    assert.ok(run.tools[0].ok);
    assert.match(run.text, /Read the results above/);
  });

  it("sends the request shape the harness promises", async () => {
    fake.log.length = 0;
    await collect(makeAgent(provider()), "what is in this directory");
    const first = fake.log[0];
    assert.equal(first.url, "/v1/messages");
    assert.deepEqual(first.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(first.output_config, { effort: "high" });
    assert.deepEqual(first.cache_control, { type: "ephemeral" });
    // The tool list is part of the cached prefix: frozen order, every tool
    // streaming its input eagerly.
    assert.deepEqual(
      first.tools.map((t) => t.name),
      ["read", "write", "edit", "ls", "grep", "bash"],
    );
    assert.ok(first.tools.every((t) => t.eager));
  });

  it("replays the thinking block with its signature intact", async () => {
    fake.log.length = 0;
    await collect(makeAgent(provider()), "what is in this directory");
    const assistant = fake.log[1].messages.find((m) => m.role === "assistant");
    assert.deepEqual(assistant.blocks, [
      "thinking(sig=SiGnAtUrE-abc123)",
      "text",
      "tool_use",
    ]);
  });

  it("assembles a tool input that arrived in fragments", async () => {
    const run = await collect(makeAgent(provider()), "what is in this directory");
    // The fake streams {"pa / th": ".", / "depth": 1} across three deltas.
    assert.match(run.tools[0].display, /entr/);
  });

  it("returns every tool result in a single user message", async () => {
    fake.log.length = 0;
    const run = await collect(makeAgent(provider()), "parallel check");
    assert.equal(run.tools.length, 2);
    const userMessages = fake.log[1].messages.filter((m) => m.role === "user");
    const resultMessages = userMessages.filter((m) =>
      m.blocks.some((b) => b.startsWith("tool_result")),
    );
    assert.equal(resultMessages.length, 1, "results must not be split up");
    assert.deepEqual(resultMessages[0].blocks, [
      "tool_result(toolu_1)",
      "tool_result(toolu_2)",
    ]);
  });

  it("never runs a tool from a refused turn", async () => {
    const run = await collect(makeAgent(provider()), "refusal please");
    assert.equal(run.done, "refusal");
    assert.equal(run.tools.length, 0);
  });

  it("stops instead of running a tool truncated at max_tokens", async () => {
    const run = await collect(makeAgent(provider()), "truncate this");
    assert.equal(run.done, "error");
    assert.equal(run.tools.length, 0);
    await assert.rejects(fs.stat(path.join(root, "x.txt")));
  });

  it("resumes a paused turn", async () => {
    const run = await collect(makeAgent(provider()), "paused work");
    assert.equal(run.done, "end_turn");
    assert.match(run.text, /Resumed and done/);
  });

  it("accumulates usage across turns", async () => {
    const agent = makeAgent(provider());
    await collect(agent, "what is in this directory");
    const usage = agent.session.usage;
    assert.equal(usage.inputTokens, 2400);
    assert.equal(usage.outputTokens, 120);
    assert.equal(usage.cacheReadTokens, 1800);
  });
});

describe("openai-compatible provider", () => {
  let fake;

  before(async () => {
    fake = await startFakeOpenAI();
  });
  after(async () => fake.close());

  const provider = () =>
    new OpenAIProvider({ model: "fake-model", baseURL: fake.url, apiKey: "test" });

  it("assembles a tool call streamed in fragments", async () => {
    const run = await collect(makeAgent(provider()), "what is in this directory");
    assert.equal(run.done, "end_turn");
    assert.equal(run.tools[0].name, "ls");
    assert.ok(run.tools[0].ok);
    assert.match(run.text, /Found the listing above/);
  });

  it("sends one tool message per call, as the API requires", async () => {
    fake.log.length = 0;
    const run = await collect(makeAgent(provider()), "parallel check");
    assert.equal(run.tools.length, 2);
    assert.deepEqual(fake.log[1].roles, [
      "system",
      "user",
      "assistant+tool_calls(2)",
      "tool",
      "tool",
    ]);
  });

  it("turns unparseable tool arguments into an error result", async () => {
    const run = await collect(makeAgent(provider()), "broken args");
    assert.equal(run.tools.length, 1);
    assert.equal(run.tools[0].ok, false);
    // The raw string reaches the schema, which rejects it with a message the
    // model can act on - rather than the tool running on an empty object.
    const call = run.events.find((e) => e.type === "tool_call");
    assert.match(call.summary, /Expected object, received string/);
  });

  it("asks for usage on the stream", async () => {
    fake.log.length = 0;
    await collect(makeAgent(provider()), "what is in this directory");
    assert.deepEqual(fake.log[0].stream_options, { include_usage: true });
  });
});

describe("permission gate", () => {
  it("refuses write tools in readonly mode and tells the model why", async () => {
    const agent = makeAgent(new MockProvider(), "readonly");
    const run = await collect(agent, "create a file");
    assert.equal(run.tools[0].ok, false);
    const lastUser = agent.session.messages.at(-2);
    const result = lastUser.content.find((b) => b.type === "tool_result");
    assert.match(result.content, /read-only mode/);
    await assert.rejects(fs.stat(path.join(root, "susan-demo.txt")));
  });

  it("feeds a denial back as a tool result instead of dropping it", async () => {
    const agent = makeAgent(new MockProvider(), "ask", async () => "deny");
    const run = await collect(agent, "create a file");
    assert.equal(run.tools[0].ok, false);
    const lastUser = agent.session.messages.at(-2);
    const result = lastUser.content.find((b) => b.type === "tool_result");
    assert.match(result.content, /declined/);
  });

  it("runs the tool once approved", async () => {
    const agent = makeAgent(new MockProvider(), "ask", async () => "allow");
    const run = await collect(agent, "create a file");
    assert.ok(run.tools[0].ok);
    const written = await fs.readFile(path.join(root, "susan-demo.txt"), "utf8");
    assert.match(written, /permission gate/);
    await fs.rm(path.join(root, "susan-demo.txt"));
  });

  it("keeps a tool_result for every tool_use, whatever happened", async () => {
    const agent = makeAgent(new MockProvider(), "readonly");
    await collect(agent, "run a command");
    for (const message of agent.session.messages) {
      if (message.role !== "assistant") continue;
      const uses = message.content.filter((b) => b.type === "tool_use");
      if (uses.length === 0) continue;
      const index = agent.session.messages.indexOf(message);
      const next = agent.session.messages[index + 1];
      const results = next.content.filter((b) => b.type === "tool_result");
      assert.equal(results.length, uses.length);
    }
  });
});

describe("tool sandbox", () => {
  const ctx = () => ({ root, signal: new AbortController().signal });

  it("rejects paths that escape the project root", async () => {
    for (const [name, input] of [
      ["read", { path: "../../etc/passwd" }],
      ["write", { path: "/etc/evil.txt", content: "x" }],
      ["ls", { path: ".." }],
    ]) {
      const tool = toolByName(builtinTools, name);
      const result = await tool.run(tool.parse(input), ctx());
      assert.equal(result.ok, false, `${name} should refuse`);
      assert.match(result.content, /escapes the project root/);
    }
  });

  it("refuses commands that are catastrophic and never intentional", async () => {
    const bash = toolByName(builtinTools, "bash");
    const result = await bash.run(
      bash.parse({ command: "rm -rf / --no-preserve-root" }),
      ctx(),
    );
    assert.equal(result.ok, false);
    assert.match(result.content, /refused/);
  });

  it("kills the whole process tree when interrupted", async () => {
    const bash = toolByName(builtinTools, "bash");
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 300);
    const result = await bash.run(bash.parse({ command: "sleep 30" }), {
      root,
      signal: controller.signal,
    });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    // Killing only the shell would leave `sleep` holding the pipes and this
    // would not return for 30 seconds.
    assert.ok(elapsed < 5000, `took ${elapsed}ms - the child outlived the kill`);
  });

  it("edits only on an unambiguous match", async () => {
    const file = path.join(root, "edit-target.txt");
    await fs.writeFile(file, "one\ntwo\none\n");
    const edit = toolByName(builtinTools, "edit");

    const ambiguous = await edit.run(
      edit.parse({ path: "edit-target.txt", old_string: "one", new_string: "1" }),
      ctx(),
    );
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.content, /appears 2 times/);
    assert.equal(await fs.readFile(file, "utf8"), "one\ntwo\none\n");

    const all = await edit.run(
      edit.parse({
        path: "edit-target.txt",
        old_string: "one",
        new_string: "1",
        replace_all: true,
      }),
      ctx(),
    );
    assert.ok(all.ok);
    assert.equal(await fs.readFile(file, "utf8"), "1\ntwo\n1\n");
  });
});
