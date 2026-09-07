import { PassThrough } from "node:stream";
import { render, renderToString } from "ink";
import { describe, expect, it } from "vitest";
import type {
  Harness,
  HarnessCommand,
  HarnessEvent,
  HarnessSnapshot,
  ProviderClient,
  ProviderToolCall,
  TuiToolCard,
} from "../src/index.js";
import { createTuiState, TuiApp } from "../src/index.js";
import { ActivityLine, ToolLineView } from "../src/ui/tui.js";

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
    sessionTotalTokens: 0,
    ...overrides,
  };
}

function createEventHarness(initial: HarnessSnapshot = idleSnapshot()) {
  let snapshot = initial;
  const listeners = new Set<(event: HarnessEvent) => void>();
  const commands: HarnessCommand[] = [];
  const harness: Harness = {
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

    emit({ type: "session-usage-updated", sessionTotalTokens: 0, contextWindow: 418_000 }, idleSnapshot({ status: "running" }));
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(latestVisibleFrame(frames)).toContain("Working...");
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
    expect(requested).toContain("⏳ read · /tmp/example.txt offset=1 limit=2000");
    expect(requested).toContain("等待执行");
    expect(approvalPromptFragments(requested)).toEqual([]);

    const running = renderTool({
      id: toolCall.id,
      name: toolCall.name,
      invocationLabel: "/tmp/example.txt offset=1 limit=2000",
      status: "running",
      summary: "执行中",
      supplementalLines: [],
    });
    expect(running).toContain("● read · /tmp/example.txt offset=1 limit=2000 · 执行中");
    expect(approvalPromptFragments(running)).toEqual([]);

    const completed = renderTool({
      id: toolCall.id,
      name: toolCall.name,
      invocationLabel: "/tmp/example.txt offset=1 limit=2000",
      status: "completed",
      summary: "已读 2 行 · 17 B",
      supplementalLines: [],
    });
    expect(completed).toContain("✓ read · /tmp/example.txt offset=1 limit=2000");
    expect(completed).toContain("已读 2 行 · 17 B");
    expect(approvalPromptFragments(completed)).toEqual([]);

    const failed = renderTool({
      id: toolCall.id,
      name: toolCall.name,
      invocationLabel: "/tmp/example.txt offset=1 limit=2000",
      status: "failed",
      summary: "ENOENT · 文件不存在",
      supplementalLines: [],
    });
    expect(failed).toContain("✗ read · /tmp/example.txt offset=1 limit=2000");
    expect(failed).toContain("ENOENT · 文件不存在");
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
    expect(requested).toContain("等待执行");
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
    expect(running).toContain("执行中");
    expect(approvalPromptFragments(running)).toEqual([]);

    emit({
      type: "tool-completed",
      toolCall,
      result: {
        ok: true,
        result: {
          resolvedPath: "/tmp/example.txt",
          realTargetPath: "/tmp/example.txt",
          cwdRelation: "inside",
          content: "line one\nline two",
          range: { startLine: 1, endLine: 2 },
          totalLines: 2,
          sizeBytes: 17,
          bom: false,
          lineEnding: "lf",
        },
      },
    });
    await flushEffects();
    await instance.waitUntilRenderFlush();
    const completed = latestVisibleFrame(frames);
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
    expect(requested).toContain("等待执行");
    expect(approvalPromptFragments(requested)).toEqual([]);

    emit({ type: "tool-started", toolCall });
    await flushEffects();
    await instance.waitUntilRenderFlush();
    expect(latestVisibleFrame(frames)).toContain("执行中");

    emit({
      type: "tool-completed",
      toolCall,
      result: {
        ok: false,
        error: { code: "ENOENT", message: "文件不存在" },
      },
    });
    await flushEffects();
    await instance.waitUntilRenderFlush();
    const failed = latestVisibleFrame(frames);
    expect(failed).toContain("ENOENT · 文件不存在");
    expect(approvalPromptFragments(failed)).toEqual([]);

    instance.unmount();
    await instance.waitUntilExit();
  });
});
