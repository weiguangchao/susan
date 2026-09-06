import { describe, expect, it } from "vitest";
import {
  TOOL_RESULT_OUTPUT_BUDGET_BYTES,
  boundToolFailure,
  boundToolResult,
  normalizeToolResult,
} from "../src/index.js";

describe("Canonical Tool Result", () => {
  it("normalizes JSON-safe success and failure envelopes without leaking invalid values", () => {
    expect(
      normalizeToolResult({
        ok: true,
        result: { content: "done", count: 1 },
        meta: {
          truncation: {
            reasons: ["bytes", "line-length"],
            strategy: "head",
            fields: ["content"],
            retained: { bytes: 6, lines: 1 },
            total: { bytes: 9, lines: 1 },
            nextArguments: { path: "a.txt", offset: 2 },
          },
        },
      }),
    ).toEqual({
      ok: true,
      result: { content: "done", count: 1 },
      meta: {
        truncation: {
          reasons: ["bytes", "line-length"],
          strategy: "head",
          fields: ["content"],
          retained: { bytes: 6, lines: 1 },
          total: { bytes: 9, lines: 1 },
          nextArguments: { path: "a.txt", offset: 2 },
        },
      },
    });

    expect(
      normalizeToolResult({
        ok: false,
        error: {
          code: "ENOENT",
          message: "File does not exist.",
          details: { path: "/missing" },
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "ENOENT",
        message: "File does not exist.",
        details: { path: "/missing" },
      },
    });

    expect(normalizeToolResult({ ok: true, result: ["not an object"] })).toEqual({
      ok: false,
      error: { code: "ETOOL", message: "Tool returned an invalid result." },
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(normalizeToolResult({ ok: true, result: cyclic })).toEqual({
      ok: false,
      error: { code: "ETOOL", message: "Tool returned an invalid result." },
    });
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("secret proxy trap");
        },
      },
    );
    expect(normalizeToolResult({ ok: true, result: hostile })).toEqual({
      ok: false,
      error: { code: "ETOOL", message: "Tool returned an invalid result." },
    });
    expect(
      JSON.stringify(
        normalizeToolResult({
          ok: false,
          error: {
            code: "ETOOL",
            message: "safe",
            details: { secret: BigInt(1) },
            stack: "do not leak",
          },
        }),
      ),
    ).not.toContain("secret");
    expect(
      normalizeToolResult({
        ok: false,
        error: {
          code: "ETOOL",
          message: "unsafe",
          details: { nested: { stack: "secret stack" } },
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "ETOOL", message: "Tool returned an invalid result." },
    });
    expect(
      normalizeToolResult({
        ok: true,
        result: { content: "x".repeat(60_000) },
      }),
    ).toEqual({
      ok: false,
      error: { code: "ETOOL", message: "Tool returned an invalid result." },
    });
  });

  it("uses UTF-8 JSON bytes and deterministic global record order across fields", () => {
    const bounded = boundToolResult({
      result: { exitCode: 0 },
      fields: [
        { name: "stdout", kind: "text" },
        { name: "stderr", kind: "text" },
      ],
      records: [
        { field: "stdout", value: "你" },
        { field: "stderr", value: "err" },
        { field: "stdout", value: "好" },
      ],
      strategy: "head",
      limits: { bytes: 10 },
      includeTotal: ["bytes"],
    });

    expect(bounded).toEqual({
      ok: true,
      result: { exitCode: 0, stdout: "你", stderr: "err" },
      meta: {
        truncation: {
          reasons: ["bytes"],
          strategy: "head",
          fields: ["stdout"],
          retained: { bytes: 10 },
          total: { bytes: 13 },
        },
      },
    });
    expect(Buffer.byteLength(JSON.stringify("你")) + Buffer.byteLength(JSON.stringify("err"))).toBe(10);
    expect(TOOL_RESULT_OUTPUT_BUDGET_BYTES).toBe(51_200);
  });

  it("preserves complete atomic items and combines canonical truncation reasons", () => {
    const bounded = boundToolResult({
      result: { query: "needle" },
      fields: [{ name: "matches", kind: "items" }],
      records: [
        { field: "matches", value: { path: "a", line: 1 }, items: 1 },
        { field: "matches", value: { path: "b", line: 2 }, items: 1 },
        { field: "matches", value: { path: "c", line: 3 }, items: 1 },
      ],
      strategy: "head",
      limits: { bytes: 44, items: 2 },
      includeTotal: ["bytes", "items"],
      continuation({ firstOmittedRecordIndex }) {
        return firstOmittedRecordIndex === undefined
          ? undefined
          : { query: "needle", offset: firstOmittedRecordIndex };
      },
    });

    expect(bounded).toEqual({
      ok: true,
      result: { query: "needle", matches: [{ path: "a", line: 1 }] },
      meta: {
        truncation: {
          reasons: ["bytes", "items"],
          strategy: "head",
          fields: ["matches"],
          retained: { bytes: 23, items: 1 },
          total: { bytes: 67, items: 3 },
          nextArguments: { query: "needle", offset: 1 },
        },
      },
    });
  });

  it("returns a natural empty collection when one atomic item cannot fit", () => {
    expect(
      boundToolResult({
        result: { path: "/root" },
        fields: [{ name: "entries", kind: "items" }],
        records: [{ field: "entries", value: "oversized", items: 1 }],
        strategy: "head",
        limits: { bytes: 5 },
        includeTotal: ["bytes", "items"],
      }),
    ).toEqual({
      ok: true,
      result: { path: "/root", entries: [] },
      meta: {
        truncation: {
          reasons: ["bytes"],
          strategy: "head",
          fields: ["entries"],
          retained: { bytes: 2, items: 0 },
          total: { bytes: 13, items: 1 },
        },
      },
    });
  });

  it("keeps a bounded tail in original order and never invents continuation", () => {
    const bounded = boundToolFailure({
      error: {
        code: "ETOOL",
        message: "Command exited unsuccessfully.",
        details: { exitCode: 1 },
      },
      fields: [{ name: "stderr", kind: "text" }],
      records: [
        { field: "stderr", value: "old\n", lines: 1 },
        { field: "stderr", value: "middle\n", lines: 1 },
        { field: "stderr", value: "latest\n", lines: 1 },
      ],
      strategy: "tail",
      limits: { bytes: 18 },
      includeTotal: ["bytes", "lines"],
    });

    expect(bounded).toEqual({
      ok: false,
      error: {
        code: "ETOOL",
        message: "Command exited unsuccessfully.",
        details: { exitCode: 1, stderr: "middle\nlatest\n" },
      },
      meta: {
        truncation: {
          reasons: ["bytes"],
          strategy: "tail",
          fields: ["stderr"],
          retained: { bytes: 18, lines: 2 },
          total: { bytes: 23, lines: 3 },
        },
      },
    });
  });

  it("clips an allowed oversized text record at a Unicode boundary", () => {
    const bounded = boundToolResult({
      result: { path: "a.txt" },
      fields: [{ name: "content", kind: "text", truncateOversizedRecords: true }],
      records: [{ field: "content", value: "甲乙丙", lines: 1 }],
      strategy: "head",
      limits: { bytes: 8 },
      includeTotal: ["bytes", "lines"],
      continuation: () => ({ path: "a.txt", offset: 2 }),
    });

    expect(bounded).toEqual({
      ok: true,
      result: { path: "a.txt", content: "甲乙" },
      meta: {
        truncation: {
          reasons: ["bytes", "line-length"],
          strategy: "head",
          fields: ["content"],
          retained: { bytes: 8, lines: 1 },
          total: { bytes: 11, lines: 1 },
        },
      },
    });
    expect(JSON.parse(JSON.stringify(bounded))).toEqual(bounded);
  });

  it("omits an individually valid atom instead of clipping it into remaining space", () => {
    expect(
      boundToolResult({
        result: {},
        fields: [
          { name: "content", kind: "text", truncateOversizedRecords: true },
        ],
        records: [
          { field: "content", value: "1234" },
          { field: "content", value: "5678" },
        ],
        strategy: "head",
        limits: { bytes: 8 },
      }),
    ).toEqual({
      ok: true,
      result: { content: "1234" },
      meta: {
        truncation: {
          reasons: ["bytes"],
          strategy: "head",
          fields: ["content"],
          retained: { bytes: 6 },
        },
      },
    });
  });

  it("does not charge bounded fixed fields to the output budget", () => {
    const bounded = boundToolResult({
      result: { path: `/${"p".repeat(6_000)}` },
      fields: [{ name: "content", kind: "text" }],
      records: [
        {
          field: "content",
          value: "x".repeat(TOOL_RESULT_OUTPUT_BUDGET_BYTES - 2),
        },
      ],
      strategy: "head",
    });

    expect(bounded.ok).toBe(true);
    if (bounded.ok) {
      expect(bounded.meta).toBeUndefined();
      expect(Buffer.byteLength(JSON.stringify(bounded.result.content))).toBe(
        TOOL_RESULT_OUTPUT_BUDGET_BYTES,
      );
    }
  });

  it("does not let a caller raise the shared byte ceiling", () => {
    const bounded = boundToolResult({
      result: {},
      fields: [
        { name: "content", kind: "text", truncateOversizedRecords: true },
      ],
      records: [{ field: "content", value: "x".repeat(54_000) }],
      strategy: "head",
      limits: { bytes: 54_002 },
    });

    expect(bounded.ok).toBe(true);
    if (bounded.ok) {
      expect(Buffer.byteLength(JSON.stringify(bounded.result.content))).toBe(
        TOOL_RESULT_OUTPUT_BUDGET_BYTES,
      );
      expect(bounded.meta?.truncation?.reasons).toEqual([
        "bytes",
        "line-length",
      ]);
    }
  });

  it("reports a caller-clipped atomic line without offering false continuation", () => {
    expect(
      boundToolResult({
        result: { path: "a.txt" },
        fields: [{ name: "content", kind: "text" }],
        records: [
          {
            field: "content",
            value: "already clipped",
            lines: 1,
            truncatedBy: "line-length",
          },
        ],
        strategy: "head",
        continuation: () => ({ path: "a.txt", offset: 2 }),
      }),
    ).toEqual({
      ok: true,
      result: { path: "a.txt", content: "already clipped" },
      meta: {
        truncation: {
          reasons: ["line-length"],
          strategy: "head",
          fields: ["content"],
          retained: { bytes: 17, lines: 1 },
        },
      },
    });
  });

  it("keeps natural empty output values without truncation prose or metadata", () => {
    expect(
      boundToolResult({
        result: { path: "/empty" },
        fields: [
          { name: "content", kind: "text" },
          { name: "entries", kind: "items" },
        ],
        records: [],
        strategy: "head",
      }),
    ).toEqual({
      ok: true,
      result: { path: "/empty", content: "", entries: [] },
    });
  });

  it("rejects unbounded fixed fields and continuation arguments", () => {
    expect(() =>
      boundToolResult({
        result: { path: "x".repeat(8_000) },
        fields: [{ name: "content", kind: "text" }],
        records: [],
        strategy: "head",
      }),
    ).toThrow("fixed fields exceed");

    expect(() =>
      boundToolResult({
        result: { path: "a.txt" },
        fields: [{ name: "content", kind: "text" }],
        records: [
          { field: "content", value: "first\n", lines: 1 },
          { field: "content", value: "second\n", lines: 1 },
        ],
        strategy: "head",
        limits: { lines: 1 },
        continuation: () => ({ path: "x".repeat(8_000) }),
      }),
    ).toThrow("Continuation arguments exceed");

    expect(() =>
      boundToolResult({
        result: { path: "x".repeat(6_000) },
        fields: [{ name: "content", kind: "text" }],
        records: [
          { field: "content", value: "first\n", lines: 1 },
          { field: "content", value: "second\n", lines: 1 },
        ],
        strategy: "head",
        limits: { lines: 1 },
        continuation: () => ({ path: "y".repeat(6_000) }),
      }),
    ).toThrow("fixed size limit");
  });

  it("rejects sensitive details through the canonical failure constructor", () => {
    expect(() =>
      boundToolFailure({
        error: {
          code: "ETOOL",
          message: "failed",
          details: { nested: { environment: "secret" } },
        },
        fields: [{ name: "stderr", kind: "text" }],
        records: [],
        strategy: "tail",
      }),
    ).toThrow("unsafe or unbounded");
  });
});
