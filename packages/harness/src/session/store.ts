import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import type { Message, Usage } from "../types.js";

export function resolveSusanHome(value = process.env.SUSAN_HOME): string {
  return path.resolve(value || path.join(os.homedir(), ".susan"));
}

/** One append-only JSONL file per conversation. The file is created on first input. */
export class SessionStore {
  readonly home: string;
  readonly root: string;
  #file: string | null = null;

  constructor(home: string, root: string) {
    this.home = home;
    this.root = root;
  }

  get file(): string | null {
    return this.#file;
  }

  async append(message: Message, usage?: Usage): Promise<void> {
    if (this.#file === null) await this.#create(message);
    const record = {
      type: "message",
      timestamp: new Date().toISOString(),
      message,
      ...(usage ? { usage } : {}),
    };
    const handle = await open(this.#file!, "a");
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`);
    } finally {
      await handle.close();
    }
  }

  async #create(first: Message): Promise<void> {
    if (first.role !== "user") throw new Error("a session must start with user input");
    const input = first.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const hash = createHash("sha256").update(input).digest("hex").slice(0, 12);
    for (;;) {
      const now = new Date();
      const year = String(now.getFullYear());
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const directory = path.join(this.home, "session", year, month);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const date = `${year}-${month}-${String(now.getDate()).padStart(2, "0")}`;
      const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((part) => String(part).padStart(2, "0"))
        .join("-");
      const prefix = `${date}T${time}-${String(now.getMilliseconds()).padStart(3, "0")}`;
      const filename = `${prefix}-${hash}.jsonl`;
      const file = path.join(directory, filename);
      let handle;
      try {
        handle = await open(file, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          await setTimeout(1);
          continue;
        }
        throw error;
      }
      try {
        await handle.writeFile(`${JSON.stringify({
          type: "session",
          version: 1,
          createdAt: now.toISOString(),
          root: this.root,
        })}\n`);
      } finally {
        await handle.close();
      }
      this.#file = file;
      return;
    }
  }
}
