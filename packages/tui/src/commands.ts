import type { Agent } from "@susan/harness";
import type { ModelSelection } from "./model-selection.js";

export interface CommandContext {
  agent: Agent;
  reset(): void;
  exit(): void;
  notice(level: "info" | "warn" | "error", text: string): void;
  selection: ModelSelection | null;
  onModelChange(): void;
  busy: boolean;
}

const HELP = [
  "commands",
  "  /help            show this",
  "  /tools           list the tools the agent can call",
  "  /model [id]      list or select configured models",
  "  /reasoning [m]  list or select reasoning levels",
  "  /cost            token usage for this session",
  "  /clear           forget the conversation and clear the screen",
  "  /exit            quit",
  "",
  "keys",
  "  enter            send        esc     interrupt the current run",
  "  up / down        input history           ctrl+c  quit",
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
          ...ctx.agent.tools.map((tool) =>
            `  ${tool.name.padEnd(6)} ${tool.description.split(".")[0]}.`),
        ].join("\n"),
      );
      return true;

    case "model": {
      if (!ctx.selection) {
        ctx.notice("warn", "no models configured in Susan Home/confg.json");
      } else if (!arg) {
        ctx.notice("info", ctx.selection.choices.map((choice) => {
          const key = `${choice.providerName}/${choice.model.id}`;
          return `${key === ctx.selection!.key ? "*" : " "} ${key} (${choice.model.name})`;
        }).join("\n"));
      } else if (ctx.busy) {
        ctx.notice("warn", "wait for the current run before switching models");
      } else {
        try {
          ctx.selection.select(arg);
          ctx.onModelChange();
          ctx.notice("info", `model: ${ctx.selection.label}`);
        } catch (error) { ctx.notice("error", (error as Error).message); }
      }
      return true;
    }

    case "reasoning": {
      if (!ctx.selection) {
        ctx.notice("warn", "no models configured in Susan Home/confg.json");
      } else if (!arg) {
        ctx.notice("info", Object.keys(ctx.selection.current.efforts).map((level) =>
          `${level === ctx.selection!.effort ? "*" : " "} ${level}`).join("\n"));
      } else if (ctx.busy) {
        ctx.notice("warn", "wait for the current run before changing reasoning");
      } else {
        try {
          ctx.selection.setEffort(arg);
          ctx.onModelChange();
          ctx.notice("info", `reasoning: ${arg}`);
        } catch (error) { ctx.notice("error", (error as Error).message); }
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
