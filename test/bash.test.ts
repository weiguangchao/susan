import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASH_PROMPT_GUIDELINES,
  BASH_PROMPT_SNIPPET,
  createBashTool,
  type BashOperations,
  type BashTool,
  type ToolResult,
} from "../src/index";

const BASH_DESCRIPTION =
  "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.";

function textOf(result: ToolResult): string {
  const block = result.content[0];
  if (block === undefined || block.type !== "text") {
    throw new Error("expected a text content block");
  }
  return block.text;
}

async function rmIfExists(path: string | undefined): Promise<void> {
  if (path === undefined) {
    return;
  }
  try {
    await unlink(path);
  } catch {
    // Already gone.
  }
}

describe("Bash Tool", () => {
  let sessionCwd: string;
  let tool: BashTool;
  const leftoverPids = new Set<number>();
  const leftoverFiles = new Set<string>();

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
    for (const path of leftoverFiles) {
      await rmIfExists(path);
    }
    leftoverFiles.clear();
    await rm(sessionCwd, { force: true, recursive: true });
  });

  it("exposes the Pi bash definition with empty guidelines", () => {
    expect(tool).toMatchObject({
      name: "bash",
      description: BASH_DESCRIPTION,
      promptSnippet: BASH_PROMPT_SNIPPET,
      promptGuidelines: BASH_PROMPT_GUIDELINES,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute",
          },
          timeout: {
            type: "number",
            description: "Timeout in seconds (optional, no default timeout)",
          },
        },
        required: ["command"],
      },
    });
    expect(BASH_PROMPT_SNIPPET).toBe("Execute bash commands (ls, grep, find, etc.)");
    expect(BASH_PROMPT_GUIDELINES).toEqual([]);
  });

  it("rejects extra keys and non-string commands", async () => {
    await expect(tool.execute({})).rejects.toThrow("Invalid bash arguments.");
    await expect(tool.execute({ command: 1 })).rejects.toThrow(
      "Invalid bash arguments.",
    );
    await expect(
      tool.execute({ command: "true", cwd: sessionCwd }),
    ).rejects.toThrow("Invalid bash arguments.");
    await expect(
      tool.execute({ command: "true", env: { FOO: "bar" } }),
    ).rejects.toThrow("Invalid bash arguments.");
    await expect(
      tool.execute({ command: "true", timeoutMs: 1000 }),
    ).rejects.toThrow("Invalid bash arguments.");
    await expect(
      tool.execute({ command: "true", extra: 1 }),
    ).rejects.toThrow("Invalid bash arguments.");
  });

  it("rejects invalid timeout values with Pi timeout semantics", async () => {
    await expect(
      tool.execute({ command: "true", timeout: 0 }),
    ).rejects.toThrow("Invalid timeout: must be a finite number of seconds");
    await expect(
      tool.execute({ command: "true", timeout: -1 }),
    ).rejects.toThrow("Invalid timeout: must be a finite number of seconds");
    await expect(
      tool.execute({ command: "true", timeout: Number.NaN }),
    ).rejects.toThrow("Invalid timeout: must be a finite number of seconds");
    await expect(
      tool.execute({ command: "true", timeout: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow("Invalid timeout: must be a finite number of seconds");
    await expect(
      tool.execute({ command: "true", timeout: "5" }),
    ).rejects.toThrow("Invalid bash arguments.");
    await expect(
      tool.execute({ command: "true", timeout: 3_000_000 }),
    ).rejects.toThrow(/Invalid timeout: maximum is /);
  });

  it("runs a successful command and merges stdout with stderr", async () => {
    const result = await tool.execute({
      command: "printf %s out; printf %s err >&2",
    });
    expect(textOf(result)).toBe("outerr");
    expect(result.details).toBeUndefined();
  });

  it("returns (no output) for a successful empty command", async () => {
    const result = await tool.execute({ command: "true" });
    expect(textOf(result)).toBe("(no output)");
    expect(result.details).toBeUndefined();
  });

  it("does not persist cwd changes across Tool Calls", async () => {
    const first = await tool.execute({ command: "mkdir child; cd child; pwd" });
    const second = await tool.execute({ command: "pwd" });
    expect(textOf(first).trim().endsWith("/child")).toBe(true);
    expect(textOf(second).trim()).toBe(await realpath(sessionCwd));
  });

  it("inherits process environment and has no env overlay parameter", async () => {
    const previous = process.env.SUSAN_BASH_INHERIT;
    process.env.SUSAN_BASH_INHERIT = "from-parent";
    try {
      const result = await tool.execute({
        command: 'printf %s "${SUSAN_BASH_INHERIT-unset}"',
      });
      expect(textOf(result)).toBe("from-parent");
    } finally {
      if (previous === undefined) {
        delete process.env.SUSAN_BASH_INHERIT;
      } else {
        process.env.SUSAN_BASH_INHERIT = previous;
      }
    }
  });

  it("throws on non-zero exit with merged output", async () => {
    await expect(
      tool.execute({
        command: "printf %s failed; printf %s boom >&2; exit 7",
      }),
    ).rejects.toThrow("failedboom\n\nCommand exited with code 7");
  });

  it("throws when the Session cwd does not exist", async () => {
    const missing = join(sessionCwd, "missing");
    const isolated = createBashTool({ sessionCwd: missing });
    await expect(isolated.execute({ command: "echo test" })).rejects.toThrow(
      /Working directory does not exist/,
    );
  });

  it("respects timeout in seconds with no default", async () => {
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`;
    await expect(
      tool.execute({ command, timeout: 0.05 }),
    ).rejects.toThrow(/timed out/i);
  }, 15_000);

  it("throws Command aborted when the signal fires", async () => {
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
      { command: `node ${JSON.stringify(script)}` },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pid = Number(await readFile(join(sessionCwd, "cancel.pid"), "utf8"));
    leftoverPids.add(pid);
    controller.abort();
    await expect(running).rejects.toThrow("Command aborted");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(pid, 0)).toThrow();
    leftoverPids.delete(pid);
  }, 15_000);

  it("keeps a UTF-8 character that arrives across chunk boundaries", async () => {
    const operations: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        const euro = Buffer.from("€\n", "utf-8");
        onData(euro.subarray(0, 1));
        onData(euro.subarray(1));
        return { exitCode: 0 };
      },
    };
    const isolated = createBashTool({ sessionCwd, operations });
    const result = await isolated.execute({ command: "split-utf8" });
    expect(textOf(result).trim()).toBe("€");
  });

  it("does not count a trailing newline as an extra truncated line", async () => {
    const operations: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        for (let i = 1; i <= 4000; i += 1) {
          onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`, "utf-8"));
        }
        return { exitCode: 0 };
      },
    };
    const isolated = createBashTool({ sessionCwd, operations });
    const result = await isolated.execute({ command: "many-lines" });
    const output = textOf(result);
    if (result.details?.fullOutputPath !== undefined) {
      leftoverFiles.add(result.details.fullOutputPath);
    }
    expect(result.details?.truncation?.totalLines).toBe(4000);
    expect(result.details?.truncation?.outputLines).toBe(2000);
    expect(output).toContain("line-2001");
    expect(output).toContain("line-4000");
    expect(output).toMatch(
      /\[Showing lines 2001-4000 of 4000\. Full output: /,
    );
    expect(output).not.toContain("4001");
  });

  it("persists full output when truncation happens by line count", async () => {
    const operations: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        for (let i = 1; i <= 3000; i += 1) {
          onData(Buffer.from(`${i}\n`, "utf-8"));
        }
        return { exitCode: 0 };
      },
    };
    const isolated = createBashTool({ sessionCwd, operations });
    const result = await isolated.execute({ command: "seq" });
    const output = textOf(result);
    const fullOutputPath = result.details?.fullOutputPath;
    if (fullOutputPath !== undefined) {
      leftoverFiles.add(fullOutputPath);
    }
    expect(result.details?.truncation?.truncated).toBe(true);
    expect(result.details?.truncation?.truncatedBy).toBe("lines");
    expect(fullOutputPath).toBeDefined();
    expect(output).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
    expect(existsSync(fullOutputPath!)).toBe(true);
    const fullOutput = await readFile(fullOutputPath!, "utf-8");
    expect(fullOutput).toContain("1\n2\n3");
    expect(fullOutput).toContain("2998\n2999\n3000");
  });

  it("uses the bytes-limit truncation footer", async () => {
    const operations: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        for (let i = 0; i < 200; i += 1) {
          onData(Buffer.from(`${"x".repeat(400)}\n`, "utf-8"));
        }
        return { exitCode: 0 };
      },
    };
    const isolated = createBashTool({ sessionCwd, operations });
    const result = await isolated.execute({ command: "bytes" });
    if (result.details?.fullOutputPath !== undefined) {
      leftoverFiles.add(result.details.fullOutputPath);
    }
    expect(result.details?.truncation?.truncatedBy).toBe("bytes");
    expect(textOf(result)).toMatch(
      /\[Showing lines \d+-\d+ of \d+ \(50\.0KB limit\)\. Full output: /,
    );
  });

  it("uses the partial-last-line truncation footer", async () => {
    const operations: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.alloc(60_000, 0x61));
        return { exitCode: 0 };
      },
    };
    const isolated = createBashTool({ sessionCwd, operations });
    const result = await isolated.execute({ command: "partial" });
    if (result.details?.fullOutputPath !== undefined) {
      leftoverFiles.add(result.details.fullOutputPath);
    }
    expect(result.details?.truncation?.lastLinePartial).toBe(true);
    expect(textOf(result)).toMatch(
      /\[Showing last 50\.0KB of line 1 \(line is 58\.6KB\)\. Full output: /,
    );
  });

  it("includes the full output path for truncated timeout and abort errors", async () => {
    for (const testCase of [
      { error: "timeout:5", expected: "Command timed out after 5 seconds" },
      { error: "aborted", expected: "Command aborted" },
    ]) {
      const operations: BashOperations = {
        exec: async (_command, _cwd, { onData }) => {
          for (let i = 1; i <= 3000; i += 1) {
            onData(Buffer.from(`${i}\n`, "utf-8"));
          }
          throw new Error(testCase.error);
        },
      };
      const isolated = createBashTool({ sessionCwd, operations });
      let error: unknown;
      try {
        await isolated.execute({ command: "chatty-fail" });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain(testCase.expected);
      expect(message).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
      expect(message).not.toContain("Full output: undefined");
      const fullOutputPath = message.match(/Full output: ([^\]]+)/)?.[1];
      expect(fullOutputPath).toBeDefined();
      leftoverFiles.add(fullOutputPath!);
      expect(existsSync(fullOutputPath!)).toBe(true);
      const fullOutput = await readFile(fullOutputPath!, "utf-8");
      expect(fullOutput).toContain("1\n2\n3");
      expect(fullOutput).toContain("2998\n2999\n3000");
    }
  });
});
