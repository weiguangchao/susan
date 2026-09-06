import type { ProviderToolCall, ToolResult } from "../../src/index.js";

export type CanonicalToolFixture = {
  readonly call: ProviderToolCall;
  readonly result: ToolResult;
  readonly summary: string;
};

const insidePath = {
  resolvedPath: "/workspace/src/link.ts",
  realTargetPath: "/workspace/src/index.ts",
  cwdRelation: "inside",
} as const;

export const canonicalToolFixtures = [
  {
    call: {
      id: "read-1",
      name: "read",
      arguments: { path: "src/link.ts", offset: 1, limit: 2000 },
    },
    result: {
      ok: true,
      result: {
        ...insidePath,
        content: "export const x = 1;",
        range: { startLine: 1, endLine: 1 },
        totalLines: 1,
        sizeBytes: 19,
        bom: false,
        lineEnding: "none",
      },
    },
    summary: "已读 1 行 · 19 B",
  },
  {
    call: {
      id: "write-1",
      name: "write",
      arguments: { path: "/outside/report.txt", content: "hello world\n" },
    },
    result: {
      ok: true,
      result: {
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
      ok: true,
      result: {
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
      },
      meta: {
        truncation: {
          reasons: ["bytes"],
          strategy: "head",
          fields: ["diff"],
          retained: { bytes: 24, lines: 3 },
          total: { bytes: 96, lines: 12 },
        },
      },
    },
    summary: "1 edit · 2 replacements · 24 B",
  },
  {
    call: {
      id: "bash-1",
      name: "bash",
      arguments: { command: "pnpm test", cwd: "." },
    },
    result: {
      ok: false,
      error: {
        code: "EEXIT",
        message: "Command exited with a non-zero status.",
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
        },
      },
      meta: {
        truncation: {
          reasons: ["bytes"],
          strategy: "tail",
          fields: ["stdout", "stderr"],
          retained: { bytes: 28 },
        },
      },
    },
    summary: "exit 7 · EEXIT · Command exited with a non-zero status.",
  },
  {
    call: {
      id: "grep-1",
      name: "grep",
      arguments: { pattern: "needle", path: "src" },
    },
    result: {
      ok: true,
      result: {
        resolvedPath: "/workspace/src",
        realTargetPath: "/workspace/src",
        cwdRelation: "inside",
        matches: [
          { path: "a.ts", line: 1, text: "needle", before: [], after: [] },
          { path: "b.ts", line: 2, text: "needle", before: [], after: [] },
        ],
        diagnostics: [],
      },
      meta: {
        truncation: {
          reasons: ["items", "line-length"],
          strategy: "head",
          fields: ["matches"],
          retained: { bytes: 128, items: 2 },
          total: { items: 6 },
          nextArguments: {
            pattern: "needle",
            path: "src",
            offset: 2,
          },
        },
      },
    },
    summary: "2 matches",
  },
  {
    call: {
      id: "find-1",
      name: "find",
      arguments: { pattern: "**/*.ts", path: "." },
    },
    result: {
      ok: true,
      result: {
        resolvedPath: "/workspace",
        realTargetPath: "/workspace",
        cwdRelation: "inside",
        entries: [],
        diagnostics: [],
      },
    },
    summary: "0 entries",
  },
  {
    call: {
      id: "ls-1",
      name: "ls",
      arguments: { path: "src" },
    },
    result: {
      ok: true,
      result: {
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
    summary: "2 entries",
  },
] as const satisfies readonly CanonicalToolFixture[];
