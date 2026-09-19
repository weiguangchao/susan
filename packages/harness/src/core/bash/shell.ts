import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access as fsAccess, constants } from "node:fs/promises";
import { join } from "node:path";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const EXIT_STDIO_GRACE_MS = 100;

export type BashOperations = {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
};

type ShellConfig = {
  readonly shell: string;
  readonly args: readonly string[];
  readonly commandTransport?: "argv" | "stdin";
};

export function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

function isLegacyWslBashPath(path: string): boolean {
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(path.replaceAll("/", "\\").toLowerCase());
}

function getBashShellConfig(shell: string): ShellConfig {
  return isLegacyWslBashPath(shell)
    ? { shell, args: ["-s"], commandTransport: "stdin" }
    : { shell, args: ["-c"] };
}

function findExecutableOnPath(executable: string): string | null {
  if (process.platform === "win32") {
    try {
      const result = spawnSync("where", [executable], {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status === 0 && result.stdout) {
        const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
        if (firstMatch !== undefined && existsSync(firstMatch)) {
          return firstMatch;
        }
      }
    } catch {
      // Ignore lookup errors and fall through.
    }
    return null;
  }

  try {
    const result = spawnSync("which", [executable], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) {
        return firstMatch;
      }
    }
  } catch {
    // Ignore lookup errors and fall through.
  }
  return null;
}

function getShellConfig(): ShellConfig {
  if (process.platform === "win32") {
    const paths: string[] = [];
    const programFiles = process.env.ProgramFiles;
    if (programFiles) {
      paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
    }
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    if (programFilesX86) {
      paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
    }
    for (const path of paths) {
      if (existsSync(path)) {
        return getBashShellConfig(path);
      }
    }
    const bashOnPath = findExecutableOnPath("bash.exe");
    if (bashOnPath !== null) {
      return getBashShellConfig(bashOnPath);
    }
    throw new Error(
      `No bash shell found. Options:\n` +
        `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
        `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n\n` +
        `Searched Git Bash in:\n${paths.map((path) => `  ${path}`).join("\n")}`,
    );
  }

  if (existsSync("/bin/bash")) {
    return getBashShellConfig("/bin/bash");
  }
  const bashOnPath = findExecutableOnPath("bash");
  if (bashOnPath !== null) {
    return getBashShellConfig(bashOnPath);
  }
  return { shell: "sh", args: ["-c"] };
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      const child = spawn(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/F", "/T", "/PID", String(pid)],
        {
          stdio: "ignore",
          detached: true,
          windowsHide: true,
        },
      );
      child.once("error", () => {});
    } catch {
      // Ignore taskkill failures.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already dead.
    }
  }
}

function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer !== undefined) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(code);
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) {
        return;
      }
      if (stdoutEnded && stderrEnded) {
        finalize(exitCode);
      }
    };

    const armIdleTimer = () => {
      if (postExitTimer !== undefined) {
        clearTimeout(postExitTimer);
      }
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
    };

    const onData = () => {
      if (exited && !settled) {
        armIdleTimer();
      }
    };

    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };

    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };

    const onError = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };

    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) {
        armIdleTimer();
      }
    };

    const onClose = (code: number | null) => {
      finalize(code);
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

export function createLocalBashOperations(): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) {
        throw new Error("aborted");
      }
      const shellConfig = getShellConfig();
      try {
        await fsAccess(cwd, constants.F_OK);
      } catch {
        throw new Error(
          `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
        );
      }

      const commandFromStdin = shellConfig.commandTransport === "stdin";
      const child = spawn(
        shellConfig.shell,
        commandFromStdin
          ? [...shellConfig.args]
          : [...shellConfig.args, command],
        {
          cwd,
          detached: process.platform !== "win32",
          env: env ?? process.env,
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      if (commandFromStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(command);
      }
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const onAbort = () => {
        if (child.pid !== undefined) {
          killProcessTree(child.pid);
        }
      };

      try {
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid !== undefined) {
              killProcessTree(child.pid);
            }
          }, timeoutMs);
        }
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }
        const exitCode = await waitForChildProcess(child);
        if (signal?.aborted) {
          throw new Error("aborted");
        }
        if (timedOut) {
          throw new Error(`timeout:${timeout}`);
        }
        return { exitCode };
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    },
  };
}
