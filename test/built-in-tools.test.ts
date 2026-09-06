import { describe, expect, it } from "vitest";
import { createBuiltInToolSet } from "../src/index.js";

const CANONICAL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  read: "Read a known UTF-8 regular file, optionally from a 1-based line offset with a line limit. Use read instead of bash or cat when inspecting file contents. It reports file and path facts together with the confirmed content. Large results may be truncated; use nextArguments only when the omitted content is relevant. It does not list directories or read binary and special files.",
  write:
    "Create or completely replace a UTF-8 regular file, creating missing parent directories when needed. Use write for new files or intentional whole-file replacement; use edit for precise changes to an existing file. Content is written exactly, without implicit append, newline, or permission changes. The operation rejects a final symlink and reports whether it created or overwrote the target.",
  edit: "Apply one batch of exact text replacements to an existing UTF-8 regular file. Use edit instead of shell text-processing commands when the existing text to change is known. Replacements are validated against the original content before one commit; matching is not fuzzy, each match must be unique by default, and replaceAll must be requested explicitly. The result includes a bounded unified diff.",
  bash: "Run one non-interactive, non-login Bash command as a one-shot process. Use bash for program execution, builds, tests, real Bash semantics, or work the dedicated Tools cannot express; do not use it as a substitute for read, write, edit, grep, find, or ls merely because a shell command is familiar. It supports an execution cwd, timeout, and environment overlay, but no PTY, persistent session, background-process contract, or later stdin. The command runs with Susan's process permissions, and bash.cwd does not restrict paths accessed by the command.",
  grep: "Search logical lines in one UTF-8 regular file or recursively beneath a directory. Use grep instead of bash or a host grep command when looking for file content. It supports ECMAScript Unicode regex or literal matching, optional context, a platform-independent file glob, depth and ignore controls, and deterministic pagination. Results may include Traversal Diagnostics; their presence means the traversal was not completely error-free.",
  find: "Find descendant path names beneath a directory using a platform-independent glob. Use find instead of bash or a host find command when locating files, directories, or symlinks by name or relative path; use grep when searching file contents. It supports type, depth, ignore controls, and deterministic pagination. It does not match the Search Root itself or traverse through symlinks, and results may include Traversal Diagnostics.",
  ls: "List a directory's direct children without recursion. Use ls to inspect a known directory and find for deeper path discovery. It returns deterministically ordered file, directory, and symlink entries, applies ignore rules unless requested otherwise, and does not follow symlinks. Results may include Traversal Diagnostics.",
};

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

  it("uses the canonical description for every Tool", () => {
    for (const tool of createBuiltInToolSet({ sessionCwd: "/workspace" })) {
      expect(tool.description).toBe(CANONICAL_DESCRIPTIONS[tool.name]);
    }
  });
});
