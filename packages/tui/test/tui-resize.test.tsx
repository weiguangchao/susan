import { unusedAssembly } from "./tui-assembly-fixture";
import { PassThrough } from "node:stream";
import { Terminal } from "@xterm/headless";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import type { Harness, HarnessEvent, HarnessSnapshot } from "@weiguangchao/susan-harness";
import { TuiApp } from "../src/index";
import { WORKING_SPINNER_FRAMES } from "../src/ui/tui";
import { createTuiOutput } from "../src/ui/terminal-output";

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
    contextTokens: 0,
    sessionTotalTokens: 0,
    sessionInputTokens: 0,
    sessionCachedInputTokens: 0,
  };
  return {
    async compact() { return { ok: true as const }; },
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
    contextTokens: 12_345,
    sessionTotalTokens: 12_345,
    sessionInputTokens: 9_876,
    sessionCachedInputTokens: 0,
    ...overrides,
  };
  const listeners = new Set<(event: HarnessEvent) => void>();
  return {
    harness: {
      async compact() { return { ok: true as const }; },
      async dispatch(command) {
        if (command.type === "submit") snapshot = { ...snapshot, status: "running" };
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

function isWorkingActivityLine(line: string, label: string): boolean {
  return WORKING_SPINNER_FRAMES.some((frame) => {
    const trimmed = line.trim();
    const prefix = `${frame} ${label}`;
    return trimmed === prefix || trimmed.startsWith(`${prefix} · `);
  });
}

function workingActivityRow(lines: readonly string[], label: string): number {
  return lines.findIndex((line) => isWorkingActivityLine(line, label));
}

async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("TUI terminal resize", () => {
  it.each<HarnessEvent>([
    { type: "reasoning-delta", textDelta: "检查结果" },
    { type: "text-delta", textDelta: "直接回答" },
    { type: "tool-call-delta", index: 0, id: "next", name: "ls", argumentsDelta: "{}" },
    { type: "tool-started", toolCall: { id: "next", name: "ls", arguments: {} } },
    { type: "agent-loop-completed" },
    { type: "agent-loop-interrupted" },
    { type: "harness-failed", error: { code: "HARNESS_SESSION", message: "fixture failure" } },
    { type: "interrupted-response", response: { content: "partial" },
      failure: { code: "PROVIDER_HTTP", message: "busy", httpStatus: 429, hadSemanticOutput: true } },
    { type: "provider-retrying", retry: 1, maxRetries: 2, delayMs: 2000,
      failure: { code: "PROVIDER_HTTP", message: "busy", httpStatus: 429, hadSemanticOutput: false } },
    { type: "provider-failed",
      failure: { code: "PROVIDER_HTTP", message: "busy", httpStatus: 429, hadSemanticOutput: false } },
  ])("shows one continuous execution wait and handles $type", async (event) => {
    const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true, convertEol: true });
    const pendingWrites: Promise<void>[] = [];
    const stdout = terminalOutput(chunk => {
      pendingWrites.push(new Promise<void>(resolve => terminal.write(chunk, resolve)));
    });
    const { harness, emit } = streamingHarness();
    const instance = render(<TuiApp harness={harness} inputHistory={[]}
      assembly={unusedAssembly} modelCatalog={modelCatalog} />,
      { stdin: terminalInput(), stdout: createTuiOutput(stdout), interactive: true,
        patchConsole: false, incrementalRendering: true });
    async function screen() {
      await flushEffects();
      await instance.waitUntilRenderFlush();
      await Promise.all(pendingWrites.splice(0));
      return Array.from({ length: terminal.buffer.active.length }, (_, i) =>
        terminal.buffer.active.getLine(i)?.translateToString(true).trim() ?? "");
    }
    try {
      expect((await screen()).some((line) => isWorkingActivityLine(line, "Working"))).toBe(false);
      const toolCall = { id: "call", name: "read", arguments: { path: "README.md" } };
      emit({ type: "reasoning-delta", textDelta: "先检查" });
      emit({ type: "tool-call-delta", index: 0, id: "call", name: "read", argumentsDelta: '{"path":"README.md"}' });
      let generating = await screen();
      expect(generating.some((line) => isWorkingActivityLine(line, "Thinking"))).toBe(true);
      expect(generating.join("\n")).not.toContain("README.md");
      emit({ type: "tool-started", toolCall });
      expect((await screen()).filter((line) => isWorkingActivityLine(line, "Working"))).toHaveLength(1);
      emit({ type: "tool-completed", toolCall, result: { content: [{ type: "text", text: "retained result" }] }, isError: false });
      expect((await screen()).filter((line) => isWorkingActivityLine(line, "Working"))).toHaveLength(1);
      emit({ type: "tool-batch-completed", toolCalls: [toolCall] });
      let lines = await screen();
      let waitingRow = workingActivityRow(lines, "Working");
      const reasoningRow = lines.indexOf("先检查");
      expect(reasoningRow).toBeGreaterThan(-1);
      expect(lines[reasoningRow + 1]).toBe("");
      expect(lines[reasoningRow + 2]).toContain("read README.md");
      expect(waitingRow).toBe(lines.findIndex(line => line.includes("retained result")) + 2);
      expect(waitingRow).toBeGreaterThan(lines.findIndex(line => line.includes("retained result")));
      expect(waitingRow).toBeGreaterThan(-1);
      for (const [columns, rows] of [[80, 12], [80, 24], [100, 30], [80, 24], [40, 16], [80, 24]] as const) {
        terminal.resize(columns, rows);
        stdout.columns = columns;
        stdout.rows = rows;
        stdout.emit("resize");
        lines = await screen();
        expect(lines.filter((line) => isWorkingActivityLine(line, "Working"))).toHaveLength(1);
        expect(lines.filter(line => line.includes("retained result"))).toHaveLength(1);
      }
      waitingRow = workingActivityRow(lines, "Working");
      if (process.env.FORCE_COLOR === "3") {
        const label = terminal.buffer.active.getLine(waitingRow)!;
        expect(label.getCell(1)?.isBold()).toBeTruthy();
        expect(new Set(Array.from({ length: "Working".length }, (_, i) => label.getCell(i + 3)?.getFgColor())).size).toBe(1);
      }
      emit(event);
      lines = await screen();
      if (event.type === "reasoning-delta") expect(workingActivityRow(lines, "Thinking")).toBe(waitingRow);
      if (event.type === "text-delta") expect(lines).toContain("直接回答▍");
      expect(lines.filter((line) => isWorkingActivityLine(line, "Working"))).toHaveLength(event.type === "tool-started" ? 1 : 0);
      if (event.type === "tool-call-delta") {
        expect(lines.some((line) => isWorkingActivityLine(line, "Thinking"))).toBe(true);
        expect(lines.join("\n")).not.toContain("ls ·");
      }
      if (event.type === "reasoning-delta" || event.type === "text-delta") {
        for (const [columns, rows] of [[40, 16], [100, 30], [80, 18]] as const) {
          terminal.resize(columns, rows);
          Object.assign(stdout, { columns, rows });
          stdout.emit("resize");
          lines = await screen();
          expect(lines.some((line) => isWorkingActivityLine(line, "Working"))).toBe(false);
          expect(lines.filter(line => line.includes("retained result"))).toHaveLength(1);
          const content = event.type === "reasoning-delta" ? "检查结果▍" : "直接回答▍";
          expect(lines.filter(line => line === content)).toHaveLength(1);
          expect(lines.filter((line) => isWorkingActivityLine(line, "Thinking"))).toHaveLength(event.type === "reasoning-delta" ? 1 : 0);
          expect(lines.filter(line => line.includes("gpt-5-codex · high"))).toHaveLength(1);
        }
      }
    } finally {
      instance.unmount();
      terminal.dispose();
    }
  });

  it.each([
    { type: "text-delta", toolCount: 18 },
    { type: "reasoning-delta", toolCount: 18 },
    { type: "text-delta", toolCount: 20 },
    { type: "reasoning-delta", toolCount: 20 },
  ] as const)("scrolls $toolCount completed tools upward while $type grows", async ({ type, toolCount }) => {
    const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 1000,
      allowProposedApi: true, convertEol: true });
    const pendingWrites: Promise<void>[] = [];
    const stdout = terminalOutput(chunk => {
      pendingWrites.push(new Promise<void>(resolve => terminal.write(chunk, resolve)));
    });
    const { harness, emit } = streamingHarness();
    const instance = render(<TuiApp harness={harness} inputHistory={[]}
      assembly={unusedAssembly} modelCatalog={modelCatalog} />,
      { stdin: terminalInput(), stdout: createTuiOutput(stdout), interactive: true,
        patchConsole: false, incrementalRendering: true });
    async function flush() {
      await flushEffects();
      await instance.waitUntilRenderFlush();
      await Promise.all(pendingWrites.splice(0));
    }
    const buffer = () => Array.from({ length: terminal.buffer.active.length }, (_, i) =>
      terminal.buffer.active.getLine(i)?.translateToString(true) ?? "");
    try {
      await flush();
      const toolCalls = Array.from({ length: toolCount }, (_, i) => ({
        id: `call-${i}`, name: "read", arguments: { path: `file-${i}.md` },
      }));
      for (const toolCall of toolCalls) {
        emit({ type: "tool-started", toolCall });
        emit({ type: "tool-completed", toolCall, result: { content: [{ type: "text", text: "fixture" }] }, isError: true });
      }
      emit({ type: "tool-batch-completed", toolCalls });
      await flush();
      const initialBase = terminal.buffer.active.baseY;
      for (let i = 0; i < 8; i++) {
        emit({ type, textDelta: `stream-row-${i}\n` });
        await flush();
        const visible = buffer().slice(terminal.buffer.active.baseY).join("\n");
        for (let j = 0; j <= i; j++) {
          expect(visible, "stream expands into rows previously occupied by completed tools")
            .toContain(`stream-row-${j}`);
        }
      }
      expect(terminal.buffer.active.baseY, "tools scroll before the stream completes").toBeGreaterThan(initialBase);
      emit({ type: "agent-loop-completed" });
      await flush();
      const completed = buffer().join("\n");
      for (const tool of toolCalls) expect(completed.split(tool.arguments.path)).toHaveLength(2);
      for (let i = 0; i < 8; i++) expect(completed.split(`stream-row-${i}`)).toHaveLength(2);
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      terminal.dispose();
    }
  });

  it.each(["text-delta", "reasoning-delta", "tool-completed"] as const)(
    "keeps one shared input gap while %s fills and overflows the output area",
    async (type) => {
      const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 1000,
        allowProposedApi: true, convertEol: true });
      const pendingWrites: Promise<void>[] = [];
      const stdout = terminalOutput(chunk => {
        pendingWrites.push(new Promise<void>(resolve => terminal.write(chunk, resolve)));
      });
      const { harness, emit } = streamingHarness();
      const instance = render(<TuiApp harness={harness} inputHistory={[]}
        assembly={unusedAssembly} modelCatalog={modelCatalog} />,
        { stdin: terminalInput(), stdout: createTuiOutput(stdout), interactive: true,
          patchConsole: false, incrementalRendering: true });
      async function flush() {
        await flushEffects();
        await instance.waitUntilRenderFlush();
        await Promise.all(pendingWrites.splice(0));
      }
      function visibleRows() {
        return Array.from({ length: terminal.rows }, (_, index) =>
          terminal.buffer.active.getLine(terminal.buffer.active.baseY + index)
            ?.translateToString(true).trim() ?? "");
      }
      function assertInputGap() {
        const visible = visibleRows();
        const inputTop = visible.findIndex(line => line.startsWith("╭"));
        const lastOutput = visible.slice(0, inputTop).findLastIndex(line => line !== "");
        expect(inputTop, "input stays at the bottom").toBe(terminal.rows - 4);
        expect(inputTop - lastOutput - 1, "all output shares exactly one footer gap").toBe(1);
      }
      try {
        await flush();
        // Fill the screen with completed history so each new output row must
        // reclaim space from it, exposing inflated live-height calculations.
        const toolCalls = Array.from({ length: 12 }, (_, index) => ({
          id: `history-${index}`, name: "read", arguments: { path: `history-${index}.md` },
        }));
        for (const toolCall of toolCalls) {
          emit({ type: "tool-started", toolCall });
          emit({ type: "tool-completed", toolCall,
            result: { content: [{ type: "text", text: "history content" }] }, isError: false });
        }
        emit({ type: "tool-batch-completed", toolCalls });
        await flush();
        for (let index = 0; index < 10; index++) {
          if (type === "tool-completed") {
            const toolCall = { id: `live-${index}`, name: "read",
              arguments: { path: `live-${index}.md` } };
            emit({ type: "tool-started", toolCall });
            emit({ type, toolCall,
              result: { content: [{ type: "text", text: `result-${index}\n\nresult-end-${index}` }] }, isError: false });
          } else {
            emit({ type, textDelta: `${index === 0 ? "" : "\n"}paragraph-${index}\n\nend-${index}` });
          }
          await flush();
          assertInputGap();
          if (type !== "tool-completed") {
            const visible = visibleRows();
            const paragraph = visible.indexOf(`paragraph-${index}`);
            expect(paragraph).toBeGreaterThanOrEqual(0);
            expect(visible.slice(paragraph, paragraph + 2)).toEqual([
              `paragraph-${index}`, `end-${index}▍`,
            ]);
          }
        }
        for (const rows of [18, 30]) {
          terminal.resize(80, rows);
          stdout.rows = rows;
          stdout.emit("resize");
          await flush();
          assertInputGap();
        }
      } finally {
        instance.unmount();
        await instance.waitUntilExit();
        terminal.dispose();
      }
    },
  );

  it("uses remaining output space before scrolling completed tools", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 1000,
      allowProposedApi: true, convertEol: true });
    const pendingWrites: Promise<void>[] = [];
    const stdout = terminalOutput((chunk) => {
      pendingWrites.push(new Promise<void>((resolve) => terminal.write(chunk, resolve)));
    });
    const { harness, emit } = streamingHarness({ status: "idle" });
    const stdin = terminalInput();
    const instance = render(<TuiApp harness={harness} inputHistory={[]}
      assembly={unusedAssembly} modelCatalog={modelCatalog} />,
      { stdin, stdout: createTuiOutput(stdout), interactive: true,
        patchConsole: false, incrementalRendering: true });
    async function flush() {
      await flushEffects();
      await instance.waitUntilRenderFlush();
      await Promise.all(pendingWrites.splice(0));
    }
    try {
      await flush();
      stdin.write("检查文件");
      await flush();
      stdin.write("\r");
      await flush();
      for (let index = 0; index < 12; index++) {
        const toolCall = { id: `space-${index}`, name: "read", arguments: { path: `space-${index}.md` } };
        emit({ type: "tool-started", toolCall });
        await flush();
        emit({ type: "tool-completed", toolCall,
          result: { content: [{ type: "text", text: `content-${index}` }] }, isError: false });
        await flush();
        if (index < 3) {
          expect(terminal.buffer.active.baseY, "short results must consume blank rows before scrolling").toBe(0);
        }
        expect(terminal.buffer.active.getLine(terminal.buffer.active.baseY + 23)?.translateToString(true)).toContain("gpt-5-codex");
        const baseBeforeBatch = terminal.buffer.active.baseY;
        emit({ type: "tool-batch-completed", toolCalls: [toolCall] });
        await flush();
        expect(terminal.buffer.active.baseY).toBe(baseBeforeBatch);
      }
      expect(terminal.buffer.active.baseY, "overflow must still scroll").toBeGreaterThan(0);
      const history = Array.from({ length: terminal.buffer.active.length }, (_, i) =>
        terminal.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\n");
      for (let index = 0; index < 12; index++) {
        expect(history.split(`read space-${index}.md`)).toHaveLength(2);
      }
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      await Promise.all(pendingWrites.splice(0));
      terminal.dispose();
    }
  });

  it("hides streamed calls and preserves reasoning before completed results", async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 1000,
      allowProposedApi: true, convertEol: true });
    const pendingWrites: Promise<void>[] = [];
    const stdout = terminalOutput((chunk) => {
      pendingWrites.push(new Promise<void>((resolve) => terminal.write(chunk, resolve)));
    });
    const { harness, emit } = streamingHarness({ status: "idle" });
    const stdin = terminalInput();
    const instance = render(<TuiApp harness={harness} inputHistory={[]}
      assembly={unusedAssembly} modelCatalog={modelCatalog} />,
      { stdin, stdout: createTuiOutput(stdout), interactive: true,
        patchConsole: false, incrementalRendering: true });
    async function flush() {
      await flushEffects();
      await instance.waitUntilRenderFlush();
      await Promise.all(pendingWrites.splice(0));
    }
    const expected: string[] = [];
    function assertOrder(stage: string) {
      const lines = Array.from({ length: terminal.buffer.active.length }, (_, i) =>
        terminal.buffer.active.getLine(i)?.translateToString(true) ?? "");
      let previous = -1;
      for (const content of expected) {
        const matches = lines.flatMap((line, index) => line.includes(content) && index > previous ? [index] : []);
        expect(matches, `${stage}: ${content}`).toHaveLength(1);
        expect(matches[0], `${stage}: ${content}`).toBeGreaterThan(previous);
        previous = matches[0]!;
      }
    }
    try {
      await flush();
      stdin.write("介绍当前项目");
      await flush();
      stdin.write("\r");
      await flush();
      expected.push("▌ 介绍当前项目");
      for (let round = 0; round < 2; round++) {
        emit({ type: "reasoning-delta", textDelta: `检查项目结构 ${round}` });
        await flush();
        if (round === 0) {
          const lines = Array.from({ length: terminal.buffer.active.length }, (_, i) =>
            terminal.buffer.active.getLine(i)?.translateToString(true) ?? "");
          expect(lines.some((line) => isWorkingActivityLine(line, "Thinking")),
            "streaming reasoning shows the working label").toBe(true);
          expect(lines.some((line) => line.trim() === "检查项目结构 0▍"),
            "stream reasoning renders dim content without a prefix").toBe(true);
          // Run with FORCE_COLOR=3 to also verify ANSI styles in the terminal buffer.
          if (process.env.FORCE_COLOR === "3") {
            const label = terminal.buffer.active.getLine(workingActivityRow(lines, "Thinking"))!;
            const content = terminal.buffer.active.getLine(lines.findIndex((line) => line.trim() === "检查项目结构 0▍"))!;
            expect(label.getCell(1)?.isBold()).toBeTruthy();
            expect(content.getCell(1)?.isDim()).toBeTruthy();
            expect(new Set(Array.from({ length: "Thinking".length }, (_, i) => label.getCell(i + 3)?.getFgColor())).size).toBe(1);
          }
        }
        expected.push(`检查项目结构 ${round}`);
        assertOrder("reasoning");
        emit({ type: "text-delta", textDelta: `读取项目文件 ${round}` });
        await flush();
        if (round === 0) {
          const lines = Array.from({ length: terminal.buffer.active.length }, (_, i) =>
            terminal.buffer.active.getLine(i)?.translateToString(true) ?? "");
          expect(lines.some((line) => line.trim() === "读取项目文件 0▍"),
            "stream text renders without a speaker prefix").toBe(true);
          expect(lines.some((line) => isWorkingActivityLine(line, "Thinking")),
            "Think animation stops when answer text starts").toBe(false);
          const reasoningRow = lines.findIndex((line) => line.trim() === "检查项目结构 0");
          expect(reasoningRow).toBeGreaterThan(-1);
          expect(lines[reasoningRow - 1]?.trim()).toMatch(/^Think · \d+\.\d 秒$/);
          expect(lines[reasoningRow + 1]?.trim()).toBe("");
          expect(lines[reasoningRow + 2]?.trim()).toBe("读取项目文件 0▍");
          if (process.env.FORCE_COLOR === "3") {
            expect(terminal.buffer.active.getLine(reasoningRow - 1)?.getCell(1)?.isDim()).toBeTruthy();
          }
        }
        expected.push(`读取项目文件 ${round}`);
        const toolCall = { id: `call-${round}`, name: "read", arguments: { path: `file-${round}.md` } };
        emit({ type: "tool-call-delta", index: 0, id: toolCall.id, name: toolCall.name,
          argumentsDelta: '{"path":' });
        await flush();
        assertOrder("partial arguments");
        emit({ type: "tool-call-delta", index: 0,
          argumentsDelta: `"file-${round}.md"}` });
        await flush();
        assertOrder("complete arguments");
        emit({ type: "tool-started", toolCall });
        await flush();
        assertOrder("running");
        if (round === 0) expect(terminal.buffer.active.baseY).toBe(0);
        emit({ type: "tool-completed", toolCall,
          result: { content: [{ type: "text", text: `文件内容 ${round}` }] }, isError: false });
        await flush();
        expected.push(`read file-${round}.md`);
        assertOrder("completed");
        if (round === 0) expect(terminal.buffer.active.baseY).toBe(0);
        emit({ type: "tool-batch-completed", toolCalls: [toolCall] });
        await flush();
        assertOrder("archived");
      }
      emit({ type: "text-delta", textDelta: "项目介绍完成" });
      await flush();
      expected.push("项目介绍完成");
      assertOrder("final stream");
      emit({ type: "agent-loop-completed" });
      await flush();
      assertOrder("finished");
      const completedLines = Array.from({ length: terminal.buffer.active.length }, (_, i) =>
        terminal.buffer.active.getLine(i)?.translateToString(true) ?? "");
      for (let round = 0; round < 2; round++) {
        const reasoningRow = completedLines.findIndex((line) => line.trim() === `检查项目结构 ${round}`);
        expect(completedLines[reasoningRow - 1]?.trim()).toMatch(/^Think · \d+\.\d 秒$/);
        expect(completedLines[reasoningRow + 1]?.trim()).toBe("");
        expect(completedLines[reasoningRow + 2]?.trim()).toBe(`读取项目文件 ${round}`);
      }
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      await Promise.all(pendingWrites.splice(0));
      terminal.dispose();
    }
  });

  it.each([
    { textLines: 1, rounds: 3 },
    { textLines: 30, rounds: 3 },
  ])("preserves one copy of input and completed output across $rounds Tool rounds of $textLines lines", async ({ textLines, rounds }) => {
    const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 1000,
      allowProposedApi: true, convertEol: true, scrollOnEraseInDisplay: true });
    const pendingWrites: Promise<void>[] = [];
    const stdin = terminalInput();
    const stdout = terminalOutput((chunk) => {
      pendingWrites.push(new Promise<void>((resolve) => terminal.write(chunk, resolve)));
    });
    const { harness, emit } = streamingHarness({ status: "idle" });
    const instance = render(<TuiApp harness={harness} inputHistory={[]}
      assembly={unusedAssembly} modelCatalog={modelCatalog} />,
      { stdin, stdout: createTuiOutput(stdout), interactive: true,
        patchConsole: false, incrementalRendering: true });
    async function flush() {
      await flushEffects();
      await instance.waitUntilRenderFlush();
      await Promise.all(pendingWrites.splice(0));
    }
    const archivedLines = ["▌ 介绍当前项目"];
    function assertSingleInput(stage: string) {
      const lines = Array.from({ length: terminal.buffer.active.length }, (_, i) =>
        terminal.buffer.active.getLine(i)?.translateToString(true) ?? "");
      for (const archived of archivedLines) {
        expect(lines.filter(line => line.includes(archived)), `${stage}: ${archived}`).toHaveLength(1);
      }
    }
    try {
      await flush();
      stdin.write("介绍当前项目");
      await flush();
      stdin.write("\r");
      await flush();
      assertSingleInput("submit");
      for (let round = 0; round < rounds; round++) {
        for (let line = 0; line < textLines; line++) {
          emit({ type: "text-delta", textDelta: `项目说明 ${round}/${line} 内容\n` });
          await flush();
          assertSingleInput(`stream ${round}/${line}`);
        }
        const toolCall = { id: `call-${round}`, name: "read", arguments: { path: `file-${round}.md` } };
        emit({ type: "tool-started", toolCall });
        await flush();
        archivedLines.push(...Array.from({ length: textLines }, (_, line) => `项目说明 ${round}/${line} `));
        assertSingleInput(`tool start ${round}`);
        emit({ type: "tool-completed", toolCall, result: { content: [{ type: "text", text: "fixture" }] }, isError: true });
        await flush();
        emit({ type: "tool-batch-completed", toolCalls: [toolCall] });
        await flush();
        archivedLines.push(`file-${round}.md`);
        assertSingleInput(`tool complete ${round}`);
      }
      emit({ type: "agent-loop-completed" });
      await flush();
      assertSingleInput("finished");
      for (const [columns, rows] of [[80, 18], [100, 30], [40, 16], [80, 24]] as const) {
        terminal.resize(columns, rows);
        Object.assign(stdout, { columns, rows });
        stdout.emit("resize");
        await flush();
        assertSingleInput(`resize ${columns}x${rows}`);
      }
      instance.unmount();
      await instance.waitUntilExit();
      await Promise.all(pendingWrites.splice(0));
      assertSingleInput("unmount");
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      terminal.dispose();
    }
  });

  it.each([
    { reasoningLines: 2, conclusionLines: 1 },
    { reasoningLines: 16, conclusionLines: 1 },
    { reasoningLines: 17, conclusionLines: 1 },
    { reasoningLines: 20, conclusionLines: 10 },
  ])("keeps $reasoningLines reasoning rows and $conclusionLines conclusion rows intact throughout streaming", async ({ reasoningLines, conclusionLines }) => {
    const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 1000,
      allowProposedApi: true, convertEol: true, scrollOnEraseInDisplay: true });
    const pendingWrites: Promise<void>[] = [];
    const stdin = terminalInput();
    const stdout = terminalOutput(chunk => {
      pendingWrites.push(new Promise<void>(resolve => terminal.write(chunk, resolve)));
    });
    const { harness, emit } = streamingHarness({ status: "idle" });
    const instance = render(<TuiApp harness={harness} inputHistory={[]}
      assembly={unusedAssembly} modelCatalog={modelCatalog} />,
      { stdin, stdout: createTuiOutput(stdout), interactive: true,
        patchConsole: false, incrementalRendering: true });
    async function flush() {
      await flushEffects();
      await instance.waitUntilRenderFlush();
      await Promise.all(pendingWrites.splice(0));
    }
    const reasoning = Array.from({ length: reasoningLines }, (_, i) => `推理行${i}：正在检查项目结构以及模块之间的调用关系。`);
    const conclusion = Array.from({ length: conclusionLines }, (_, i) => `结论行${i}：这是终端项目。`);
    const failures: string[] = [];
    function check(stage: string) {
      const lines = Array.from({ length: terminal.buffer.active.length }, (_, i) =>
        terminal.buffer.active.getLine(i)?.translateToString(true) ?? "");
      for (const line of lines.filter(line => /推理行|结论行/.test(line))) {
        const content = line.trim().replace(/^(reasoning|susan) ▸ /, "").replace(/▍$/, "");
        if (![...reasoning, ...conclusion].includes(content)) failures.push(`${stage}: ${line}`);
      }
    }
    try {
      await flush();
      stdin.write("介绍当前项目");
      await flush();
      stdin.write("\r");
      await flush();
      for (const line of reasoning) {
        emit({ type: "reasoning-delta", textDelta: `${line}\n` });
        await flush();
        check("reasoning");
      }
      for (const [index, line] of conclusion.entries()) {
        emit({ type: "text-delta", textDelta: `${line}\n` });
        await flush();
        check(`conclusion ${index}`);
        const visible = Array.from({ length: terminal.rows }, (_, i) =>
          terminal.buffer.active.getLine(terminal.buffer.active.baseY + i)?.translateToString(true) ?? "");
        expect(visible.join("\n"), "the latest conclusion remains visible while streaming").toContain(line);
      }
      emit({ type: "agent-loop-completed" });
      await flush();
      check("completed");
      const completed = Array.from({ length: terminal.buffer.active.length }, (_, i) =>
        terminal.buffer.active.getLine(i)?.translateToString(true) ?? "").join("\n");
      for (const line of [...reasoning, ...conclusion]) {
        expect(completed.split(line), "completed history retains every line exactly once").toHaveLength(2);
      }
      expect(failures).toEqual([]);
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      terminal.dispose();
    }
  });

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
    const inkStdout = createTuiOutput(stdout);
    const instance = render(
      <TuiApp
        harness={harness}
        inputHistory={[]}
        assembly={unusedAssembly}
        modelCatalog={modelCatalog}
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
    { rows: 16, lines: 1, rounds: 1, scroll: false },
    { rows: 24, lines: 1, rounds: 1, scroll: false },
    { rows: 40, lines: 1, rounds: 1, scroll: false },
    { rows: 24, lines: 25, rounds: 1, scroll: false },
    { rows: 24, lines: 60, rounds: 2, scroll: true },
  ])("keeps input and status after the response in normal terminal flow ($rows rows, $lines lines, $rounds rounds)", async ({ rows, lines, rounds, scroll }) => {
    const terminal = new Terminal({
      cols: 80,
      rows,
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
    Object.assign(stdout, { rows });
    const { harness, emit } = streamingHarness({
      status: "idle",
      model: "deepseek-v4-flash",
      reasoningEffort: "low",
      contextWindow: 128_000,
      contextTokens: 118_144,
      sessionTotalTokens: 118_144,
      sessionInputTokens: 100_000,
      sessionCachedInputTokens: 0,
    });
    const instance = render(
      <TuiApp
        harness={harness}
        inputHistory={[]}
        assembly={unusedAssembly}
        modelCatalog={modelCatalog}
      />,
      {
        stdin,
        stdout: createTuiOutput(stdout),
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
      const startup = bufferLines();
      expect(startup[rows - 1], "startup footer sits on the last terminal row")
        .toContain(modelLabel);
      expect(startup[rows - 3]).toContain("❯");
      expect(terminal.buffer.active.cursorY).toBe(rows - 3);
      expect(terminal.buffer.active.baseY).toBe(0);
      stdin.write("介绍这个项目");
      await flush();
      stdin.write("\r");
      await flush();
      expect(bufferLines().join("\n")).toContain("▌ 介绍这个项目");
      expect(terminal.buffer.active.cursorY, "first submit keeps the input at the bottom")
        .toBe(rows - 3);
      expect(bufferLines()[terminal.buffer.active.baseY + 1],
        "user message keeps one blank margin row above the bar")
        .toContain("▌ 介绍这个项目");
      expect(bufferLines()[terminal.buffer.active.baseY + rows - 1]).toContain(modelLabel);
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
          expect(terminal.buffer.active.cursorY, "streaming keeps the input at the bottom")
            .toBe(rows - 3);
        }
        emit({ type: "agent-loop-completed" });
        await flush();
        const buffer = bufferLines();
        const lastContentRow = buffer.findLastIndex((line) => line.includes(textLines.at(-1)!));
        const inputTopRow = buffer.findLastIndex((line) => line.includes("╭"));
        expect(lastContentRow).toBeGreaterThanOrEqual(0);
        expect(inputTopRow).toBeGreaterThan(lastContentRow);
        const visibleGap = inputTopRow - lastContentRow - 1;
        if (lines > rows - 6) {
          expect(visibleGap, "no screenful of blank rows after a long reply")
            .toBeLessThanOrEqual(2);
        } else {
          expect(visibleGap, "short replies keep the footer pinned with a gap")
            .toBeGreaterThan(1);
        }
        expect(inputTopRow - terminal.buffer.active.baseY)
          .toBe(rows - 4);
        expect(buffer[inputTopRow + 3]).toContain(modelLabel);
        const history = buffer.slice(0, terminal.buffer.active.baseY).join("\n");
        expect(history).not.toContain(modelLabel);
        expect(history).not.toContain(usageLabel);
        expect(buffer.filter((line) => line.includes(modelLabel))).toHaveLength(1);
        expect(buffer.filter((line) => line.includes(usageLabel))).toHaveLength(1);
        for (const line of expectedLines) {
          expect(buffer.join("\n").split(line)).toHaveLength(2);
        }
        const cursorLine = terminal.buffer.active.getLine(
          terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
        )?.translateToString(true);
        expect(cursorLine).toContain("❯");
        stdin.write("你好");
        await flush();
        expect(terminal.buffer.active.cursorX).toBe(4 + (round + 1) * 4);
        expect(terminal.buffer.active.cursorY).toBe(inputTopRow + 1 - terminal.buffer.active.baseY);
        stdin.write("\u001B[D");
        await flush();
        expect(terminal.buffer.active.cursorX).toBe(4 + (round + 1) * 4 - 2);
        expect(terminal.buffer.active.cursorY).toBe(inputTopRow + 1 - terminal.buffer.active.baseY);
        stdin.write("\u001B[C");
        await flush();
        if (scroll) {
          terminal.scrollToTop();
          const visible = bufferLines().slice(
            terminal.buffer.active.viewportY,
            terminal.buffer.active.viewportY + rows,
          );
          expect(visible.join("\n"), "native scroll moves the footer out of view")
            .not.toContain(modelLabel);
          expect(visible.join("\n")).not.toContain("❯");
          terminal.scrollToBottom();
        }
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
        assembly={unusedAssembly}
        modelCatalog={modelCatalog}
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
