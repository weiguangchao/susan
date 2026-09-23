import { randomBytes } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    if (this.#file === null) await this.#create();
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

  async #create(): Promise<void> {
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

    for (;;) {
      const randomNumber = randomBytes(4).readUInt32BE(0)
        .toString().padStart(10, "0");
      const filename = `${prefix}-${randomNumber}.jsonl`;
      const file = path.join(directory, filename);
      let handle;
      try {
        handle = await open(file, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
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
