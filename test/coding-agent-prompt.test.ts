import { describe, expect, it } from "vitest";
import {
  BASH_PROMPT_GUIDELINES,
  BASH_PROMPT_SNIPPET,
  EDIT_PROMPT_GUIDELINES,
  EDIT_PROMPT_SNIPPET,
  FIND_PROMPT_GUIDELINES,
  FIND_PROMPT_SNIPPET,
  GREP_PROMPT_GUIDELINES,
  GREP_PROMPT_SNIPPET,
  LS_PROMPT_GUIDELINES,
  LS_PROMPT_SNIPPET,
  READ_PROMPT_GUIDELINES,
  READ_PROMPT_SNIPPET,
  WRITE_PROMPT_GUIDELINES,
  WRITE_PROMPT_SNIPPET,
  buildSystemPrompt,
  createBuiltInToolSet,
  type HarnessTool,
} from "../src/index.js";

const IDENTITY =
  "You are Susan, an expert coding agent operating inside a minimal personal Harness. You help users by reading files, executing commands, editing code, and writing new files.";

function tools(cwd = "/workspace"): readonly HarnessTool[] {
  return createBuiltInToolSet({ sessionCwd: cwd });
}

function prompt(
  cwd = "/workspace",
  toolList: readonly HarnessTool[] = tools(cwd),
): string {
  return buildSystemPrompt(toolList, cwd);
}

describe("Coding Agent System Prompt", () => {
  it("assembles identity, available tools, guidelines, and cwd in Pi order", () => {
    const assembled = prompt("/workspace/susan");
    const identityAt = assembled.indexOf(IDENTITY);
    const toolsAt = assembled.indexOf("\n\nAvailable tools:\n");
    const guidelinesAt = assembled.indexOf("\n\nGuidelines:\n");
    const cwdAt = assembled.indexOf(
      "\nCurrent working directory: /workspace/susan",
    );

    expect(identityAt).toBe(0);
    expect(toolsAt).toBeGreaterThan(identityAt);
    expect(guidelinesAt).toBeGreaterThan(toolsAt);
    expect(cwdAt).toBeGreaterThan(guidelinesAt);
    expect(assembled.endsWith("Current working directory: /workspace/susan")).toBe(
      true,
    );
  });

  it("lists Built-in Tool snippets in registration order", () => {
    expect(prompt()).toContain(`Available tools:
- read: ${READ_PROMPT_SNIPPET}
- write: ${WRITE_PROMPT_SNIPPET}
- edit: ${EDIT_PROMPT_SNIPPET}
- bash: ${BASH_PROMPT_SNIPPET}
- grep: ${GREP_PROMPT_SNIPPET}
- find: ${FIND_PROMPT_SNIPPET}
- ls: ${LS_PROMPT_SNIPPET}`);
  });

  it("collects tool guidelines then resident guidelines without duplicates", () => {
    expect(prompt()).toContain(`Guidelines:
- ${READ_PROMPT_GUIDELINES[0]}
- ${WRITE_PROMPT_GUIDELINES[0]}
- ${EDIT_PROMPT_GUIDELINES[0]}
- ${EDIT_PROMPT_GUIDELINES[1]}
- ${EDIT_PROMPT_GUIDELINES[2]}
- ${EDIT_PROMPT_GUIDELINES[3]}
- Be concise in your responses
- Show file paths clearly when working with files`);
    expect(BASH_PROMPT_GUIDELINES).toEqual([]);
    expect(GREP_PROMPT_GUIDELINES).toEqual([]);
    expect(FIND_PROMPT_GUIDELINES).toEqual([]);
    expect(LS_PROMPT_GUIDELINES).toEqual([]);

    const duplicate: HarnessTool = {
      name: "read",
      description: "dup",
      parameters: {},
      promptSnippet: READ_PROMPT_SNIPPET,
      promptGuidelines: [
        READ_PROMPT_GUIDELINES[0],
        "Be concise in your responses",
      ],
      execute: async () => ({ content: [{ type: "text", text: "" }] }),
    };
    const assembled = prompt("/workspace", [duplicate]);
    expect(assembled.match(/Be concise in your responses/g)).toHaveLength(1);
    expect(assembled.match(/Use read to examine files instead of cat or sed\./g)).toHaveLength(1);
  });

  it("shows (none) and resident guidelines when the tool list is empty", () => {
    expect(prompt("/workspace", [])).toBe(`${IDENTITY}

Available tools:
(none)

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
Current working directory: /workspace`);
  });

  it("keeps no read-only agent or approval-flow wording", () => {
    const assembled = prompt();
    expect(assembled).not.toMatch(/read_file/);
    expect(assembled).not.toMatch(/do not run commands/i);
    expect(assembled).not.toMatch(/ask for (approval|confirmation)/i);
    expect(assembled).not.toMatch(/awaiting approval/i);
  });

  it("does not restate fixed Harness limits as numbers", () => {
    expect(prompt("/workspace/susan")).not.toMatch(/\d/);
  });

  it("normalizes cwd backslashes and treats replacement-pattern characters as literal text", () => {
    const cwd = "C:\\tmp\\$&$'$`$1${x}";
    expect(prompt(cwd, [])).toContain(
      "Current working directory: C:/tmp/$&$'$`$1${x}",
    );
    expect(prompt("/tmp/{cwd}", [])).toContain(
      "Current working directory: /tmp/{cwd}",
    );
    expect(prompt("/tmp/{cwd}", []).split("{cwd}")).toHaveLength(2);
  });
});
