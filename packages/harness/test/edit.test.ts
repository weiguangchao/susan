import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
  link,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "diff";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createEditTool, type EditTool } from "../src/core/edit";
import { createWriteTool } from "../src/core/write";

let cwd: string;
let tool: EditTool;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "susan-edit-"));
  tool = createEditTool({ sessionCwd: cwd });
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
async function seed(text: string) {
  await writeFile(join(cwd, "file.txt"), text);
}
const edit = (oldText: string, newText: string) => ({ oldText, newText });
const run = (edits: unknown) => tool.execute({ path: "file.txt", edits });
const read = () => readFile(join(cwd, "file.txt"), "utf8");

describe("Pi edit contract", () => {
  it("matches the original and applies disjoint edits in source order with a usable patch", async () => {
    await seed("alpha\nbeta\ngamma\n");
    const result = await run([
      edit("gamma", "alpha"),
      edit("alpha", "longer\nvalue"),
    ]);
    expect(await read()).toBe("longer\nvalue\nbeta\nalpha\n");
    expect(result.content).toEqual([
      { type: "text", text: "Successfully replaced 2 block(s) in file.txt." },
    ]);
    expect(Object.keys(result.details!).sort()).toEqual([
      "diff",
      "firstChangedLine",
      "patch",
    ]);
    expect(result.details?.firstChangedLine).toBe(1);
    expect(applyPatch("alpha\nbeta\ngamma\n", result.details!.patch)).toBe(
      await read(),
    );
  });
  it.each(["array JSON", "object JSON", "object", "legacy", "mixed"])(
    "accepts %s input",
    async (shape) => {
      await seed("alpha\nbeta\n");
      const entry = edit("alpha", "new");
      const input =
        shape === "legacy"
          ? { ...entry }
          : shape === "mixed"
            ? { edits: [entry], ...edit("beta", "next") }
            : {
                edits:
                  shape === "object"
                    ? entry
                    : JSON.stringify(shape === "array JSON" ? [entry] : entry),
              };
      await tool.execute({ path: "file.txt", ...input });
      expect(await read()).toBe(
        shape === "mixed" ? "new\nnext\n" : "new\nbeta\n",
      );
    },
  );
  it.each([
    ["“hello”—Ａ\u00a0world   \n", '"hello"-A world\n'],
    ["cafe\u0301\n", "café\n"],
  ])(
    "normalizes fuzzy matches but preserves untouched lines",
    async (source, needle) => {
      await seed("untouched ‘quotes’   \n" + source + "tail\t\n");
      await run([edit(needle, "changed\n")]);
      expect(await read()).toBe("untouched ‘quotes’   \nchanged\ntail\t\n");
    },
  );
  it("checks uniqueness in fuzzy space even when an exact match exists", async () => {
    await seed('"hello"\n“hello”\n');
    await expect(run([edit('"hello"', "new")])).rejects.toThrow(
      "Found 2 occurrences",
    );
    expect(await read()).toBe('"hello"\n“hello”\n');
  });
  it.each([
    [[edit("alpha", "new"), edit("missing", "x")], "Could not find edits[1]"],
    [[edit("alpha", "x"), edit("pha", "y")], "edits[0] and edits[1] overlap"],
    [[edit("", "x")], "oldText must not be empty"],
    [[edit("alpha", "alpha")], "No changes made"],
    [[edit("alpha", "beta"), edit("beta", "x")], "Could not find edits[1]"],
  ])("validates the entire batch before writing", async (edits, message) => {
    await seed("alpha\n");
    await expect(run(edits)).rejects.toThrow(message);
    expect(await read()).toBe("alpha\n");
  });
  it("preserves BOM and CRLF and normalizes lone CR input", async () => {
    await seed("\uFEFFalpha\r\nbeta\r\n");
    await run([edit("alpha\nbeta", "one\rtwo")]);
    expect(await read()).toBe("\uFEFFone\r\ntwo\r\n");
  });
  it("preserves Pi first-newline policy for mixed endings", async () => {
    await seed("alpha\nbeta\r\n");
    await run([edit("alpha", "new")]);
    expect(await read()).toBe("new\nbeta\n");
  });
  it("supports deletion and newline-only changes in unified patches", async () => {
    for (const [before, after] of [
      ["only\n", ""],
      ["only", "only\n"],
    ]) {
      await seed(before);
      const result = await run([edit(before, after)]);
      expect(await read()).toBe(after);
      expect(applyPatch(before, result.details!.patch)).toBe(after);
    }
  });
  it("uses four context lines for distant hunks", async () => {
    const original =
      Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    await seed(original);
    const result = await run([
      edit("line 5\n", "five\n"),
      edit("line 24\n", "last\n"),
    ]);
    expect(result.details!.patch).toContain("@@ -2,9 +2,9 @@");
    expect(result.details!.patch).toContain("@@ -21,9 +21,9 @@");
    expect(result.details!.firstChangedLine).toBe(6);
  });
  it("follows symlinks and retains hardlink identity", async () => {
    await seed("alpha\n");
    const original = await stat(join(cwd, "file.txt"));
    await symlink(join(cwd, "file.txt"), join(cwd, "alias"));
    await link(join(cwd, "file.txt"), join(cwd, "hard"));
    await tool.execute({ path: "alias", edits: [edit("alpha", "new")] });
    expect(await readFile(join(cwd, "hard"), "utf8")).toBe("new\n");
    expect((await stat(join(cwd, "file.txt"))).ino).toBe(original.ino);
  });
  it("serializes read-modify-write calls including symlink aliases and write", async () => {
    await seed("alpha\n");
    await symlink(join(cwd, "file.txt"), join(cwd, "alias"));
    const writer = createWriteTool({ sessionCwd: cwd });
    await Promise.all([
      writer.execute({ path: "file.txt", content: "first\n" }),
      tool.execute({ path: "alias", edits: [edit("first", "second")] }),
      run([edit("second", "third")]),
    ]);
    expect(await read()).toBe("third\n");
  });
  it("has no edit-count or content-size limits", async () => {
    const lines = Array.from({ length: 101 }, (_, i) => `item-${i};`);
    await seed(lines.join("\n"));
    await run(lines.map((line) => edit(line, line + "x")));
    expect(await read()).toBe(lines.map((line) => line + "x").join("\n"));
    const large = "x".repeat(10 * 1024 * 1024 + 1);
    await seed("alpha\n" + large);
    await run([edit("alpha", "beta")]);
    expect(await read()).toBe("beta\n" + large);
  });
  it("omits replaceAll from schema and never replaces duplicates with it", async () => {
    expect(JSON.stringify(tool.parameters)).not.toContain("replaceAll");
    await seed("a a");
    await expect(
      run([{ ...edit("a", "b"), replaceAll: true }]),
    ).rejects.toThrow("Found 2 occurrences");
  });
  it("rejects malformed inputs and reports missing files with Pi text", async () => {
    for (const input of [
      null,
      {},
      { path: "file.txt", edits: "invalid JSON" },
      { path: "file.txt", edits: [] },
      { path: "file.txt", edits: [null] },
    ])
      await expect(tool.execute(input)).rejects.toThrow();
    await expect(run([edit("a", "b")])).rejects.toThrow(
      "Could not edit file: file.txt. Error code: ENOENT.",
    );
  });
  it("aborts before IO without mutating content", async () => {
    await seed("alpha");
    await expect(
      tool.execute(
        { path: "file.txt", edits: [edit("alpha", "beta")] },
        AbortSignal.abort(),
      ),
    ).rejects.toThrow("Operation aborted");
    expect(await read()).toBe("alpha");
  });
});

it("holds the mutation queue until an aborted in-flight write settles", async () => {
  await seed("alpha");
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let releaseWrite!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const controller = new AbortController();
  const delayed = createEditTool({
    sessionCwd: cwd,
    operations: {
      access: async () => {},
      readFile,
      writeFile: async (path, content) => {
        markEntered();
        await release;
        await writeFile(path, content);
      },
    },
  });
  const first = delayed.execute(
    { path: "file.txt", edits: [edit("alpha", "beta")] },
    controller.signal,
  );
  const rejected = expect(first).rejects.toThrow("Operation aborted");
  await entered;
  controller.abort();
  const second = run([edit("beta", "gamma")]);
  releaseWrite();
  await rejected;
  await second;
  expect(await read()).toBe("gamma");
});
