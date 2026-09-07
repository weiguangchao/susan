import { PassThrough } from "node:stream";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import type { Harness, HarnessSnapshot } from "../src/index.js";
import { TuiApp } from "../src/index.js";

function terminalInput(): NodeJS.ReadStream {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref(): void;
    setRawMode(mode: boolean): void;
    unref(): void;
  };
  input.isTTY = true;
  input.ref = () => {};
  input.setRawMode = () => {};
  input.unref = () => {};
  return input as unknown as NodeJS.ReadStream;
}

function terminalOutput(onWrite: (chunk: string) => void): NodeJS.WriteStream {
  const output = new PassThrough() as PassThrough & {
    columns: number;
    isTTY: boolean;
    rows: number;
  };
  output.columns = 80;
  output.isTTY = true;
  output.rows = 24;
  output.on("data", (chunk: Buffer) => onWrite(chunk.toString("utf8")));
  return output as unknown as NodeJS.WriteStream;
}

function idleHarness(): Harness {
  const snapshot: HarnessSnapshot = {
    status: "idle",
    sessionId: "session-1",
    cwd: "/workspace",
    messages: [],
    pending: null,
    model: "gpt-5-codex",
    reasoningEffort: "high",
    contextWindow: 418_000,
    sessionTotalTokens: 0,
  };
  return {
    async dispatch() {
      return { ok: true };
    },
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  };
}

const modelCatalog = {
  defaultProviderAlias: "deepseek",
  preferredModel: "gpt-5-codex",
  preferredReasoningEffort: "high" as const,
  providers: [
    {
      alias: "deepseek",
      type: "openai-completion" as const,
      models: [{ id: "gpt-5-codex" }],
    },
  ],
};

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("TUI terminal resize", () => {
  it("reflows the input container after stdout dimensions change", async () => {
    const chunks: string[] = [];
    const stdin = terminalInput();
    const stdout = terminalOutput((chunk) => chunks.push(chunk));
    const harness = idleHarness();
    const instance = render(
      <TuiApp
        harness={harness}
        inputHistory={[]}
        startNewSession={() => harness}
        modelCatalog={modelCatalog}
        applyModelSelection={async () => ({ ok: false, message: "not used" })}
      />,
      { stdin, stdout, interactive: true, patchConsole: false },
    );

    await instance.waitUntilRenderFlush();
    await flushEffects();
    chunks.length = 0;

    const resized = stdout as NodeJS.WriteStream & {
      columns: number;
      rows: number;
    };
    resized.columns = 40;
    resized.rows = 16;
    resized.emit("resize");
    await flushEffects();
    await instance.waitUntilRenderFlush();

    const resizePaint = stripAnsi(chunks.join(""));
    const border = resizePaint
      .split("\n")
      .findLast((line) => line.includes("╭") && line.includes("╮"));
    expect(border).toBeDefined();
    expect(border?.length).toBeLessThanOrEqual(40);

    chunks.length = 0;
    resized.columns = 100;
    resized.rows = 30;
    resized.emit("resize");
    await flushEffects();
    await instance.waitUntilRenderFlush();

    const expandedBorder = stripAnsi(chunks.join(""))
      .split("\n")
      .findLast((line) => line.includes("╭") && line.includes("╮"));
    expect(expandedBorder).toBeDefined();
    expect(expandedBorder?.length).toBe(99);

    instance.unmount();
    await instance.waitUntilExit();
  });
});
