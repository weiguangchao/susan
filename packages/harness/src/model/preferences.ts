import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
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
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "model-state.json");
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(preferences, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
