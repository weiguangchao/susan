// Ported from Pi 400d690 (MIT); see THIRD_PARTY_NOTICES.
import type { HarnessTool } from "./harness";

const IDENTITY =
  "You are Susan, an expert coding agent operating inside a minimal personal Harness. You help users by reading files, executing commands, editing code, and writing new files.";

const RESIDENT_GUIDELINES = [
  "Be concise in your responses",
  "Show file paths clearly when working with files",
] as const;

export function buildSystemPrompt(
  tools: readonly HarnessTool[],
  cwd: string,
): string {
  const promptCwd = cwd.replaceAll("\\", "/");
  const toolsList =
    tools.length > 0
      ? tools
          .map((tool) => `- ${tool.name}: ${tool.promptSnippet ?? ""}`)
          .join("\n")
      : "(none)";

  const guidelinesList: string[] = [];
  const seen = new Set<string>();
  const addGuideline = (guideline: string): void => {
    const normalized = guideline.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    guidelinesList.push(normalized);
  };

  for (const tool of tools) {
    for (const guideline of tool.promptGuidelines ?? []) {
      addGuideline(guideline);
    }
  }
  for (const guideline of RESIDENT_GUIDELINES) {
    addGuideline(guideline);
  }

  const guidelines = guidelinesList.map((item) => `- ${item}`).join("\n");
  return `${IDENTITY}

Available tools:
${toolsList}

Guidelines:
${guidelines}
Current working directory: ${promptCwd}`;
}
