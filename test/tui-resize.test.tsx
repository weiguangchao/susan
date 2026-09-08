import { PassThrough } from "node:stream";
import { Terminal } from "@xterm/headless";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import type { Harness, HarnessEvent, HarnessSnapshot } from "../src/index.js";
import { TuiApp } from "../src/index.js";
import { createFullscreenTuiOutput } from "../src/ui/terminal-output.js";

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

function streamingHarness(overrides: Partial<HarnessSnapshot> = {}): {
  readonly harness: Harness;
  readonly emit: (event: HarnessEvent) => void;
} {
  let snapshot: HarnessSnapshot = {
    ...idleHarness().getSnapshot(),
    status: "running",
    sessionTotalTokens: 12_345,
    ...overrides,
  };
  const listeners = new Set<(event: HarnessEvent) => void>();
  return {
    harness: {
      async dispatch() {
        return { ok: true };
      },
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(event) {
      if (event.type === "agent-loop-completed") {
        snapshot = { ...snapshot, status: "idle" };
      } else if (event.type === "text-delta") {
        snapshot = { ...snapshot, status: "running" };
      }
      for (const listener of listeners) {
        listener(event);
      }
    },
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
  it("does not commit the status bar to scrollback when the terminal shrinks during streaming", async () => {
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 200,
      allowProposedApi: true,
      convertEol: true,
      scrollOnEraseInDisplay: true,
    });
    const pendingWrites: Promise<void>[] = [];
    const stdin = terminalInput();
    const stdout = terminalOutput((chunk) => {
      const terminalOutput = chunk.replaceAll("\u001B[3J", "");
      pendingWrites.push(
        new Promise<void>((resolve) => terminal.write(terminalOutput, resolve)),
      );
    });
    const { harness, emit } = streamingHarness();
    const inkStdout = createFullscreenTuiOutput(stdout);
    const instance = render(
      <TuiApp
        harness={harness}
        inputHistory={[]}
        startNewSession={() => harness}
        modelCatalog={modelCatalog}
        applyModelSelection={async () => ({ ok: false, message: "not used" })}
      />,
      {
        stdin,
        stdout: inkStdout,
        interactive: true,
        patchConsole: false,
        incrementalRendering: true,
      },
    );

    try {
      await instance.waitUntilRenderFlush();
      await Promise.all(pendingWrites.splice(0));
      emit({ type: "text-delta", textDelta: "streaming output" });
      await instance.waitUntilRenderFlush();
      await Promise.all(pendingWrites.splice(0));

      terminal.resize(80, 18);
      const resized = stdout as NodeJS.WriteStream & { rows: number };
      resized.rows = 18;
      resized.emit("resize");
      await flushEffects();
      await instance.waitUntilRenderFlush();
      await Promise.all(pendingWrites.splice(0));

      const statusLines = Array.from(
        { length: terminal.buffer.active.length },
        (_, index) => ({
          index,
          text: terminal.buffer.active
            .getLine(index)
            ?.translateToString(true) ?? "",
        }),
      ).filter(({ text }) => text.includes("gpt-5-codex · high"));
      expect(
        statusLines.filter(({ index }) => index < terminal.buffer.active.baseY),
      ).toEqual([]);
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      terminal.dispose();
    }
  });

  it.each([
    { lines: 25, rounds: 1, scroll: false },
    { lines: 60, rounds: 2, scroll: true },
  ])("keeps status out of streamed history ($lines lines, $rounds rounds, scroll=$scroll)", async ({ lines, rounds, scroll }) => {
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 1000,
      allowProposedApi: true,
      convertEol: true,
      scrollOnEraseInDisplay: true,
    });
    const pendingWrites: Promise<void>[] = [];
    const stdin = terminalInput();
    const stdout = terminalOutput((chunk) => {
      pendingWrites.push(
        new Promise<void>((resolve) => terminal.write(chunk, resolve)),
      );
    });
    const { harness, emit } = streamingHarness({
      model: "deepseek-v4-flash",
      reasoningEffort: "low",
      contextWindow: 128_000,
      sessionTotalTokens: 118_144,
    });
    const instance = render(
      <TuiApp
        harness={harness}
        inputHistory={[]}
        startNewSession={() => harness}
        modelCatalog={modelCatalog}
        applyModelSelection={async () => ({ ok: false, message: "not used" })}
      />,
      {
        stdin,
        stdout: createFullscreenTuiOutput(stdout),
        interactive: true,
        patchConsole: false,
        incrementalRendering: true,
      },
    );
    async function flush() {
      // Install subscriptions and apply event updates before flushing Ink.
      await flushEffects();
      await instance.waitUntilRenderFlush();
      await Promise.all(pendingWrites.splice(0));
    }
    const bufferLines = () => Array.from(
      { length: terminal.buffer.active.length },
      (_, index) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? "",
    );
    const modelLabel = "deepseek-v4-flash · low";
    const usageLabel = "92.3%/118k";
    const expectedLines: string[] = [];
    try {
      await flush();
      for (let round = 0; round < rounds; round++) {
        const textLines = Array.from({ length: lines }, (_, index) =>
          `项目介绍 ${round}/${index}：TypeScript 与 Ink 构建终端界面。`,
        );
        expectedLines.push(...textLines);
        const chunks = scroll
          ? textLines.map((line) => `${line}\n`)
          : [textLines.join("\n") + "\n"];
        for (const [index, textDelta] of chunks.entries()) {
          if (scroll) {
            terminal.scrollLines(index % 2 === 0 ? -8 : 4);
          }
          emit({ type: "text-delta", textDelta });
          await flush();
          expect(
            bufferLines().filter((line) => line.includes(modelLabel)),
          ).toHaveLength(1);
        }
        emit({ type: "agent-loop-completed" });
        await flush();
        const buffer = bufferLines();
        expect(
          buffer[terminal.buffer.active.baseY + terminal.rows - 1],
        ).toContain(modelLabel);
        const history = buffer.slice(0, terminal.buffer.active.baseY).join("\n");
        expect(history).not.toContain(modelLabel);
        expect(history).not.toContain(usageLabel);
        expect(buffer.filter((line) => line.includes(modelLabel))).toHaveLength(1);
        expect(buffer.filter((line) => line.includes(usageLabel))).toHaveLength(1);
        for (const line of expectedLines) {
          expect(history.split(line)).toHaveLength(2);
        }
        const cursorLine = terminal.buffer.active.getLine(
          terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
        )?.translateToString(true);
        expect(cursorLine).toContain("❯");
        stdin.write("你好");
        await flush();
        expect(terminal.buffer.active.cursorX).toBe(4 + (round + 1) * 4);
        expect(terminal.buffer.active.cursorY).toBe(terminal.rows - 3);
        stdin.write("\u001B[D");
        await flush();
        expect(terminal.buffer.active.cursorX).toBe(4 + (round + 1) * 4 - 2);
        expect(terminal.buffer.active.cursorY).toBe(terminal.rows - 3);
        stdin.write("\u001B[C");
        await flush();
      }
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      terminal.dispose();
    }
  });

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
