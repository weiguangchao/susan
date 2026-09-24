import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../atomic-write.js";
import { resolveSusanHome } from "../session/store.js";

export type ModelPreferences = Record<string, string>;

export async function loadModelPreferences(home = resolveSusanHome()): Promise<ModelPreferences> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(home, "model-state.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function saveModelPreferences(preferences: ModelPreferences, home = resolveSusanHome()): Promise<void> {
  await writeFileAtomic(path.join(home, "model-state.json"), JSON.stringify(preferences, null, 2) + "\n");
}
