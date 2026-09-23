import { z } from "zod";
import type { Tool, ToolContext, ToolResult, ToolRisk } from "../types.js";

export interface ToolSpec<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  risk: ToolRisk;
  schema: S;
  /** JSON Schema handed to the model (hand-written: it is prompt surface). */
  inputSchema: Record<string, unknown>;
  summarize(input: z.infer<S>): string;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Binds a Zod schema (runtime validation) to a JSON Schema (what the model
 * sees). The model's input is never trusted: `parse` runs before `run`.
 */
export function defineTool<S extends z.ZodTypeAny>(
  spec: ToolSpec<S>,
): Tool<z.infer<S>> {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    risk: spec.risk,
    parse(raw: unknown) {
      const result = spec.schema.safeParse(raw);
      if (!result.success) {
        const detail = result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new Error(`invalid input for ${spec.name} - ${detail}`);
      }
      return result.data;
    },
    summarize: spec.summarize,
    run: spec.run,
  };
}

export function ok(content: string, display: string): ToolResult {
  return { ok: true, content, display };
}

export function fail(message: string): ToolResult {
  return { ok: false, content: `Error: ${message}`, display: message };
}

/** Keeps a tool result from blowing up the context window. */
export function truncate(text: string, maxChars = 30_000): string {
  if (text.length <= maxChars) return text;
  const kept = text.slice(0, maxChars);
  return `${kept}\n\n... [truncated ${text.length - maxChars} characters]`;
}
