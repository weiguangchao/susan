import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Skill } from "./skills.js";

export interface PromptContext {
  root: string;
  skills?: { dir: string; list: Skill[] };
}

/**
 * The system prompt is the cacheable prefix of every request, so it holds only
 * stable facts - nothing per-turn, nothing with a timestamp in it. Tools are
 * described by their API definitions, not repeated here.
 */
export function buildSystemPrompt({ root, skills }: PromptContext): string {
  let projectInstructions = "";
  try {
    projectInstructions = readFileSync(path.join(root, "AGENTS.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const skillsBlock = skills?.list.length
    ? `\n\n${skillsSection(skills.dir, skills.list)}`
    : "";

  return `You are susan, a coding agent working in one project through tools.

# Environment
Project root: ${root}
Platform: ${os.platform()} (${os.arch()})

# How to work
- Prefer edit over write for existing files.
- Batch independent tool calls in one turn. read, ls and grep run in parallel;
  write, edit and bash run one at a time, in the order given.
- Verify your work when a cheap check exists: the build, the tests, or the
  script you just wrote.

# Responding
- Answer in the language the user writes in.
- Keep it short. Skip preamble and skip recapping what the transcript shows.
- When you change files, say what changed and where, as \`path:line\` when a
  specific line matters.
- If tests fail or you skipped a step, say so. Never claim something works
  when you have not checked it.${skillsBlock}${projectInstructions.trim() ? `\n\n# Project instructions (AGENTS.md)\n${projectInstructions}` : ""}`;
}

function skillsSection(dir: string, list: Skill[]): string {
  const entries = list
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");
  return `# Skills
Every skill lives at ${path.join(dir, "<name>", "SKILL.md")}, listed below or not.
When a request matches a listed skill, or the user or the project instructions
name a skill, read that file before acting and follow it. Do not search for it.
Relative paths inside a skill resolve against its directory.

${entries}`;
}
