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
  createBuiltInToolSet,
} from "../src/index";

const CONTRIBUTIONS = {
  read: {
    snippet: READ_PROMPT_SNIPPET,
    guidelines: READ_PROMPT_GUIDELINES,
    description:
      "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
  },
  write: {
    snippet: WRITE_PROMPT_SNIPPET,
    guidelines: WRITE_PROMPT_GUIDELINES,
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  },
  edit: {
    snippet: EDIT_PROMPT_SNIPPET,
    guidelines: EDIT_PROMPT_GUIDELINES,
    description:
      "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
  },
  bash: {
    snippet: BASH_PROMPT_SNIPPET,
    guidelines: BASH_PROMPT_GUIDELINES,
    description:
      "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
  },
  grep: {
    snippet: GREP_PROMPT_SNIPPET,
    guidelines: GREP_PROMPT_GUIDELINES,
    description:
      "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.",
  },
  find: {
    snippet: FIND_PROMPT_SNIPPET,
    guidelines: FIND_PROMPT_GUIDELINES,
    description:
      "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).",
  },
  ls: {
    snippet: LS_PROMPT_SNIPPET,
    guidelines: LS_PROMPT_GUIDELINES,
    description:
      "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
  },
} as const;

describe("Built-in Tool Set", () => {
  it("exposes exactly the seven model-side names in a stable order", () => {
    expect(
      createBuiltInToolSet({ sessionCwd: "/workspace" }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls"]);
  });

  it("registers no alias for a model-side name", () => {
    const names = createBuiltInToolSet({ sessionCwd: "/workspace" }).map(
      (tool) => tool.name,
    );

    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("read_file");
  });

  it("locks description, promptSnippet, and promptGuidelines to the contribution constants", () => {
    for (const tool of createBuiltInToolSet({ sessionCwd: "/workspace" })) {
      const contribution = CONTRIBUTIONS[tool.name as keyof typeof CONTRIBUTIONS];
      expect(tool.description).toBe(contribution.description);
      expect(tool.promptSnippet).toBe(contribution.snippet);
      expect(tool.promptGuidelines).toEqual([...contribution.guidelines]);
    }
  });
});
