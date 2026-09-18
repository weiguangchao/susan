import { resolve } from "node:path";
import { render } from "ink";
import { createHarnessAssembly, type AssembleOptions } from "./assembly";
import type { ConfigError } from "./core/config";
import { formatCliError, parseCli } from "./core/cli";
import { formatConfigError } from "./core/config-error";
import type { SessionSummary } from "./core/session";
import { ConfigErrorApp } from "./ui/config-error";
import { SessionPickerApp } from "./ui/session-picker";
import { modelPickerCatalog, TuiApp } from "./ui/tui";
import { createTuiOutput } from "./ui/terminal-output";

const TTY_REQUIRED = "susan: TUI requires an interactive terminal\n";
export const CLEAR_TERMINAL_SEQUENCE = "\u001B[2J\u001B[3J\u001B[H";
export function clearTerminal(
  stdout: { readonly write: (value: string) => unknown } = process.stdout,
): void {
  stdout.write(CLEAR_TERMINAL_SEQUENCE);
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const parsed = parseCli(argv);
  if (!parsed.ok) {
    process.stderr.write(formatCliError(parsed.error));
    return 1;
  }
  const assembly = createHarnessAssembly({
    susanHomeParent:
      parsed.flags.susanHomeParent === undefined
        ? undefined
        : resolve(parsed.flags.susanHomeParent),
  });
  let request: AssembleOptions = {
    session:
      parsed.flags.resume.kind === "none"
        ? { kind: "new" }
        : parsed.flags.resume,
    newSessionCwd: process.cwd(),
  };
  let result = await assembly.assemble(request);
  while (true) {
    if (result.kind === "config-error") {
      if (!isInteractive()) {
        process.stderr.write(formatConfigErrorText(result.error));
        return 1;
      }
      if ((await showConfigError(result.error)) === "exit") return 0;
      const updated = await assembly.reload();
      result =
        updated.kind === "updated" ? await assembly.assemble(request) : updated;
      continue;
    }
    if (result.kind === "startup-error") {
      process.stderr.write(`susan: ${result.error.message}\n`);
      return 1;
    }
    if (!isInteractive()) {
      process.stderr.write(TTY_REQUIRED);
      return 1;
    }
    if (result.kind === "session-picker") {
      const picked = await showSessionPicker(result.sessions);
      if (picked === "exit") return 0;
      request = {
        ...request,
        session:
          picked === "new" ? { kind: "new" } : { kind: "id", id: picked },
      };
      result = await assembly.assemble(request);
      continue;
    }
    clearTerminal();
    const instance = render(
      <TuiApp
        harness={result.harness}
        inputHistory={result.inputHistory}
        assembly={assembly}
        modelCatalog={modelPickerCatalog(result.config)}
      />,
      { incrementalRendering: true, stdout: createTuiOutput(process.stdout) },
    );
    await instance.waitUntilExit();
    return 0;
  }
}

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function formatConfigErrorText(error: ConfigError): string {
  const view = formatConfigError(error);
  const lines = [
    `susan: ${view.heading}`,
    view.code,
    view.configPath,
    ...view.issues.map((issue) => `${issue.path}: ${issue.message}`),
  ];
  if (view.example !== null) {
    lines.push("", "最小 Config 示例：", view.example);
  }
  return `${lines.join("\n")}\n`;
}

async function showConfigError(error: ConfigError): Promise<"reload" | "exit"> {
  return new Promise((resolve) => {
    const instance = render(
      <ConfigErrorApp
        view={formatConfigError(error)}
        onReload={() => {
          instance.unmount();
          resolve("reload");
        }}
        onExit={() => {
          instance.unmount();
          resolve("exit");
        }}
      />,
    );
  });
}

async function showSessionPicker(
  sessions: readonly SessionSummary[],
): Promise<string | "new" | "exit"> {
  return new Promise((resolve) => {
    const instance = render(
      <SessionPickerApp
        sessions={sessions}
        onSelect={(sessionId) => {
          instance.unmount();
          resolve(sessionId);
        }}
        onNew={() => {
          instance.unmount();
          resolve("new");
        }}
        onExit={() => {
          instance.unmount();
          resolve("exit");
        }}
      />,
    );
  });
}
