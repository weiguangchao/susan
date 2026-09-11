import { PassThrough } from "node:stream";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import type {
  Harness,
  HarnessEvent,
  HarnessSnapshot,
  ProviderClient,
} from "../src/index.js";
import { TuiApp } from "../src/index.js";
import { createTuiOutput } from "../src/ui/terminal-output.js";

const SHOW_CURSOR = "\u001B[?25h";
const REVERSE_VIDEO = "\u001B[7m";
const UNDERLINE_CURSOR = "\u001B[4 q";

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

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
  output.rows = TERMINAL_ROWS;
  output.on("data", (chunk: Buffer) => onWrite(chunk.toString("utf8")));
  return output as unknown as NodeJS.WriteStream;
}

async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function idleSnapshot(
  overrides: Partial<HarnessSnapshot> = {},
): HarnessSnapshot {
  return {
    status: "idle",
    sessionId: "session-1",
    cwd: "/workspace",
    messages: [],
    pending: null,
    model: "gpt-5-codex",
    reasoningEffort: "high",
    contextWindow: 418_000,
    contextTokens: 0,
    sessionTotalTokens: 0,
    sessionInputTokens: 0,
    sessionCachedInputTokens: 0,
    ...overrides,
  };
}

function createEventHarness(initial: HarnessSnapshot = idleSnapshot()) {
  let snapshot = initial;
  const listeners = new Set<(event: HarnessEvent) => void>();
  const harness: Harness = {
    async compact() { return { ok: true as const }; },
    async dispatch() {
      return { ok: true };
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return { harness };
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

const provider = {
  type: "openai-completion",
} as ProviderClient;

type ImeCursorPlacement = {
  readonly x: number;
  readonly y: number;
};

function parseVisualCursorPlacement(
  raw: string,
  rows: number,
): ImeCursorPlacement | undefined {
  const showAt = raw.lastIndexOf(SHOW_CURSOR);
  if (showAt === -1) {
    return undefined;
  }
  const prefix = raw.slice(0, showAt);
  const match = prefix.match(/(?:\u001B\[(\d*)A)?\u001B\[(\d+)G$/);
  if (match === null) {
    return undefined;
  }
  const moveUp = match[1] === undefined || match[1] === "" ? 0 : Number(match[1]);
  const column = Number(match[2]);
  if (!Number.isInteger(moveUp) || !Number.isInteger(column) || column < 1) {
    return undefined;
  }
  // Fullscreen frames have no trailing newline. The output adapter
  // positions the cursor relative to the real last row (rows - 1).
  return { x: column - 1, y: rows - 1 - moveUp };
}

const TERMINAL_ROWS = 24;

function visibleLines(frame: string): string[] {
  return stripAnsi(frame)
    .replace(/\n$/, "")
    .split("\n");
}

function lastFrameLines(raw: string, rows: number): string[] {
  return visibleLines(raw).slice(-rows);
}

async function renderIdleTui(): Promise<{
  readonly raw: string;
  readonly lines: readonly string[];
}> {
  const chunks: string[] = [];
  const stdin = terminalInput();
  const stdout = terminalOutput((chunk) => chunks.push(chunk));
  const { harness } = createEventHarness();
  const instance = render(
    <TuiApp
      harness={harness}
      inputHistory={[]}
      startNewSession={() => harness}
      modelCatalog={modelCatalog}
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
    { stdin, stdout: createTuiOutput(stdout), interactive: true, patchConsole: false },
  );

  await instance.waitUntilRenderFlush();
  await flushEffects();
  await instance.waitUntilRenderFlush();

  const raw = chunks.join("");
  instance.unmount();
  await instance.waitUntilExit();
  return { raw, lines: lastFrameLines(raw, TERMINAL_ROWS) };
}

describe("TUI IME cursor", () => {
  it("places the real terminal cursor inside the input box on the caret row", async () => {
    const { raw, lines } = await renderIdleTui();
    const inputRow = lines.findIndex((line) => line.includes("❯"));
    const topBorder = lines.findIndex((line) => line.includes("╭"));
    const bottomBorder = lines.findIndex((line) => line.includes("╰"));
    const statusRow = lines.findLastIndex((line) => /high|未设置/.test(line));
    const placement = parseVisualCursorPlacement(raw, TERMINAL_ROWS);

    expect(statusRow, "empty startup places the footer on the last terminal row")
      .toBe(TERMINAL_ROWS - 1);
    expect(inputRow).toBeGreaterThanOrEqual(0);
    expect(statusRow).toBe(lines.length - 1);
    expect(lines[statusRow]).toContain("high");
    expect(placement, "IME follows the real cursor; it must sit inside the input box").toEqual({
      x: 4,
      y: inputRow,
    });
    expect(topBorder).toBeGreaterThanOrEqual(0);
    expect(bottomBorder).toBeGreaterThan(topBorder);
    expect(inputRow).toBeGreaterThan(topBorder);
    expect(inputRow).toBeLessThan(bottomBorder);
    expect(placement?.y).toBeGreaterThan(topBorder);
    expect(placement?.y).toBeLessThan(bottomBorder);
    expect(placement?.y).not.toBe(statusRow);
    expect(
      raw.includes(REVERSE_VIDEO),
      "inverse caret stacks on the real cursor and makes it two cells tall",
    ).toBe(false);
    expect(
      raw.includes(UNDERLINE_CURSOR),
      "underline cursor keeps only the lower half and lets IME put candidates above preedit",
    ).toBe(true);
  });
});
