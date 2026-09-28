import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Skill {
  /** The skill's directory name, so its file is always `<dir>/<name>/SKILL.md`. */
  name: string;
  description: string;
}

export function resolveSkillsDir(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

/**
 * Skills the model may pick on its own: one per `<dir>/<skill>/SKILL.md`,
 * sorted so the system prompt stays byte-stable across launches. Skills whose
 * frontmatter sets `disable-model-invocation: true` are left out.
 */
export function loadSkills(dir: string): Skill[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry, "SKILL.md");
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    const meta = parseFrontmatter(raw);
    if (meta["disable-model-invocation"] === "true") continue;
    skills.push({ name: entry, description: meta.description ?? "" });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Top-level scalar keys of a YAML frontmatter block. Nested maps are skipped. */
function parseFrontmatter(raw: string): Record<string, string> {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return {};
  const meta: Record<string, string> = {};
  for (let i = 1; i < lines.length && lines[i] !== "---"; i++) {
    const match = /^([\w-]+):\s*(.*)$/.exec(lines[i]!);
    if (!match) continue;
    const key = match[1]!;
    const value = match[2]!;
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) {
        block.push(lines[++i]!.trim());
      }
      meta[key] = block.join(value.startsWith(">") ? " " : "\n");
    } else {
      meta[key] = unquote(value.trim());
    }
  }
  return meta;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}
