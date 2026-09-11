import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileMutationQueue } from "../src/core/file-mutation-queue.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "susan-file-mutation-queue-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) =>
      rm(dir, { recursive: true, force: true })
    ),
  );
});

describe("withFileMutationQueue", () => {
  it("serializes operations for the same file", async () => {
    const order: string[] = [];
    const path = join(tmpdir(), "susan-file-mutation-queue-same");

    const first = withFileMutationQueue(path, async () => {
      order.push("first:start");
      await delay(30);
      order.push("first:end");
    });
    const second = withFileMutationQueue(path, async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await Promise.all([first, second]);
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("allows different files to proceed in parallel", async () => {
    const order: string[] = [];

    await Promise.all([
      withFileMutationQueue(join(tmpdir(), "susan-file-mutation-queue-a"), async () => {
        order.push("a:start");
        await delay(30);
        order.push("a:end");
      }),
      withFileMutationQueue(join(tmpdir(), "susan-file-mutation-queue-b"), async () => {
        order.push("b:start");
        await delay(30);
        order.push("b:end");
      }),
    ]);

    expect(order.indexOf("a:start")).toBeLessThan(order.indexOf("a:end"));
    expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("b:end"));
    expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("a:end"));
  });

  it("uses the same queue for symlink aliases", async () => {
    const dir = await createTempDir();
    const targetPath = join(dir, "target.txt");
    const symlinkPath = join(dir, "alias.txt");
    await writeFile(targetPath, "hello\n", "utf8");
    await symlink(
      targetPath,
      symlinkPath,
      process.platform === "win32" ? "file" : undefined,
    );

    const order: string[] = [];
    await Promise.all([
      withFileMutationQueue(targetPath, async () => {
        order.push("target:start");
        await delay(30);
        order.push("target:end");
      }),
      withFileMutationQueue(symlinkPath, async () => {
        order.push("alias:start");
        order.push("alias:end");
      }),
    ]);

    expect(order).toEqual([
      "target:start",
      "target:end",
      "alias:start",
      "alias:end",
    ]);
  });
});
