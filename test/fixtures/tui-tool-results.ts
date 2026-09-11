import type { ProviderToolCall, ToolResult } from "../../src/index.js";

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
    summary: "已读 1 行 · 19 B",
  },
  {
    call: {
      id: "write-1",
      name: "write",
      arguments: { path: "/outside/report.txt", content: "hello world\n" },
    },
    result: {
      content: [{ type: "text", text: "Successfully wrote to /outside/report.txt" }],
      details: {
        resolvedPath: "/outside/report.txt",
        realTargetPath: "/outside/report.txt",
        cwdRelation: "outside",
        operation: "overwritten",
        bytesWritten: 12,
        bom: false,
        lineEnding: "lf",
        detachedHardLinks: false,
      },
    },
    isError: false,
    summary: "overwritten · 12 B · outside cwd",
  },
  {
    call: {
      id: "edit-1",
      name: "edit",
      arguments: {
        path: "src/link.ts",
        edits: [{ oldText: "old", newText: "new", replaceAll: true }],
      },
    },
    result: {
      content: [{ type: "text", text: "Successfully replaced 1 block(s) in /workspace/src/real.ts." }],
      details: {
        resolvedPath: "/workspace/src/real.ts",
        realTargetPath: "/workspace/src/real.ts",
        cwdRelation: "inside",
        editsApplied: 1,
        replacementsApplied: 2,
        bytesWritten: 24,
        bom: false,
        lineEnding: "lf",
        detachedHardLinks: false,
        diff: "@@ -1 +1 @@\n-old\n+new",
        truncation: {
          truncatedBy: "bytes",
          fields: ["diff"],
        },
      },
    },
    isError: false,
    summary: "1 edit · 2 replacements · 24 B",
  },
  {
    call: {
      id: "bash-1",
      name: "bash",
      arguments: { command: "pnpm test", cwd: "." },
    },
    result: {
      content: [{ type: "text", text: "Command exited with a non-zero status." }],
      details: {
        resolvedPath: "/workspace",
        realTargetPath: "/workspace",
        cwdRelation: "inside",
        exitCode: 7,
        signal: null,
        stdout: "tests started\n",
        stderr: "one failure\n",
        termination: {
          scope: "process-group",
          forced: false,
          cleanupConfirmed: true,
        },
        truncation: {
          truncatedBy: "bytes",
          fields: ["stdout", "stderr"],
        },
      },
    },
    isError: true,
    summary: "exit 7 · Command exited with a non-zero status.",
  },
  {
    call: {
      id: "grep-1",
      name: "grep",
      arguments: { pattern: "needle", path: "src" },
    },
    result: {
      content: [{ type: "text", text: "a.ts:1:needle\nb.ts:2:needle" }],
      details: {
        resolvedPath: "/workspace/src",
        realTargetPath: "/workspace/src",
        cwdRelation: "inside",
        matches: [
          { path: "a.ts", line: 1, text: "needle", before: [], after: [] },
          { path: "b.ts", line: 2, text: "needle", before: [], after: [] },
        ],
        diagnostics: [],
        truncation: {
          truncatedBy: ["items", "line-length"],
          outputItems: 2,
          nextOffset: 2,
        },
      },
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
      content: [{ type: "text", text: "No files found" }],
      details: {
        resolvedPath: "/workspace",
        realTargetPath: "/workspace",
        cwdRelation: "inside",
        entries: [],
        diagnostics: [],
      },
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
      details: {
        resolvedPath: "/workspace/src",
        realTargetPath: "/workspace/src",
        cwdRelation: "inside",
        entries: [
          { name: "index.ts", type: "file" },
          { name: "ui", type: "directory" },
        ],
        diagnostics: [],
      },
    },
    isError: false,
    summary: "2 entries",
  },
] as const satisfies readonly CanonicalToolFixture[];
