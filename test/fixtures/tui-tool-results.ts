import type { ProviderToolCall, ToolResult } from "../../src/index";

export type CanonicalToolFixture = {
  readonly call: ProviderToolCall;
  readonly result: ToolResult;
  readonly isError: boolean;
  readonly summary: string;
};

export const canonicalToolFixtures = [
  {
    call: {
      id: "read-1",
      name: "read",
      arguments: { path: "src/link.ts", offset: 1, limit: 2000 },
    },
    result: {
      content: [{ type: "text", text: "export const x = 1;" }],
    },
    isError: false,
    summary: "L1 · 1 行 · 19 B",
  },
  {
    call: {
      id: "write-1",
      name: "write",
      arguments: { path: "/outside/report.txt", content: "hello world\n" },
    },
    result: {
      content: [{ type: "text", text: "Successfully wrote to /outside/report.txt" }],
    },
    isError: false,
    summary: "Successfully wrote to /outside/report.txt",
  },
  {
    call: {
      id: "edit-1",
      name: "edit",
      arguments: {
        path: "src/link.ts",
        edits: [{ oldText: "old", newText: "new" }],
      },
    },
    result: {
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/link.ts." }],
      details: {
        diff: "-1 old\n+1 new",
        patch: "--- src/link.ts\n+++ src/link.ts\n@@ -1 +1 @@\n-old\n+new\n",
        firstChangedLine: 1,
      },
    },
    isError: false,
    summary: "Successfully replaced 1 block(s) in src/link.ts.",
  },
  {
    call: {
      id: "bash-1",
      name: "bash",
      arguments: { command: "pnpm test" },
    },
    result: {
      content: [{
        type: "text",
        text: "tests started\nfile a\nfile b\none failure\n\nCommand exited with code 7",
      }],
    },
    isError: true,
    summary: "Command exited with code 7",
  },
  {
    call: {
      id: "grep-1",
      name: "grep",
      arguments: { pattern: "needle", path: "src" },
    },
    result: {
      content: [{ type: "text", text: "a.ts:1: needle\nb.ts:2: needle" }],
    },
    isError: false,
    summary: "2 matches",
  },
  {
    call: {
      id: "find-1",
      name: "find",
      arguments: { pattern: "**/*.ts", path: "." },
    },
    result: {
      content: [{ type: "text", text: "No files found matching pattern" }],
    },
    isError: false,
    summary: "0 entries",
  },
  {
    call: {
      id: "ls-1",
      name: "ls",
      arguments: { path: "src" },
    },
    result: {
      content: [{ type: "text", text: "index.ts\nui/" }],
    },
    isError: false,
    summary: "2 entries",
  },
] as const satisfies readonly CanonicalToolFixture[];
