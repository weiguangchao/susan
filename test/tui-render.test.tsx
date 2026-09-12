import { PassThrough } from "node:stream";
import { render, renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import type {
  CompletionMessage,
  Harness,
  HarnessCommand,
  HarnessEvent,
  HarnessSnapshot,
  ProviderClient,
  ProviderRequest,
  ProviderStreamEvent,
  ProviderToolCall,
  SessionStore,
  SessionTranscript,
  TuiMessage,
  TuiToolCard,
} from "../src/index";
import { createHarness, createTuiState, TuiApp } from "../src/index";
import { ActivityLine, SessionContentView, ToolLineView } from "../src/ui/tui";

const toolCall: ProviderToolCall = {
  id: "call-1",
  name: "read",
  arguments: { path: "/tmp/example.txt", offset: 1, limit: 2000 },
};

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function approvalPromptFragments(output: string): string[] {
  return [
    "审批",
    "等待审批",
    "Enter 允许",
    "Esc / Ctrl+C 拒绝",
    "waiting-approval",
  ].filter((fragment) => output.includes(fragment));
}

function renderTool(tool: TuiToolCard): string {
  return stripAnsi(renderToString(<ToolLineView tool={tool} />, { columns: 80 }));
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
  output.rows = 24;
  output.on("data", (chunk: Buffer) => onWrite(chunk.toString("utf8")));
  return output as unknown as NodeJS.WriteStream;
}

function tallTerminalOutput(
  onWrite: (chunk: string) => void,
): NodeJS.WriteStream {
  const output = terminalOutput(onWrite) as NodeJS.WriteStream & {
    rows: number;
  };
  output.rows = 40;
  return output;
}

function latestVisibleFrame(frames: readonly string[]): string {
  return frames.findLast((frame) => frame.trim() !== "") ?? "";
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
  const commands: HarnessCommand[] = [];
  const harness: Harness = {
    async compact() { return { ok: true as const }; },
    async dispatch(command) {
      commands.push(command);
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
  return {
    harness,
    commands,
    emit(event: HarnessEvent, next = snapshot) {
      snapshot = next;
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

const provider = {
  type: "openai-completion",
} as ProviderClient;

describe("TUI status bar", () => {
  it("renders the percentage before token usage without slash spaces", async () => {
    const { harness } = createEventHarness(
      idleSnapshot({ sessionTotalTokens: 25_000, contextTokens: 25_000, contextWindow: 127_000 }),
    );
    const frames: string[] = [];
    const stdin = terminalInput();
    const stdout = terminalOutput((chunk) => frames.push(stripAnsi(chunk)));
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
    const initial = latestVisibleFrame(frames);
    expect(initial).toContain("19.7%/25k");
    expect(initial).not.toContain("CH ");

    instance.unmount();
    await instance.waitUntilExit();
  });

  it("renders the Cache Hit Rate prefix once cached usage accumulates", async () => {
    const { harness, emit } = createEventHarness(
      idleSnapshot({ sessionTotalTokens: 25_000, contextTokens: 25_000, contextWindow: 127_000 }),
    );
    const frames: string[] = [];
    const stdin = terminalInput();
    const stdout = terminalOutput((chunk) => frames.push(stripAnsi(chunk)));
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
    emit(
      {
        type: "session-usage-updated",
        sessionTotalTokens: 50_000, contextTokens: 50_000,
        sessionInputTokens: 40_000,
        sessionCachedInputTokens: 10_320,
        contextWindow: 127_000,
      },
      idleSnapshot({
        status: "running",
        sessionTotalTokens: 50_000, contextTokens: 50_000,
        sessionInputTokens: 40_000,
        sessionCachedInputTokens: 10_320,
        contextWindow: 127_000,
      }),
    );
    await flushEffects();
    await instance.waitUntilRenderFlush();

    expect(latestVisibleFrame(frames)).toContain("CH 25.8% 39.4%/50k");

    instance.unmount();
    await instance.waitUntilExit();
  });

  it("keeps the Cache Hit Rate prefix hidden while no cache has been reported", async () => {
    const { harness, emit } = createEventHarness(
      idleSnapshot({ sessionTotalTokens: 25_000, contextTokens: 25_000, contextWindow: 127_000 }),
    );
    const frames: string[] = [];
    const stdin = terminalInput();
    const stdout = terminalOutput((chunk) => frames.push(stripAnsi(chunk)));
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
    emit(
      {
        type: "session-usage-updated",
        sessionTotalTokens: 50_000, contextTokens: 50_000,
        sessionInputTokens: 40_000,
        sessionCachedInputTokens: 0,
        contextWindow: 127_000,
      },
      idleSnapshot({
        status: "running",
        sessionTotalTokens: 50_000, contextTokens: 50_000,
        sessionInputTokens: 40_000,
        sessionCachedInputTokens: 0,
        contextWindow: 127_000,
      }),
    );
    await flushEffects();
    await instance.waitUntilRenderFlush();

    const frame = latestVisibleFrame(frames);
    expect(frame).toContain("39.4%/50k");
    expect(frame).not.toContain("CH ");

    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe("TUI context usage display", () => {
  function contextUsageTranscript(): SessionTranscript {
    return {
      header: {
        type: "session",
        version: 5,
        id: "00000000-0000-4000-8000-000000000002",
        createdAt: "2026-09-03T00:00:00.000Z",
        cwd: "/workspace",
      },
      records: [],
      messages: [],
      filePath: "/sessions/context-usage.jsonl",
    };
  }

  function contextUsageSessionStore(): SessionStore {
    return {
      async createSession() {
        throw new Error("not used");
      },
      async appendMessage() {
        return { ok: true, value: undefined };
      },
      async appendCompaction() {
        return { ok: true, value: undefined };
      },
      async appendUsage() {
        return { ok: true, value: undefined };
      },
      async loadSession() {
        throw new Error("not used");
      },
      async listSessions() {
        throw new Error("not used");
      },
      async loadLastSession() {
        throw new Error("not used");
      },
      async loadInputHistory() {
        throw new Error("not used");
      },
    };
  }

  function contextUsageProvider(): ProviderClient {
    const responses: readonly (readonly ProviderStreamEvent[])[] = [
      [
        {
          type: "response-complete",
          response: {
            assistant: { role: "assistant", content: "Hello" },
            finishReason: "stop",
            usage: { inputTokens: 120, outputTokens: 5, totalTokens: 125 },
          },
        },
      ],
      [
        {
          type: "response-complete",
          response: {
            assistant: { role: "assistant", content: "Again" },
            finishReason: "stop",
            usage: { inputTokens: 180, outputTokens: 30, totalTokens: 210 },
          },
        },
      ],
    ];
    let index = 0;
    return {
      type: "openai-completion",
      async complete() {
        return {
          code: "PROVIDER_PROTOCOL",
          message: "not used",
          hadSemanticOutput: false,
        };
      },
      async *stream() {
        yield* responses[index++]!;
      },
    };
  }

  it("shows the current context usage, not cumulative session usage, in the status bar", async () => {
    const harness = createHarness({
      provider: contextUsageProvider(),
      sessionStore: contextUsageSessionStore(),
      session: contextUsageTranscript(),
      model: "model",
      reasoningEffort: "medium",
      contextWindow: 100_000,
      maxOutputTokens: 1_000,
      tools: [],
    });
    const frames: string[] = [];
    const stdin = terminalInput();
    const stdout = terminalOutput((chunk) => frames.push(stripAnsi(chunk)));
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
    const initialFrame = latestVisibleFrame(frames);
    expect(initialFrame).toContain("0.0%/0");
    expect(await harness.dispatch({ type: "submit", content: "Hi" })).toEqual({
      ok: true,
    });
    expect(
      await harness.dispatch({ type: "submit", content: "Again" }),
    ).toEqual({ ok: true });
    await flushEffects();
    await instance.waitUntilRenderFlush();

    const frame = latestVisibleFrame(frames);
    expect(frame).toContain("0.2%/210");
    expect(frame).not.toContain("0.3%/335");

    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe("TUI completed output history", () => {
  it("keeps every completed message available when later output has been appended", async () => {
    const { harness } = createEventHarness(
      idleSnapshot({
        messages: Array.from({ length: 21 }, (_, index) => ({
          role: "user" as const,
          content: `history-${index}`,
        })),
      }),
    );
    const frames: string[] = [];
    const stdin = terminalInput();
    const stdout = tallTerminalOutput((chunk) => frames.push(stripAnsi(chunk)));
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
    const completedOutput = frames.join("");
    expect(completedOutput).toContain("history-0");
    expect(completedOutput).toContain("history-20");

    instance.unmount();
    await instance.waitUntilExit();
  });

  it("keeps every completed Tool record available after more than eight calls", async () => {
    const toolCalls = Array.from({ length: 9 }, (_, index) => ({
      id: `history-tool-${index}`,
      name: "bash",
      arguments: { command: `command-${index}` },
    }));
    const { harness } = createEventHarness(
      idleSnapshot({
        messages: [
          { role: "assistant", toolCalls },
          ...toolCalls.map((toolCall, index) => ({
            role: "tool" as const,
            toolCallId: toolCall.id,
            content: [{ type: "text" as const, text: `failure-${index}` }],
            isError: true,
          })),
        ],
      }),
    );
    const frames: string[] = [];
    const stdin = terminalInput();
    const stdout = tallTerminalOutput((chunk) => frames.push(stripAnsi(chunk)));
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
    const completedOutput = frames.join("");
    expect(completedOutput).toContain("command-0");
    expect(completedOutput).toContain("command-8");

    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe("TUI activity slot", () => {
  function renderActivity(
    overrides: Partial<ReturnType<typeof createTuiState>> = {},
  ): string {
    const state = {
      ...createTuiState(idleSnapshot()),
      ...overrides,
    };
    return stripAnsi(
      renderToString(<ActivityLine state={state} now={1_000} />, { columns: 80 }),
    );
  }

  it("uses retry, Provider Failure, running, menu, notice, then idle priority", () => {
    expect(renderActivity({
      input: "/m",
      retry: {
        reason: "Too many requests",
        retry: 1,
        maxRetries: 2,
        delayMs: 2_000,
        startedAt: 0,
      },
      failure: {
        code: "PROVIDER_HTTP",
        message: "failed",
        hadSemanticOutput: false,
      },
      status: "running",
      notice: "notice",
    })).toContain("秒后重试");
    expect(renderActivity({
      input: "/m",
      failure: {
        code: "PROVIDER_HTTP",
        message: "failed",
        hadSemanticOutput: false,
      },
      status: "running",
      notice: "notice",
    })).toBe(" ⚠ Provider 请求失败 · PROVIDER_HTTP · failed");
    expect(renderActivity({ input: "/m", status: "running", notice: "notice" })).toBe("");
    expect(renderActivity({ input: "/m", notice: "notice" })).toBe(" › /model 模型");
    expect(renderActivity({ notice: "notice" })).toBe(" ⓘ notice");
    expect(renderActivity()).toBe("");
  });

  it("lets a Pending Slash Query replace its notice", () => {
    expect(renderActivity({
      status: "pending",
      pending: { reason: "restored" },
      input: "/m",
      notice: "上次响应未完成（Pending Agent Loop）",
    })).toBe(" › /model 模型");
  });

  it("suppresses a running menu without clearing the Slash Query", async () => {
    const { harness, emit } = createEventHarness();
    const frames: string[] = [];
    const stdin = terminalInput();
    const stdout = terminalOutput((chunk) => frames.push(stripAnsi(chunk)));
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
    stdin.push("/m");
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(latestVisibleFrame(frames)).toContain("› /model 模型");

    emit({ type: "session-usage-updated", sessionTotalTokens: 0, sessionInputTokens: 0, sessionCachedInputTokens: 0, contextWindow: 418_000, contextTokens: 0 }, idleSnapshot({ status: "running" }));
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(latestVisibleFrame(frames)).not.toContain("Working...");
    expect(latestVisibleFrame(frames)).toContain("❯ /m");
    expect(latestVisibleFrame(frames)).not.toContain("› /model 模型");

    emit({ type: "agent-loop-completed" }, idleSnapshot());
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(latestVisibleFrame(frames)).toContain("› /model 模型");
    expect(latestVisibleFrame(frames)).toContain("❯ /m");

    instance.unmount();
    await instance.waitUntilExit();
  });

  it("lets the model picker suppress a menu without clearing its query", () => {
    const state = {
      ...createTuiState(idleSnapshot()),
      input: "/z",
      inputCursor: { row: 0, column: 2 },
      modelPickerActive: true,
    };

    expect(renderActivity(state)).toBe("");
    expect(state.input).toBe("/z");
    expect(renderActivity({ ...state, modelPickerActive: false })).toBe(" 无匹配");
  });
});

describe("TUI Tool rendering", () => {
  it("renders Yolo Tool statuses without an approval prompt", () => {
    const requested = renderTool({
      id: toolCall.id,
      name: toolCall.name,
      invocationLabel: "/tmp/example.txt offset=1 limit=2000",
      status: "requested",
      summary: "等待执行",
      supplementalLines: [],
    });
    expect(requested).toBe("");
    expect(requested).not.toContain("等待执行");
    expect(approvalPromptFragments(requested)).toEqual([]);

    const running = renderTool({
      id: toolCall.id,
      name: toolCall.name,
      invocationLabel: "/tmp/example.txt offset=1 limit=2000",
      status: "running",
      summary: "执行中",
      supplementalLines: [],
    });
    expect(running).toBe("");
    expect(approvalPromptFragments(running)).toEqual([]);

    const completed = renderTool({
      id: toolCall.id,
      name: toolCall.name,
      invocationLabel: "/tmp/example.txt offset=1 limit=2000",
      status: "completed",
      summary: "已读 2 行 · 17 B",
      supplementalLines: [],
    });
    expect(completed).toContain("read · /tmp/example.txt offset=1 limit=2000");
    expect(completed).toContain("已读 2 行 · 17 B");
    expect(approvalPromptFragments(completed)).toEqual([]);

    const failed = renderTool({
      id: toolCall.id,
      name: toolCall.name,
      invocationLabel: "/tmp/example.txt offset=1 limit=2000",
      status: "failed",
      summary: "文件不存在",
      supplementalLines: [],
    });
    expect(failed).toContain("read · /tmp/example.txt offset=1 limit=2000");
    expect(failed).toContain("文件不存在");
    expect(approvalPromptFragments(failed)).toEqual([]);
  });

  it("updates the composed TUI from requested through running to completed", async () => {
    const { harness, commands, emit } = createEventHarness(
      idleSnapshot({ status: "running" }),
    );
    const frames: string[] = [];
    const stdin = terminalInput();
    const stdout = terminalOutput((chunk) => frames.push(stripAnsi(chunk)));
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
      { stdin, stdout, interactive: true, patchConsole: false },
    );

    await instance.waitUntilRenderFlush();
    await flushEffects();

    emit({
      type: "tool-call-delta",
      index: 0,
      id: toolCall.id,
      name: toolCall.name,
      argumentsDelta: '{"path":"/tmp/example.txt"}',
    });
    await flushEffects();
    await instance.waitUntilRenderFlush();
    const requested = latestVisibleFrame(frames);
    expect(requested).not.toContain("等待执行");
    expect(approvalPromptFragments(requested)).toEqual([]);

    stdin.push("\r");
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(commands).toEqual([]);
    expect(approvalPromptFragments(latestVisibleFrame(frames))).toEqual([]);

    emit({ type: "tool-started", toolCall });
    await flushEffects();
    await instance.waitUntilRenderFlush();
    const running = latestVisibleFrame(frames);
    expect(running).not.toContain("read · /tmp/example.txt");
    expect(running).toContain("Next moving...");
    expect(running).not.toContain("执行中");
    expect(approvalPromptFragments(running)).toEqual([]);

    frames.length = 0;
    emit({
      type: "tool-completed",
      toolCall,
      result: {
        content: [{ type: "text", text: "line one\nline two" }],
        details: {
          range: { startLine: 1, endLine: 2 },
          totalLines: 2,
          sizeBytes: 17,
          bom: false,
          lineEnding: "lf",
        },
      },
      isError: false,
    });
    await flushEffects();
    await instance.waitUntilRenderFlush();
    const completed = frames.join("");
    expect(completed).toContain("已读 2 行 · 17 B");
    expect(approvalPromptFragments(completed)).toEqual([]);
    expect(commands).toEqual([]);

    instance.unmount();
    await instance.waitUntilExit();
  });

  it("updates the composed TUI from running to failed without an approval prompt", async () => {
    const { harness, emit } = createEventHarness(
      idleSnapshot({ status: "running" }),
    );
    const frames: string[] = [];
    const stdin = terminalInput();
    const stdout = terminalOutput((chunk) => frames.push(stripAnsi(chunk)));
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
      { stdin, stdout, interactive: true, patchConsole: false },
    );

    await instance.waitUntilRenderFlush();
    await flushEffects();

    emit({
      type: "tool-call-delta",
      index: 0,
      id: toolCall.id,
      name: toolCall.name,
      argumentsDelta: '{"path":"/tmp/example.txt"}',
    });
    await flushEffects();
    await instance.waitUntilRenderFlush();
    const requested = latestVisibleFrame(frames);
    expect(requested).not.toContain("等待执行");
    expect(approvalPromptFragments(requested)).toEqual([]);

    emit({ type: "tool-started", toolCall });
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(latestVisibleFrame(frames)).toContain("Next moving...");

    frames.length = 0;
    emit({
      type: "tool-completed",
      toolCall,
      result: {
        content: [{ type: "text", text: "文件不存在" }],
      },
      isError: true,
    });
    await flushEffects();
    await instance.waitUntilRenderFlush();
    const failed = frames.join("");
    expect(failed).toContain("文件不存在");
    expect(approvalPromptFragments(failed)).toEqual([]);

    instance.unmount();
    await instance.waitUntilExit();
  });
});

describe("TUI reasoning rendering", () => {
  it("stops Think animation when reasoning transitions to answer text", async () => {
    const intervals = vi.spyOn(globalThis, "setInterval");
    const clearInterval = vi.spyOn(globalThis, "clearInterval");
    const { harness, emit } = createEventHarness(idleSnapshot({ status: "running" }));
    const frames: string[] = [];
    const instance = render(
      <TuiApp
        harness={harness}
        inputHistory={[]}
        startNewSession={() => harness}
        modelCatalog={modelCatalog}
        applyModelSelection={async () => ({ ok: false, message: "not used" })}
      />,
      {
        stdin: terminalInput(),
        stdout: terminalOutput((chunk) => frames.push(stripAnsi(chunk))),
        interactive: true,
        patchConsole: false,
      },
    );
    try {
      await flushEffects();
      await instance.waitUntilRenderFlush();
      emit({ type: "reasoning-delta", textDelta: "先检查项目结构" });
      await flushEffects();
      await instance.waitUntilRenderFlush();
      expect(latestVisibleFrame(frames)).toContain("Think...");
      await flushEffects();
      const animationCall = intervals.mock.calls.findIndex((call) => call[1] === 180);
      expect(animationCall).toBeGreaterThanOrEqual(0);
      const animationTimer = intervals.mock.results[animationCall]!.value;

      emit({ type: "text-delta", textDelta: "这是结论" });
      await flushEffects();
      await instance.waitUntilRenderFlush();
      const answerFrame = latestVisibleFrame(frames);
      expect(answerFrame).toContain("这是结论");
      expect(answerFrame).toContain("先检查项目结构");
      expect(answerFrame).not.toContain("Think...");
      expect(answerFrame).toMatch(/Think · \d+\.\d 秒/);
      await flushEffects();
      expect(clearInterval).toHaveBeenCalledWith(animationTimer);
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      intervals.mockRestore();
      clearInterval.mockRestore();
    }
  });

  function renderSession(messages: readonly TuiMessage[]): string {
    return stripAnsi(
      renderToString(
        <SessionContentView messages={messages} tools={[]} width={80} />,
        { columns: 80 },
      ),
    );
  }

  it("renders a finalized reasoning message with its thinking duration label", () => {
    const output = renderSession([
      { kind: "reasoning", text: "先检查项目结构", durationMs: 1_620 },
      { kind: "assistant", text: "这是结论" },
    ]);
    const lines = output.split("\n");
    expect(lines[0]).toBe("Think · 1.6 秒");
    expect(lines[1]).toBe("先检查项目结构");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("这是结论");
  });

  it("renders restored reasoning as plain dim text without the label", () => {
    const output = renderSession([
      { kind: "reasoning", text: "先检查项目结构" },
      { kind: "assistant", text: "这是结论" },
    ]);
    const lines = output.split("\n");
    expect(lines[0]).toBe("先检查项目结构");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("这是结论");
    expect(output).not.toContain("Think");
  });
});
