import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  Agent,
  buildSystemPrompt,
  grepTool,
  loadSkills,
  lsTool,
  readTool,
  writeTool,
} from "../dist/index.js";

let tmp;
let skillsDir;
let root;

async function writeSkill(name, frontmatter) {
  await fs.mkdir(path.join(skillsDir, name), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir, name, "SKILL.md"),
    `---\n${frontmatter}\n---\n\nBody of ${name}.\n`,
  );
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "susan-skills-"));
  skillsDir = path.join(tmp, "skills");
  root = path.join(tmp, "project");
  await fs.mkdir(root);
  await writeSkill("tdd", "name: tdd\ndescription: Test-driven development.");
  await writeSkill(
    "code-review",
    'name: code-review\ndescription: "Review \\"since X\\" changes."\nmetadata:\n  author: someone',
  );
  await writeSkill("folded", "name: folded\ndescription: >\n  First line\n  second line.");
  await writeSkill("renamed", "name: other-name\ndescription: Named by its directory.");
  await writeSkill("manual", "name: manual\ndescription: User only.\ndisable-model-invocation: true");
  await fs.mkdir(path.join(skillsDir, "no-skill-file"));
  await fs.writeFile(path.join(tmp, "secret.txt"), "nope");
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("skills", () => {
  it("loads model-invocable skills sorted and named by directory", () => {
    assert.deepEqual(loadSkills(skillsDir), [
      { name: "code-review", description: 'Review "since X" changes.' },
      { name: "folded", description: "First line second line." },
      { name: "renamed", description: "Named by its directory." },
      { name: "tdd", description: "Test-driven development." },
    ]);
    assert.deepEqual(loadSkills(path.join(tmp, "missing")), []);
  });

  it("puts the skill path pattern and index in the system prompt", () => {
    const system = buildSystemPrompt({
      root,
      skills: { dir: skillsDir, list: loadSkills(skillsDir) },
    });
    assert.ok(system.includes(`lives at ${path.join(skillsDir, "<name>", "SKILL.md")}`));
    assert.match(system, /^- tdd: Test-driven development\.$/m);
    assert.ok(!system.includes("- manual:"));
    assert.ok(!buildSystemPrompt({ root }).includes("# Skills"));
  });

  it("lets read-only tools open the skills dir but nothing else outside the root", async () => {
    const ctx = { root, readOnlyRoots: [skillsDir], signal: new AbortController().signal };
    const run = (tool, input) => tool.run(tool.parse(input), ctx);
    const manual = path.join(skillsDir, "manual", "SKILL.md");

    const skill = await run(readTool, { path: manual });
    assert.equal(skill.ok, true);
    assert.match(skill.content, /Body of manual\./);

    const listed = await run(lsTool, { path: skillsDir });
    assert.equal(listed.ok, true, listed.content);
    assert.match(listed.content, new RegExp(`^${path.join(skillsDir, "manual")}/$`, "m"));

    const found = await run(grepTool, { pattern: "Body of manual", path: skillsDir });
    assert.equal(found.ok, true, found.content);
    assert.ok(found.content.startsWith(`${manual}:7:`), found.content);

    const written = await run(writeTool, { path: manual, content: "changed" });
    assert.equal(written.ok, false);
    assert.match(written.content, /escapes the project root/);

    for (const [tool, input] of [
      [readTool, { path: path.join(tmp, "secret.txt") }],
      [lsTool, { path: tmp }],
      [grepTool, { pattern: "nope", path: tmp }],
    ]) {
      const outside = await run(tool, input);
      assert.equal(outside.ok, false, tool.name);
      assert.match(outside.content, /escapes the project root/);
    }
  });

  it("wires skillsDir through the agent", async () => {
    const skillFile = path.join(skillsDir, "tdd", "SKILL.md");
    const systems = [];
    const provider = {
      id: "stub",
      label: "stub",
      stream({ system, messages }) {
        systems.push(system);
        const content =
          messages.length === 1
            ? [{ type: "tool_use", id: "t1", name: "read", input: { path: skillFile } }]
            : [{ type: "text", text: "done" }];
        const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 };
        return {
          async *[Symbol.asyncIterator]() {},
          final: async () => ({
            content,
            stopReason: messages.length === 1 ? "tool_use" : "end_turn",
            usage,
          }),
        };
      },
    };
    const agent = new Agent({ root, provider, skillsDir });
    const results = [];
    for await (const event of agent.run("use tdd")) {
      if (event.type === "tool_result") results.push(event);
    }
    assert.match(systems[0], /# Skills/);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true, results[0].display);
  });
});
