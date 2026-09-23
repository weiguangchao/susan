import type { Agent, PermissionMode } from "@susan/harness";

export interface CommandContext {
  agent: Agent;
  mode: PermissionMode;
  setMode(mode: PermissionMode): void;
  reset(): void;
  exit(): void;
  notice(level: "info" | "warn" | "error", text: string): void;
}

const HELP = [
  "commands",
  "  /help            show this",
  "  /tools           list the tools the agent can call",
  "  /mode <m>        permission mode: ask | auto | readonly",
  "  /cost            token usage for this session",
  "  /clear           forget the conversation and clear the screen",
  "  /exit            quit",
  "",
  "keys",
  "  enter            send        esc     interrupt the current run",
  "  up / down        input history           ctrl+c  quit",
  "  y / a / n        answer a permission prompt",
].join("\n");

/** Returns true when the input was a command (handled here, not sent to the model). */
export function runCommand(input: string, ctx: CommandContext): boolean {
  if (!input.startsWith("/")) return false;

  const [name, ...rest] = input.slice(1).trim().split(/\s+/);
  const arg = rest.join(" ");

  switch (name) {
    case "help":
      ctx.notice("info", HELP);
      return true;

    case "tools":
      ctx.notice(
        "info",
        [
          "tools",
          ...ctx.agent.tools.map(
            (tool) =>
              `  ${tool.name.padEnd(6)} ${tool.risk === "safe" ? "  " : "! "}${tool.description.split(".")[0]}.`,
          ),
          "",
          "  ! marks tools that need your approval in ask mode.",
        ].join("\n"),
      );
      return true;

    case "mode": {
      if (arg === "ask" || arg === "auto" || arg === "readonly") {
        ctx.setMode(arg);
        ctx.agent.permissions.setMode(arg);
        ctx.notice("info", `permission mode: ${arg}`);
      } else {
        ctx.notice(
          "warn",
          `current mode: ${ctx.mode}. Usage: /mode ask | auto | readonly`,
        );
      }
      return true;
    }

    case "cost": {
      const usage = ctx.agent.session.usage;
      ctx.notice(
        "info",
        `${usage.inputTokens} input · ${usage.outputTokens} output · ` +
          `${usage.cacheReadTokens} cached · ${ctx.agent.session.turns} model turns`,
      );
      return true;
    }

    case "clear":
      ctx.reset();
      return true;

    case "exit":
    case "quit":
      ctx.exit();
      return true;

    default:
      ctx.notice("warn", `unknown command: /${name} - try /help`);
      return true;
  }
}
