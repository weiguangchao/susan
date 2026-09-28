import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  Agent,
  buildSystemPrompt,
  loadSkills,
  readTool,
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
  await writeSkill("manual", "name: manual\ndescription: User only.\ndisable-model-invocation: true");
  await fs.mkdir(path.join(skillsDir, "no-skill-file"));
  await fs.writeFile(path.join(tmp, "secret.txt"), "nope");
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("skills", () => {
  it("loads model-invocable skills sorted by name", () => {
    assert.deepEqual(loadSkills(skillsDir), [
      {
        name: "code-review",
        description: 'Review "since X" changes.',
        file: path.join(skillsDir, "code-review", "SKILL.md"),
      },
      {
        name: "folded",
        description: "First line second line.",
        file: path.join(skillsDir, "folded", "SKILL.md"),
      },
      {
        name: "tdd",
        description: "Test-driven development.",
        file: path.join(skillsDir, "tdd", "SKILL.md"),
      },
    ]);
    assert.deepEqual(loadSkills(path.join(tmp, "missing")), []);
  });

  it("puts the skills directory and index in the system prompt", () => {
    const system = buildSystemPrompt({
      root,
      tools: [],
      skills: { dir: skillsDir, list: loadSkills(skillsDir) },
    });
    assert.match(system, new RegExp(`Skills are loaded from ${skillsDir}\\.`));
    assert.ok(
      system.includes(
        `- tdd: Test-driven development. (file: ${path.join(skillsDir, "tdd", "SKILL.md")})`,
      ),
    );
    assert.ok(!system.includes("- manual:"));
    assert.ok(!buildSystemPrompt({ root, tools: [] }).includes("# Skills"));
  });

  it("lets read open skill files but nothing else outside the root", async () => {
    const ctx = { root, readOnlyRoots: [skillsDir], signal: new AbortController().signal };
    const skill = await readTool.run(
      readTool.parse({ path: path.join(skillsDir, "manual", "SKILL.md") }),
      ctx,
    );
    assert.equal(skill.ok, true);
    assert.match(skill.content, /Body of manual\./);

    const outside = await readTool.run(
      readTool.parse({ path: path.join(tmp, "secret.txt") }),
      ctx,
    );
    assert.equal(outside.ok, false);
    assert.match(outside.content, /escapes the project root/);
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
