import { PassThrough } from "node:stream";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import type {
  Harness,
  HarnessCommand,
  HarnessSnapshot,
  ProviderClient,
} from "../src/index.js";
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

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function latestVisibleFrame(frames: readonly string[]): string {
  return frames.findLast((frame) => frame.trim() !== "") ?? "";
}

async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("model picker application", () => {
  it("updates the status bar after applying a new Reasoning Effort", async () => {
    let snapshot: HarnessSnapshot = {
      status: "idle",
      sessionId: "session-1",
      cwd: "/workspace",
      messages: [],
      pending: null,
      model: "deepseek-v4-flash",
      reasoningEffort: "minimal",
      contextWindow: 128_000,
      sessionTotalTokens: 0,
    };
    const provider = {
      type: "openai-completion",
    } as ProviderClient;
    const harness: Harness = {
      async dispatch(command: HarnessCommand) {
        if (command.type === "configure-model") {
          snapshot = {
            ...snapshot,
            model: command.model,
            reasoningEffort: command.reasoningEffort,
            contextWindow: command.contextWindow,
          };
        }
        return { ok: true };
      },
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    };
    const stdin = terminalInput();
    const frames: string[] = [];
    const stdout = terminalOutput((chunk) => frames.push(stripAnsi(chunk)));
    const instance = render(
      <TuiApp
        harness={harness}
        inputHistory={[]}
        startNewSession={() => harness}
        modelCatalog={{
          defaultProviderAlias: "deepseek",
          preferredModel: "deepseek-v4-flash",
          preferredReasoningEffort: "minimal",
          providers: [
            {
              alias: "deepseek",
              type: "openai-completion",
              models: [{ id: "deepseek-v4-flash" }],
            },
          ],
        }}
        applyModelSelection={async (selection) => ({
          ok: true,
          command: {
            type: "configure-model",
            provider,
            model: selection.model,
            reasoningEffort: selection.reasoningEffort,
            contextWindow: 128_000,
            maxOutputTokens: 16_384,
          },
        })}
      />,
      { stdin, stdout, interactive: true, patchConsole: false },
    );

    await instance.waitUntilRenderFlush();
    await flushEffects();
    stdin.push("/model");
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(latestVisibleFrame(frames)).toContain("/model");
    stdin.push("\r");
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(latestVisibleFrame(frames)).toContain("模型选择");
    stdin.push("\u001B[C");
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(latestVisibleFrame(frames)).toContain("Reasoning Effort：low");
    stdin.push("\r");
    await flushEffects();
    await instance.waitUntilRenderFlush();

    expect(snapshot.reasoningEffort).toBe("low");
    expect(latestVisibleFrame(frames)).toContain("deepseek-v4-flash · low");

    instance.unmount();
    await instance.waitUntilExit();
  });
});
