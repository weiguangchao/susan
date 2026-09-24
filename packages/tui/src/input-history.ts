import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "@susan/harness";

const LIMIT = 100;

export class InputHistory {
  readonly #home: string;
  readonly #entries: string[];
  #saving: Promise<void> = Promise.resolve();

  private constructor(home: string, entries: string[]) {
    this.#home = home;
    this.#entries = entries;
  }

  static async load(home: string): Promise<InputHistory> {
    const file = path.join(home, "input-history.json");
    let entries: unknown;
    try {
      entries = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new InputHistory(home, []);
      throw error;
    }
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === "string")) {
      throw new Error(`invalid input history in ${file}`);
    }
    return new InputHistory(home, entries.slice(0, LIMIT));
  }

  get entries(): string[] {
    return [...this.#entries];
  }

  record(input: string): Promise<void> {
    this.#entries.unshift(input);
    this.#entries.splice(LIMIT);
    const snapshot = [...this.#entries];
    this.#saving = this.#saving.catch(() => {}).then(() => this.#save(snapshot));
    return this.#saving;
  }

  #save(entries: string[]): Promise<void> {
    return writeFileAtomic(path.join(this.#home, "input-history.json"), JSON.stringify(entries) + "\n");
  }
}
