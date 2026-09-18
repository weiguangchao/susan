import { terminalInput, terminalOutput, stripAnsi, latestVisibleFrame, flushEffects } from "./terminal-fixture";
import { unusedAssembly } from "./tui-assembly-fixture";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import type { Harness, HarnessCommand, HarnessSnapshot, ProviderClient } from "@weiguangchao/susan-harness";
import { TuiApp } from "../src/index";

describe("model picker application", () => {
  it("clears an abbreviated menu query before opening and cancelling the model picker", async () => {
    const snapshot: HarnessSnapshot = {
      status: "idle",
      sessionId: "session-1",
      cwd: "/workspace",
      messages: [],
      pending: null,
      model: "deepseek-v4-flash",
      reasoningEffort: "minimal",
      contextWindow: 128_000,
      contextTokens: 0,
      sessionTotalTokens: 0,
      sessionInputTokens: 0,
      sessionCachedInputTokens: 0,
    };
    const dispatchedCommands: HarnessCommand[] = [];
    const harness: Harness = {
      async compact() { return { ok: true as const }; },
      async dispatch(command) {
        dispatchedCommands.push(command);
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
        assembly={unusedAssembly}
        modelCatalog={{
          defaultProviderAlias: "deepseek",
          preferredModel: "deepseek-v4-flash",
          preferredReasoningEffort: "minimal",
          providers: [{
            alias: "deepseek",
            type: "openai-completion",
            models: [{ id: "deepseek-v4-flash" }],
          }],
        }}
      />,
      { stdin, stdout, interactive: true, patchConsole: false },
    );

    await instance.waitUntilRenderFlush();
    stdin.push("/m");
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(latestVisibleFrame(frames)).toContain("/m");
    stdin.push("\r");
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(latestVisibleFrame(frames)).toContain("Provider");
    expect(latestVisibleFrame(frames)).toContain("deepseek");
    expect(latestVisibleFrame(frames)).not.toContain("❯ /m");
    const framesBeforeCancel = frames.length;
    stdin.push("\u001B");
    await flushEffects();
    await instance.waitUntilRenderFlush();
    const framesAfterCancel = frames.slice(framesBeforeCancel);
    expect(framesAfterCancel.some((frame) => frame.includes("❯ /m"))).toBe(false);

    stdin.push("\r");
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(dispatchedCommands).toEqual([]);

    instance.unmount();
    await instance.waitUntilExit();
  });

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
      contextTokens: 0,
      sessionTotalTokens: 0,
      sessionInputTokens: 0,
      sessionCachedInputTokens: 0,
    };
    const provider = {
      type: "openai-completion",
    } as ProviderClient;
    const harness: Harness = {
      async compact() { return { ok: true as const }; },
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
        assembly={{
          ...unusedAssembly,
          async applyModelSelection(selection) {
            snapshot = { ...snapshot, model: selection.model, reasoningEffort: selection.reasoningEffort };
            return { kind: "updated", config: {
              defaultProvider: selection.providerAlias, defaultModel: selection.model,
              defaultReasoningEffort: selection.reasoningEffort,
              providers: [{ alias: "deepseek", type: "openai-completion", host: "example.test", models: [{ id: "deepseek-v4-flash" }] }],
            } };
          },
        }}
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
    expect(latestVisibleFrame(frames)).toContain("Provider");
    stdin.push("\u001B[C");
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(latestVisibleFrame(frames)).toContain("Reasoning Effort");
    expect(latestVisibleFrame(frames)).toContain("low");
    stdin.push("\r");
    await flushEffects();
    await instance.waitUntilRenderFlush();

    expect(snapshot.reasoningEffort).toBe("low");
    expect(latestVisibleFrame(frames)).toContain("deepseek-v4-flash · low");

    instance.unmount();
    await instance.waitUntilExit();
  });

  it("shows a five-row model window with overflow hints", async () => {
    const snapshot: HarnessSnapshot = {
      status: "idle",
      sessionId: "session-1",
      cwd: "/workspace",
      messages: [],
      pending: null,
      model: "model-0",
      reasoningEffort: "minimal",
      contextWindow: 128_000,
      contextTokens: 0,
      sessionTotalTokens: 0,
      sessionInputTokens: 0,
      sessionCachedInputTokens: 0,
    };
    const harness: Harness = {
      async compact() { return { ok: true as const }; },
      async dispatch() {
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
        assembly={unusedAssembly}
        modelCatalog={{
          defaultProviderAlias: "deepseek",
          preferredModel: "model-0",
          preferredReasoningEffort: "minimal",
          providers: [
            {
              alias: "deepseek",
              type: "openai-completion",
              baseURL: "api.deepseek.com",
              models: Array.from({ length: 9 }, (_, index) => ({
                id: `model-${index}`,
              })),
            },
          ],
        }}
      />,
      { stdin, stdout, interactive: true, patchConsole: false },
    );

    await instance.waitUntilRenderFlush();
    stdin.push("/model");
    await flushEffects();
    await instance.waitUntilRenderFlush();
    stdin.push("\r");
    await flushEffects();
    await instance.waitUntilRenderFlush();

    const opened = latestVisibleFrame(frames);
    expect(opened).toContain("› model-0");
    expect(opened).toContain("model-4");
    expect(opened).not.toContain("model-5");
    expect(opened).toContain("下方还有 4 个");
    expect(opened).toContain("api.deepseek.com");

    for (let index = 0; index < 5; index += 1) {
      stdin.push("\u001B[B");
      await flushEffects();
      await instance.waitUntilRenderFlush();
    }

    const scrolled = latestVisibleFrame(frames);
    expect(scrolled).toContain("› model-5");
    expect(scrolled).not.toContain("› model-0");
    expect(scrolled).toContain("上方还有 1 个");
    expect(scrolled).toContain("下方还有 3 个");

    instance.unmount();
    await instance.waitUntilExit();
  });
});
