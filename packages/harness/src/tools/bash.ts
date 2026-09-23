import { spawn } from "node:child_process";
import { z } from "zod";
import { defineTool, fail, ok, truncate } from "./define.js";
import type { ToolContext, ToolResult } from "../types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

/**
 * A short, deliberately narrow list of commands that are catastrophic and never
 * intentional from an agent. This check runs even when tools execute automatically.
 */
const REFUSED = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f?\s+\/(\s|$)/, why: "recursive delete of /" },
  { pattern: /\bmkfs(\.\w+)?\b/, why: "filesystem format" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//, why: "raw write to a block device" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/, why: "fork bomb" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, why: "host power control" },
];

function runCommand(
  command: string,
  timeoutMs: number,
  ctx: ToolContext,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    // `detached` puts the command in its own process group so the whole tree
    // can be killed at once. Killing only the shell leaves grandchildren alive
    // holding the stdio pipes open, and `close` would not fire until they exit.
    const child = spawn(command, {
      shell: "/bin/bash",
      cwd: ctx.root,
      env: process.env,
      detached: true,
    });

    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const onAbort = () => killTree();
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish(fail(`failed to start command: ${error.message}`));
    });

    child.on("close", (code) => {
      if (timedOut) {
        finish(
          fail(
            `command timed out after ${timeoutMs}ms and was killed\n${truncate(stdout + stderr, MAX_OUTPUT_CHARS)}`,
          ),
        );
        return;
      }
      if (ctx.signal.aborted) {
        finish(fail("command was interrupted"));
        return;
      }

      const parts: string[] = [];
      if (stdout.trim()) parts.push(stdout.trimEnd());
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
      const body = parts.join("\n") || "(no output)";
      const exit = code ?? -1;

      if (exit === 0) {
        const lines = body === "(no output)" ? 0 : body.split("\n").length;
        finish(
          ok(
            truncate(body, MAX_OUTPUT_CHARS),
            lines > 0 ? `exit 0, ${lines} lines of output` : "exit 0",
          ),
        );
      } else {
        finish({
          ok: false,
          content: truncate(`Exit code ${exit}.\n${body}`, MAX_OUTPUT_CHARS),
          display: `exit ${exit}`,
        });
      }
    });
  });
}

export const bashTool = defineTool({
  name: "bash",
  description:
    "Run a shell command from the project root. Use it for builds, tests, git, " +
    "and anything the dedicated tools do not cover - but prefer read/ls/grep for " +
    "inspecting files, they return cleaner output. State does not persist between calls.",
  risk: "exec",
  schema: z.object({
    command: z.string().min(1),
    timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional(),
  }),
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      timeout_ms: {
        type: "number",
        description: `Timeout in milliseconds (max ${MAX_TIMEOUT_MS}). Defaults to ${DEFAULT_TIMEOUT_MS}.`,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  summarize: (input) => {
    const oneLine = input.command.replace(/\s+/g, " ").trim();
    return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
  },
  async run(input, ctx) {
    for (const rule of REFUSED) {
      if (rule.pattern.test(input.command)) {
        return fail(
          `refused: this command looks like ${rule.why}. If you really need it, ask the user to run it themselves.`,
        );
      }
    }
    return runCommand(input.command, input.timeout_ms ?? DEFAULT_TIMEOUT_MS, ctx);
  },
});
