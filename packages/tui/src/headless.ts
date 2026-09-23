import {
  Agent,
  resolveSusanHome,
  type ModelProvider,
  type PermissionMode,
} from "@susan/harness";

export interface HeadlessOptions {
  root: string;
  provider: ModelProvider;
  mode: PermissionMode;
  prompt: string;
}

/**
 * One request, plain stdout, no UI. Useful for scripting susan and for seeing
 * the raw event stream the TUI renders.
 */
export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const agent = new Agent({
    root: options.root,
    provider: options.provider,
    permissionMode: options.mode,
    sessionHome: resolveSusanHome(),
    onPermissionRequest: async (request) => {
      // There is nobody to ask in headless mode: --mode auto is the way to
      // opt in to unattended writes and commands.
      process.stdout.write(
        `[denied] ${request.toolName}: ${request.summary} (re-run with --mode auto to allow)\n`,
      );
      return "deny";
    },
  });

  let failed = false;

  for await (const event of agent.run(options.prompt)) {
    switch (event.type) {
      case "text_end":
        process.stdout.write(`\n${event.text}\n`);
        break;
      case "tool_call":
        process.stdout.write(`[tool] ${event.name} ${event.summary}\n`);
        break;
      case "tool_result":
        process.stdout.write(
          `[${event.ok ? "ok" : "error"}] ${event.name}: ${event.display}\n`,
        );
        break;
      case "notice":
        process.stdout.write(`[${event.level}] ${event.message}\n`);
        if (event.level === "error") failed = true;
        break;
      case "done":
        if (event.reason === "error" || event.reason === "max_turns") {
          failed = true;
        }
        break;
      default:
        break;
    }
  }

  const usage = agent.session.usage;
  process.stdout.write(
    `\n[usage] ${usage.inputTokens} in · ${usage.outputTokens} out · ${agent.session.turns} turns\n`,
  );

  return failed ? 1 : 0;
}
