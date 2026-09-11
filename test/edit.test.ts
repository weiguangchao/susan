import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EDIT_MAX_CONTENT_BYTES,
  EDIT_MAX_EDITS,
  createEditTool,
  type EditTool,
} from "../src/index.js";

const POSIX = process.platform !== "win32";

describe("Edit Tool", () => {
  let sessionCwd: string;
  let tool: EditTool;

  const seed = async (name: string, content: string): Promise<string> => {
    const path = join(sessionCwd, name);
    await writeFile(path, content);
    return path;
  };

  beforeEach(async () => {
    sessionCwd = await mkdtemp(join(tmpdir(), "susan-edit-"));
    tool = createEditTool({ sessionCwd });
  });

  afterEach(async () => {
    await rm(sessionCwd, { force: true, recursive: true });
  });

  it("exposes a strict edit({ path, edits }) definition", () => {
    expect(tool).toMatchObject({
      name: "edit",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            minItems: 1,
            maxItems: EDIT_MAX_EDITS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                oldText: { type: "string", minLength: 1 },
                newText: { type: "string" },
                replaceAll: { type: "boolean" },
              },
              required: ["oldText", "newText"],
            },
          },
        },
        required: ["path", "edits"],
      },
    });
  });

  it("applies one unique replacement and returns a compact unified diff", async () => {
    const path = await seed("notes.txt", "line1\nline2\nline3\n");

    const result = await tool.execute({
      path,
      edits: [{ oldText: "line2", newText: "changed" }],
    });

    expect(result).toEqual({
      content: [{
        type: "text",
        text: `Successfully replaced 1 block(s) in ${path}.`,
      }],
      details: {
        resolvedPath: path,
        realTargetPath: await realpath(path),
        cwdRelation: "inside",
        editsApplied: 1,
        replacementsApplied: 1,
        bytesWritten: 20,
        bom: false,
        lineEnding: "lf",
        detachedHardLinks: false,
        diff: "@@ -1,3 +1,3 @@\n line1\n-line2\n+changed\n line3",
      },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("line1\nchanged\nline3\n");
  });

  it("evaluates every edit against the same original content", async () => {
    const path = await seed("cascade.txt", "a\nb\n");

    const result = await tool.execute({
      path,
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "b", newText: "c" },
      ],
    });

    expect(result).toMatchObject({
      details: {
        editsApplied: 2,
        replacementsApplied: 2,
        diff: "@@ -1,2 +1,2 @@\n-a\n-b\n+b\n+c",
      },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("b\nc\n");
  });

  it("replaces every non-overlapping match with replaceAll", async () => {
    const spaced = await seed("spaced.txt", "x x x\n");
    const packed = await seed("packed.txt", "aaaa");

    await expect(
      tool.execute({
        path: spaced,
        edits: [{ oldText: "x", newText: "y", replaceAll: true }],
      }),
    ).resolves.toMatchObject({
      details: {
        editsApplied: 1,
        replacementsApplied: 3,
        diff: "@@ -1 +1 @@\n-x x x\n+y y y",
      },
    });
    await expect(readFile(spaced, "utf8")).resolves.toBe("y y y\n");

    await expect(
      tool.execute({
        path: packed,
        edits: [{ oldText: "aa", newText: "b", replaceAll: true }],
      }),
    ).resolves.toMatchObject({
      details: { replacementsApplied: 2 },
    });
    await expect(readFile(packed, "utf8")).resolves.toBe("bb");
  });

  it("accepts the maximum batch of edits", async () => {
    const tokens = Array.from({ length: EDIT_MAX_EDITS }, (_, index) =>
      `t${String(index).padStart(3, "0")}`,
    );
    const path = await seed("batch.txt", `${tokens.join("\n")}\n`);

    const result = await tool.execute({
      path,
      edits: tokens.map((token) => ({
        oldText: token,
        newText: token.replace("t", "u"),
      })),
    });

    expect(result).toMatchObject({
      details: {
        editsApplied: EDIT_MAX_EDITS,
        replacementsApplied: EDIT_MAX_EDITS,
      },
    });
    await expect(readFile(path, "utf8")).resolves.toBe(
      `${tokens.map((token) => token.replace("t", "u")).join("\n")}\n`,
    );
  });

  it("matches across LF and CRLF and keeps unmodified regions byte-identical", async () => {
    const path = await seed("mixed.txt", "alpha\r\nbeta\r\ngamma\n");

    const result = await tool.execute({
      path,
      edits: [{ oldText: "alpha\nbeta", newText: "one\ntwo" }],
    });

    expect(result).toMatchObject({
      details: {
        bytesWritten: 16,
        lineEnding: "mixed",
        diff: "@@ -1,3 +1,3 @@\n-alpha\n-beta\n+one\n+two\n gamma",
      },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("one\r\ntwo\r\ngamma\n");
  });

  it("adds newlines in the dominant, matched-region, then LF format", async () => {
    const dominant = await seed("dominant.txt", "a\r\nb\r\nc\n");
    const tieCrlf = await seed("tie-crlf.txt", "a\r\nb\nc\r\nd\n");
    const tieLf = await seed("tie-lf.txt", "a\r\nb\nc\r\nd\n");
    const single = await seed("single.txt", "solo");

    await expect(
      tool.execute({ path: dominant, edits: [{ oldText: "c", newText: "x\ny" }] }),
    ).resolves.toMatchObject({ details: expect.anything() });
    await expect(readFile(dominant, "utf8")).resolves.toBe("a\r\nb\r\nx\r\ny\n");

    await expect(
      tool.execute({ path: tieCrlf, edits: [{ oldText: "a\nb", newText: "p\nq" }] }),
    ).resolves.toMatchObject({ details: expect.anything() });
    await expect(readFile(tieCrlf, "utf8")).resolves.toBe("p\r\nq\nc\r\nd\n");

    await expect(
      tool.execute({ path: tieLf, edits: [{ oldText: "b\nc", newText: "p\nq" }] }),
    ).resolves.toMatchObject({ details: expect.anything() });
    await expect(readFile(tieLf, "utf8")).resolves.toBe("a\r\np\nq\r\nd\n");

    await expect(
      tool.execute({ path: single, edits: [{ oldText: "solo", newText: "one\ntwo" }] }),
    ).resolves.toMatchObject({ details: { lineEnding: "lf" } });
    await expect(readFile(single, "utf8")).resolves.toBe("one\ntwo");
  });

  it("performs exact matching without normalization or fuzzy fallback", async () => {
    const path = await seed("exact.txt", "café “quoted” — dash\ttab\n");

    for (const oldText of [
      'café "quoted" — dash\ttab',
      "café “quoted” - dash\ttab",
      "café “quoted” — dash tab",
      "cafe\u0301 “quoted” — dash\ttab",
      " café “quoted” — dash\ttab",
    ]) {
      await expect(
        tool.execute({ path, edits: [{ oldText, newText: "replaced" }] }),
      ).rejects.toThrow("oldText does not appear in the file.");
    }
    await expect(readFile(path, "utf8")).resolves.toBe(
      "café “quoted” — dash\ttab\n",
    );
  });

  it("preserves an existing BOM and keeps it out of matching and diff", async () => {
    const path = await seed("bom.txt", "\uFEFFalpha\n");

    const result = await tool.execute({
      path,
      edits: [{ oldText: "alpha", newText: "beta" }],
    });

    expect(result).toMatchObject({
      details: {
        bom: true,
        bytesWritten: 8,
        diff: "@@ -1 +1 @@\n-alpha\n+beta",
      },
    });
    await expect(readFile(path)).resolves.toEqual(
      Buffer.from("\uFEFFbeta\n", "utf8"),
    );
  });

  it("marks a missing trailing newline in the diff", async () => {
    const path = await seed("open-ended.txt", "alpha\nbeta");

    const result = await tool.execute({
      path,
      edits: [{ oldText: "beta", newText: "beta\n" }],
    });

    expect(result).toMatchObject({
      details: {
        bytesWritten: 11,
        diff:
          "@@ -1,2 +1,2 @@\n alpha\n-beta\n\\ No newline at end of file\n+beta",
      },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("alpha\nbeta\n");
  });

  it("reports deletions as an empty new range", async () => {
    const path = await seed("deleted.txt", "only\n");

    const result = await tool.execute({
      path,
      edits: [{ oldText: "only\n", newText: "" }],
    });

    expect(result).toMatchObject({
      details: {
        bytesWritten: 0,
        lineEnding: "none",
        diff: "@@ -1 +0,0 @@\n-only",
      },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("");
  });

  it("emits one hunk per distant change and keeps three context lines", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line${index}`);
    const path = await seed("hunks.txt", `${lines.join("\n")}\n`);

    const result = await tool.execute({
      path,
      edits: [
        { oldText: "line4", newText: "first" },
        { oldText: "line15", newText: "second" },
      ],
    });

    expect(result).toMatchObject({
      details: {
        diff: [
          "@@ -2,7 +2,7 @@",
          " line1",
          " line2",
          " line3",
          "-line4",
          "+first",
          " line5",
          " line6",
          " line7",
          "@@ -13,7 +13,7 @@",
          " line12",
          " line13",
          " line14",
          "-line15",
          "+second",
          " line16",
          " line17",
          " line18",
        ].join("\n"),
      },
    });
  });

  it("keeps unchanged lines as context inside a shared hunk", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line${index}`);
    const path = await seed("shared-hunk.txt", `${lines.join("\n")}\n`);

    const result = await tool.execute({
      path,
      edits: [
        { oldText: "line4", newText: "first" },
        { oldText: "line9", newText: "second" },
      ],
    });

    expect(result).toMatchObject({
      details: {
        diff: [
          "@@ -2,12 +2,12 @@",
          " line1",
          " line2",
          " line3",
          "-line4",
          "+first",
          " line5",
          " line6",
          " line7",
          " line8",
          "-line9",
          "+second",
          " line10",
          " line11",
          " line12",
        ].join("\n"),
      },
    });
  });

  it("marks a missing trailing newline after trailing context", async () => {
    const path = await seed("tail-context.txt", "alpha\nbeta\ngamma");

    const result = await tool.execute({
      path,
      edits: [{ oldText: "alpha", newText: "ALPHA" }],
    });

    expect(result).toMatchObject({
      details: {
        diff:
          "@@ -1,3 +1,3 @@\n-alpha\n+ALPHA\n beta\n gamma\n\\ No newline at end of file",
      },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("ALPHA\nbeta\ngamma");
  });

  it("rejects invalid arguments with EINVAL and invalid edits with EINVAL_EDIT", async () => {
    const path = await seed("schema.txt", "alpha\n");
    const valid = [{ oldText: "alpha", newText: "beta" }];

    const invalidArguments = [
      [{ path, edits: valid, extra: true }, "extra"],
      [{ path, edits: valid, replaceAll: true }, "replaceAll"],
      [{ path: 1, edits: valid }, "path"],
      [{ path }, "edits"],
      [{ path, edits: {} }, "edits"],
      [null, "path"],
    ] as const;
    for (const [input] of invalidArguments) {
      await expect(tool.execute(input)).rejects.toThrow("Invalid edit arguments.");
    }

    const invalidEdits: readonly unknown[][] = [
      [],
      Array.from({ length: EDIT_MAX_EDITS + 1 }, () => valid[0]),
      [null],
      [{ oldText: "alpha", newText: "beta", extra: 1 }],
      [{ oldText: "", newText: "beta" }],
      [{ oldText: 1, newText: "beta" }],
      [{ oldText: "alpha" }],
      [{ oldText: "alpha", newText: 1 }],
      [{ oldText: "alpha", newText: "beta", replaceAll: "yes" }],
    ];
    for (const edits of invalidEdits) {
      await expect(tool.execute({ path, edits })).rejects.toThrow();
    }
    await expect(readFile(path, "utf8")).resolves.toBe("alpha\n");
  });

  it("reports the offending edit for match, overlap, and no-change failures", async () => {
    const path = await seed("failures.txt", "a a\n");
    const overlapping = await seed("overlap.txt", "abcd");

    await expect(
      tool.execute({ path, edits: [{ oldText: "zzz", newText: "y" }] }),
    ).rejects.toThrow("oldText does not appear in the file.");
    await expect(
      tool.execute({ path, edits: [{ oldText: "a", newText: "b" }] }),
    ).rejects.toThrow("oldText appears more than once.");
    await expect(
      tool.execute({
        path: overlapping,
        edits: [
          { oldText: "abc", newText: "x" },
          { oldText: "bcd", newText: "y" },
        ],
      }),
    ).rejects.toThrow("Two edits replace the same source text.");
    await expect(
      tool.execute({
        path,
        edits: [{ oldText: "a", newText: "a", replaceAll: true }],
      }),
    ).rejects.toThrow("The batch leaves the file unchanged.");
    await expect(readFile(path, "utf8")).resolves.toBe("a a\n");
    await expect(readFile(overlapping, "utf8")).resolves.toBe("abcd");
  });

  it("orders match, overlap, and no-change failures deterministically", async () => {
    const path = await seed("precedence.txt", "a a\n");

    await expect(
      tool.execute({
        path,
        edits: [
          { oldText: "zzz", newText: "y" },
          { oldText: "a", newText: "b" },
        ],
      }),
    ).rejects.toThrow("oldText does not appear in the file.");
    await expect(
      tool.execute({
        path,
        edits: [
          { oldText: "a", newText: "a", replaceAll: true },
          { oldText: "a a", newText: "a a" },
        ],
      }),
    ).rejects.toThrow("Two edits replace the same source text.");
  });

  it("uses stable schema, path, file type, size, and UTF-8 precedence", async () => {
    const directory = join(sessionCwd, "directory");
    await mkdir(directory);
    const binary = join(sessionCwd, "binary.bin");
    await writeFile(binary, Buffer.from([0x61, 0x00, 0x62]));
    const invalidUtf8 = join(sessionCwd, "invalid.bin");
    await writeFile(invalidUtf8, Buffer.from([0xff, 0xfe, 0x41]));
    const oversized = join(sessionCwd, "oversized.txt");
    await writeFile(oversized, "a".repeat(EDIT_MAX_CONTENT_BYTES + 1));
    const edits = [{ oldText: "a", newText: "b" }];

    await expect(
      tool.execute({ path: directory, edits: [{ oldText: "", newText: "b" }] }),
    ).rejects.toThrow("oldText must be a non-empty string.");
    await expect(
      tool.execute({ path: join(sessionCwd, "missing.txt"), edits }),
    ).rejects.toThrow("Path does not exist.");
    await expect(
      tool.execute({ path: directory, edits }),
    ).rejects.toThrow("Path is a directory.");
    await expect(
      tool.execute({ path: oversized, edits }),
    ).rejects.toThrow("File exceeds the 10 MiB size limit.");
    await expect(
      tool.execute({ path: binary, edits }),
    ).rejects.toThrow("File is not valid UTF-8 text.");
    await expect(
      tool.execute({ path: invalidUtf8, edits }),
    ).rejects.toThrow("File is not valid UTF-8 text.");
  });

  it("rejects newText that is not valid UTF-8 text", async () => {
    const path = await seed("binary-edit.txt", "alpha\n");

    for (const newText of ["be\0ta", "\uD800"]) {
      await expect(
        tool.execute({
          path,
          edits: [
            { oldText: "zzz", newText: "ignored" },
            { oldText: "alpha", newText },
          ],
        }),
      ).rejects.toThrow("newText must be valid UTF-8 text without NUL bytes.");
    }
    await expect(readFile(path, "utf8")).resolves.toBe("alpha\n");
  });

  it("rejects a result over the size limit without touching the target", async () => {
    const original = `x${"a".repeat(EDIT_MAX_CONTENT_BYTES - 1)}`;
    const path = await seed("grown.txt", original);

    await expect(
      tool.execute({
        path,
        edits: [{ oldText: "x", newText: "xy" }],
      }),
    ).rejects.toThrow("Edit result exceeds the 10 MiB size limit.");
    expect((await stat(path)).size).toBe(EDIT_MAX_CONTENT_BYTES);
  });

  it.skipIf(!POSIX)("rejects special-file targets", async () => {
    await expect(
      tool.execute({ path: "/dev/null", edits: [{ oldText: "a", newText: "b" }] }),
    ).rejects.toThrow("Path is not a regular file.");
  });

  it("rejects final symlinks, including dangling symlinks", async () => {
    const target = await seed("target.txt", "kept\n");
    const linked = join(sessionCwd, "linked.txt");
    const dangling = join(sessionCwd, "dangling.txt");
    await symlink(target, linked, POSIX ? undefined : "file");
    await symlink(
      join(sessionCwd, "missing.txt"),
      dangling,
      POSIX ? undefined : "file",
    );
    const edits = [{ oldText: "kept", newText: "changed" }];

    await expect(tool.execute({ path: linked, edits })).rejects.toThrow(
      "Final path component is a symlink.",
    );
    await expect(tool.execute({ path: dangling, edits })).rejects.toThrow(
      "Final path component is a symlink.",
    );
    await expect(readFile(target, "utf8")).resolves.toBe("kept\n");
    expect((await lstat(dangling)).isSymbolicLink()).toBe(true);
  });

  it("resolves relative paths against Session cwd", async () => {
    await mkdir(join(sessionCwd, "nested"));
    await writeFile(join(sessionCwd, "nested/notes.txt"), "old\n");
    const previous = process.cwd();
    const processCwd = await mkdtemp(join(tmpdir(), "susan-edit-process-"));
    try {
      process.chdir(processCwd);

      const result = await tool.execute({
        path: "nested/notes.txt",
        edits: [{ oldText: "old", newText: "new" }],
      });

      expect(result).toMatchObject({
        details: {
          resolvedPath: join(sessionCwd, "nested/notes.txt"),
          cwdRelation: "inside",
        },
      });
      await expect(
        readFile(join(sessionCwd, "nested/notes.txt"), "utf8"),
      ).resolves.toBe("new\n");
    } finally {
      process.chdir(previous);
      await rm(processCwd, { force: true, recursive: true });
    }
  });

  it("edits a target outside cwd through a parent symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-edit-outside-"));
    try {
      const linkedParent = join(sessionCwd, "linked");
      await symlink(outside, linkedParent, POSIX ? undefined : "junction");
      await writeFile(join(outside, "notes.txt"), "old\n");

      const result = await tool.execute({
        path: "linked/notes.txt",
        edits: [{ oldText: "old", newText: "new" }],
      });

      expect(result).toMatchObject({
        details: {
          resolvedPath: join(linkedParent, "notes.txt"),
          realTargetPath: join(await realpath(outside), "notes.txt"),
          cwdRelation: "outside",
        },
      });
      await expect(readFile(join(outside, "notes.txt"), "utf8")).resolves.toBe(
        "new\n",
      );
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it.skipIf(!POSIX)("preserves mode and detaches hard links", async () => {
    const path = join(sessionCwd, "script.sh");
    const otherPath = join(sessionCwd, "other.sh");
    await writeFile(path, "old\n", { mode: 0o755 });
    await chmod(path, 0o755);
    await link(path, otherPath);
    const before = await stat(path);

    const result = await tool.execute({
      path,
      edits: [{ oldText: "old", newText: "new" }],
    });

    expect(result).toMatchObject({
      details: { detachedHardLinks: true, bytesWritten: 4 },
    });
    expect((await stat(path)).mode & 0o777).toBe(0o755);
    expect((await stat(path)).ino).not.toBe(before.ino);
    expect((await stat(otherPath)).ino).toBe(before.ino);
    await expect(readFile(path, "utf8")).resolves.toBe("new\n");
    await expect(readFile(otherPath, "utf8")).resolves.toBe("old\n");
  });

  it("bounds the diff to the shared output budget", async () => {
    const lines = Array.from(
      { length: 1_200 },
      (_, index) => `old value ${String(index).padStart(4, "0")} ${"-".repeat(30)}`,
    );
    const path = await seed("large.txt", `${lines.join("\n")}\n`);

    const result = await tool.execute({
      path,
      edits: [{ oldText: "old value", newText: "new value", replaceAll: true }],
    });

    expect(result).toMatchObject({
      details: { editsApplied: 1, replacementsApplied: 1_200 },
    });
    expect(result.details?.diff.startsWith("@@ -1,")).toBe(true);
    await expect(readFile(path, "utf8")).resolves.toBe(
      `${lines.map((line) => line.replace("old value", "new value")).join("\n")}\n`,
    );
  });

  it("detects a target conflict before commit and leaves external content", async () => {
    const path = await seed("raced.txt", "original\n");
    tool = createEditTool({
      sessionCwd,
      replacementHooks: {
        afterFlush: async () => {
          await writeFile(path, "external content\n");
        },
      },
    });

    await expect(
      tool.execute({
        path,
        edits: [{ oldText: "original", newText: "replacement" }],
      }),
    ).rejects.toThrow("Target changed before commit.");
    await expect(readFile(path, "utf8")).resolves.toBe("external content\n");
  });

  it("cancels before commit without changing the target or leaving a temporary file", async () => {
    const path = await seed("cancelled.txt", "original\n");
    const controller = new AbortController();
    tool = createEditTool({
      sessionCwd,
      replacementHooks: {
        afterFlush: async () => {
          controller.abort();
        },
      },
    });

    await expect(
      tool.execute(
        { path, edits: [{ oldText: "original", newText: "replacement" }] },
        controller.signal,
      ),
    ).rejects.toThrow("File replacement was cancelled.");
    await expect(readFile(path, "utf8")).resolves.toBe("original\n");
    await expect(readdir(sessionCwd)).resolves.toEqual(["cancelled.txt"]);
  });

  it("times out before commit without changing the target", async () => {
    const path = await seed("timeout.txt", "original\n");
    tool = createEditTool({
      sessionCwd,
      timeoutMs: 250,
      replacementHooks: {
        afterFlush: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
        },
      },
    });

    await expect(
      tool.execute({
        path,
        edits: [{ oldText: "original", newText: "replacement" }],
      }),
    ).rejects.toThrow("File replacement timed out.");
    await expect(readFile(path, "utf8")).resolves.toBe("original\n");
  });

  it("reports success when cancellation arrives after the replace commit", async () => {
    const path = await seed("committed.txt", "original\n");
    const controller = new AbortController();
    tool = createEditTool({
      sessionCwd,
      replacementHooks: {
        afterReplace: async () => {
          controller.abort();
        },
      },
    });

    const result = await tool.execute(
      { path, edits: [{ oldText: "original", newText: "committed" }] },
      controller.signal,
    );

    expect(result).toMatchObject({
      details: { editsApplied: 1, replacementsApplied: 1, bytesWritten: 10 },
    });
    await expect(readFile(path, "utf8")).resolves.toBe("committed\n");
  });

  it("preserves the primary error and reports temporary residue", async () => {
    const path = await seed("residue.txt", "original\n");
    let temporaryPath: string | undefined;
    tool = createEditTool({
      sessionCwd,
      replacementHooks: {
        afterFlush: async () => {
          await writeFile(path, "external content\n");
        },
        unlinkTemporary: async (pathToRemove) => {
          temporaryPath = pathToRemove;
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
      },
    });

    await expect(
      tool.execute({
        path,
        edits: [{ oldText: "original", newText: "replacement" }],
      }),
    ).rejects.toThrow("Target changed before commit.");
    await expect(readFile(path, "utf8")).resolves.toBe("external content\n");
    await expect(readFile(temporaryPath!, "utf8")).resolves.toBe("replacement\n");
  });
});
