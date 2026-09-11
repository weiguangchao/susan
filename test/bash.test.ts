import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASH_OUTPUT_BUDGET_BYTES,
  createBashTool,
  type BashTool,
} from "../src/index.js";

const POSIX = process.platform !== "win32";

describe("Bash Tool", () => {
  let sessionCwd: string;
  let tool: BashTool;
  const leftoverPids = new Set<number>();

  beforeEach(async () => {
    sessionCwd = await mkdtemp(join(tmpdir(), "susan-bash-"));
    tool = createBashTool({ sessionCwd });
  });

  afterEach(async () => {
    for (const pid of leftoverPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    leftoverPids.clear();
    await rm(sessionCwd, { force: true, recursive: true });
  });

  it("exposes the bash tool definition", () => {
    expect(tool).toMatchObject({
      name: "bash",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "integer", minimum: 1, maximum: 3_600_000 },
        },
        required: ["command"],
      },
    });
  });

  it("rejects empty, NUL, oversized, and non-string commands", async () => {
    await expect(tool.execute({})).rejects.toThrow("Invalid bash arguments.");
    await expect(tool.execute({ command: "" })).rejects.toThrow(
      "Invalid bash arguments.",
    );
    await expect(tool.execute({ command: "echo\0hi" })).rejects.toThrow(
      "Invalid bash arguments.",
    );
    await expect(
      tool.execute({ command: "a".repeat(256 * 1024 + 1) }),
    ).rejects.toThrow("Invalid bash arguments.");
  });

  it("rejects illegal timeout and env overlay values without correcting them", async () => {
    for (const timeoutMs of [0, 1.5, 3_600_001, -1, Number.NaN]) {
      await expect(tool.execute({ command: "true", timeoutMs })).rejects.toThrow(
        "Invalid bash arguments.",
      );
    }
    await expect(
      tool.execute({ command: "true", env: { "FOO=BAR": "1" } }),
    ).rejects.toThrow("Invalid bash arguments.");
    await expect(
      tool.execute({ command: "true", env: { FOO: "a\0b" } }),
    ).rejects.toThrow("Invalid bash arguments.");
    await expect(
      createBashTool({ sessionCwd, platform: "win32" }).execute({
        command: "true",
        env: { Path: "a", PATH: "b" },
      }),
    ).rejects.toThrow("Invalid bash arguments.");
    await expect(
      tool.execute({ command: "true", env: { "": "x" } }),
    ).rejects.toThrow("Invalid bash arguments.");
    await expect(
      tool.execute({ command: "true", env: { "FOO\0BAR": "1" } }),
    ).rejects.toThrow("Invalid bash arguments.");
    await expect(
      tool.execute({ command: "true", extra: 1 }),
    ).rejects.toThrow("Invalid bash arguments.");
  });

  it("runs a successful one-shot command with separated streams", async () => {
    const result = await tool.execute({
      command: "printf %s out; printf %s err >&2",
    });

    expect(result).toMatchObject({
      details: {
        stdout: "out",
        stderr: "err",
        exitCode: 0,
        cwdRelation: "inside",
      },
    });
    expect(result.details?.resolvedPath).toBeDefined();
    expect(typeof result.details?.bashPath).toBe("string");
    expect(result.details?.truncation).toBeUndefined();
  });

  it("treats a whitespace-only command as a Bash no-op", async () => {
    await expect(tool.execute({ command: " \t\n" })).resolves.toMatchObject({
      details: { stdout: "", stderr: "", exitCode: 0 },
    });
  });

  it("passes command as a single argv value without trimming", async () => {
    const result = await tool.execute({
      command: " printf %s '  kept  ' ",
    });
    expect(result).toMatchObject({
      details: { stdout: "  kept  ", exitCode: 0 },
    });
  });

  it("maps a non-zero exit to EEXIT with budget-limited output", async () => {
    const result = await tool.execute({
      command: "printf %s failed; printf %s boom >&2; exit 7",
    });
    expect(result).toMatchObject({
      details: {
        stdout: "failed",
        stderr: "boom",
        exitCode: 7,
        signal: null,
        termination: {
          scope: POSIX ? "process-group" : "process-tree-best-effort",
          forced: false,
        },
      },
    });
  });

  it("resolves an explicit cwd through the shared path model and follows the entry symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "susan-bash-outside-"));
    try {
      await writeFile(join(outside, "marker.txt"), "outside\n");
      await symlink(
        outside,
        join(sessionCwd, "link"),
        process.platform === "win32" ? "junction" : undefined,
      );
      const result = await tool.execute({
        command: "printf %s \"$(pwd -P)\"",
        cwd: "link",
      });
      expect(result).toMatchObject({
        details: {
          stdout: await realpath(outside),
          cwdRelation: "outside",
          resolvedPath: join(sessionCwd, "link"),
          realTargetPath: await realpath(outside),
        },
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("maps missing, non-directory, and looping cwd values to stable codes", async () => {
    await writeFile(join(sessionCwd, "file.txt"), "not a dir\n");
    await expect(tool.execute({ command: "true", cwd: "missing" })).rejects.toThrow(
      "Working directory does not exist.",
    );
    await expect(tool.execute({ command: "true", cwd: "file.txt" })).rejects.toThrow(
      "Working directory is not a directory.",
    );
    if (POSIX) {
      await symlink("loop-b", join(sessionCwd, "loop-a"));
      await symlink("loop-a", join(sessionCwd, "loop-b"));
      await expect(tool.execute({ command: "true", cwd: "loop-a" })).rejects.toThrow(
        "Working directory contains a symlink loop.",
      );
      const denied = join(sessionCwd, "denied");
      await mkdir(denied);
      await chmod(denied, 0o000);
      try {
        await expect(tool.execute({ command: "true", cwd: "denied" })).rejects.toThrow(
          "Working directory cannot be accessed.",
        );
      } finally {
        await chmod(denied, 0o755);
      }
    }
  });

  it("does not let command cd change Session cwd for the next Tool Call", async () => {
    await mkdir(join(sessionCwd, "child"));
    const first = await tool.execute({ command: "cd child; printf %s \"$PWD\"" });
    const second = await tool.execute({ command: "printf %s \"$PWD\"" });
    expect(first.details?.exitCode).toBe(0);
    expect(second).toMatchObject({
      details: { stdout: await realpath(sessionCwd) },
    });
  });

  it("applies env overlay after Bash discovery and does not inject SUSAN variables", async () => {
    const result = await tool.execute({
      command: "printf %s \"${FOO-}|${DELETED-unset}|${SUSAN_SECRET-unset}\"",
      env: { FOO: "bar", DELETED: null },
    });
    expect(result).toMatchObject({
      details: { stdout: "bar|unset|unset" },
    });
  });

  it("returns EUNSUPPORTED when no real Bash candidate is available", async () => {
    const isolated = createBashTool({
      sessionCwd,
      platform: "win32",
      env: {
        PATH: "",
        Path: "",
        ProgramFiles: join(sessionCwd, "Program Files"),
        "ProgramFiles(x86)": join(sessionCwd, "Program Files x86"),
        LOCALAPPDATA: join(sessionCwd, "local"),
      },
    });
    await expect(isolated.execute({ command: "true" })).rejects.toThrow(
      "Bash is not available.",
    );
  });

  it("returns EACCES when Bash candidates exist but are not executable", async () => {
    const bashExe = join(sessionCwd, "bash.exe");
    await writeFile(bashExe, "not a bash\n");
    await chmod(bashExe, 0o644);
    const isolated = createBashTool({
      sessionCwd,
      platform: "win32",
      env: {
        PATH: sessionCwd,
        Path: sessionCwd,
        ProgramFiles: join(sessionCwd, "Program Files"),
        "ProgramFiles(x86)": join(sessionCwd, "Program Files (x86)"),
        LOCALAPPDATA: join(sessionCwd, "local"),
      },
    });
    await expect(isolated.execute({ command: "true" })).rejects.toThrow(
      "Bash is not executable.",
    );
  });

  it("keeps a UTF-8 character that arrives across chunk boundaries", async () => {
    const script = join(sessionCwd, "split-utf8.js");
    await writeFile(
      script,
      "process.stdout.write(Buffer.from([0xe4, 0xbd])); setTimeout(() => { process.stdout.write(Buffer.from([0xa0])); }, 50);\n",
    );
    const result = await tool.execute({
      command: `node ${JSON.stringify(script)}`,
    });
    expect(result).toMatchObject({
      details: { stdout: "你", exitCode: 0 },
    });
    expect(result.details?.decodeLoss).toBeUndefined();
  });

  it("replaces illegal UTF-8 and marks the affected stream", async () => {
    const script = join(sessionCwd, "bad-utf8.js");
    await writeFile(
      script,
      "process.stdout.write(Buffer.from([0xff, 0x41])); process.stderr.write(Buffer.from([0x42]));\n",
    );
    const result = await tool.execute({
      command: `node ${JSON.stringify(script)}`,
    });
    expect(result).toMatchObject({
      details: {
        stdout: "\uFFFD" + "A",
        stderr: "B",
        decodeLoss: ["stdout"],
      },
    });
  });

  it("preserves stream-internal order while sharing a 50 KiB tail budget", async () => {
    const script = join(sessionCwd, "budget.js");
    await writeFile(
      script,
      [
        "const out = Buffer.alloc(40_000, 0x61);",
        "const err = Buffer.alloc(40_000, 0x62);",
        "const tail = Buffer.alloc(20_000, 0x63);",
        "process.stdout.write(out);",
        "setTimeout(() => {",
        "  process.stderr.write(err);",
        "  setTimeout(() => { process.stdout.write(tail); }, 40);",
        "}, 40);",
      ].join("\n"),
    );
    const result = await tool.execute({
      command: `node ${JSON.stringify(script)}`,
    });
    const stdout = result.details?.stdout;
    const stderr = result.details?.stderr;
    if (typeof stdout !== "string" || typeof stderr !== "string") {
      throw new Error("expected string output fields");
    }
    expect(stderr).toMatch(/^b*$/);
    expect(stderr.length).toBeGreaterThan(0);
    expect(stdout).toBe("c".repeat(20_000));
    expect(stdout.includes("a")).toBe(false);
    const outputBytes =
      Buffer.byteLength(JSON.stringify(result.details?.stdout), "utf8") +
      Buffer.byteLength(JSON.stringify(result.details?.stderr), "utf8");
    expect(outputBytes).toBeLessThanOrEqual(BASH_OUTPUT_BUDGET_BYTES);
    expect(result.details?.truncation).toMatchObject({
      truncatedBy: "bytes",
    });
  });

  it("locks timeout as ETIMEDOUT and kills the managed POSIX process group", async () => {
    const parentScript = join(sessionCwd, "hold.js");
    const childScript = join(sessionCwd, "child.js");
    await writeFile(
      childScript,
      "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30_000);\n",
    );
    await writeFile(
      parentScript,
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        `const child = spawn(process.execPath, ${JSON.stringify([childScript])}, { stdio: 'ignore' });`,
        "writeFileSync('pids.txt', `${process.pid}\\n${child.pid}\\n`);",
        "setTimeout(() => {}, 30_000);",
      ].join("\n"),
    );
    const result = await tool.execute({
      command: "node hold.js",
      timeoutMs: 200,
    });
    expect(result).toMatchObject({
      details: {
        timeoutMs: 200,
        termination: {
          scope: POSIX ? "process-group" : "process-tree-best-effort",
          forced: true,
        },
      },
    });
    expect(result.details?.termination).toMatchObject({
      cleanupConfirmed: POSIX ? true : false,
    });
    const pids = (await readFile(join(sessionCwd, "pids.txt"), "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    expect(pids).toHaveLength(2);
    for (const pid of pids) {
      leftoverPids.add(pid);
      expect(Number.isInteger(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
      leftoverPids.delete(pid);
    }
  }, 15_000);

  it("does not claim cleanup of descendants that leave the POSIX process group", async () => {
    if (!POSIX) {
      return;
    }
    const parentScript = join(sessionCwd, "escape.js");
    const childScript = join(sessionCwd, "escaped-child.js");
    await writeFile(
      childScript,
      "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30_000);\n",
    );
    await writeFile(
      parentScript,
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        `const child = spawn(process.execPath, ${JSON.stringify([childScript])}, { stdio: 'ignore', detached: true });`,
        "writeFileSync('escaped.pid', String(child.pid));",
        "child.unref();",
        "setTimeout(() => {}, 30_000);",
      ].join("\n"),
    );
    const result = await tool.execute({
      command: "node escape.js",
      timeoutMs: 800,
    });
    expect(result.details?.timeoutMs).toBe(800);
    const pid = Number(await readFile(join(sessionCwd, "escaped.pid"), "utf8"));
    leftoverPids.add(pid);
    expect(Number.isInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).not.toThrow();
  }, 15_000);

  it("uses the shared termination state machine for user cancel without requiring a Tool Result consumer", async () => {
    const controller = new AbortController();
    const script = join(sessionCwd, "cancel.js");
    await writeFile(
      script,
      [
        "const { writeFileSync } = require('node:fs');",
        "writeFileSync('cancel.pid', String(process.pid));",
        "setTimeout(() => {}, 30_000);",
      ].join("\n"),
    );
    const running = tool.execute(
      { command: "node cancel.js" },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pid = Number(await readFile(join(sessionCwd, "cancel.pid"), "utf8"));
    leftoverPids.add(pid);
    controller.abort();
    await expect(running).rejects.toThrow("Tool execution failed.");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(pid, 0)).toThrow();
    leftoverPids.delete(pid);
  }, 15_000);

  it("maps an uncaught signal exit to ESIGNAL without reclassifying it as EEXIT", async () => {
    const result = await tool.execute({ command: "kill -s KILL $$" });
    expect(result).toMatchObject({
      details: {
        signal: "SIGKILL",
        termination: {
          scope: POSIX ? "process-group" : "process-tree-best-effort",
          forced: false,
        },
      },
    });
  });
});
