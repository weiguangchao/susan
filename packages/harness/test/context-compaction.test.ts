import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt";
import { createHarness } from "../src/index";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, modelContextMessages, estimateMessageTokens } from "../src/core/context";
import { findCutPoint, prepareCompaction, DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "../src/core/compaction/compaction";
import { SUMMARIZATION_SYSTEM_PROMPT, SUMMARIZATION_PROMPT, UPDATE_SUMMARIZATION_PROMPT, TURN_PREFIX_SUMMARIZATION_PROMPT } from "../src/core/compaction/prompts";
import { serializeConversation } from "../src/core/compaction/utils";
import type { CompletionMessage, HarnessEvent, ProviderClient, ProviderFailure, ProviderRequest, ProviderResponse, ProviderStreamEvent, ProviderUsage, CompactionEntry, SessionStore, SessionTranscript } from "../src/index";

function transcript(messages: readonly CompletionMessage[]): SessionTranscript {
  return {
    header: {
      type: "session",
      version: 5,
      id: "00000000-0000-4000-8000-000000000028",
      createdAt: "2026-09-03T00:00:00.000Z",
      cwd: "/workspace",
    },
    records: messages.map((message) => ({ type: "message", message })),
    messages,
    filePath: "/sessions/context.jsonl",
  };
}

function store(
  messages: CompletionMessage[],
  checkpoints: CompactionEntry[],
  usages: ProviderUsage[] = [],
): SessionStore {
  return {
    async createSession() {
      throw new Error("not used");
    },
    async appendMessage(_sessionId, message) {
      messages.push(message);
      return { ok: true, value: undefined };
    },
    async appendCompaction(_sessionId, checkpoint) {
      checkpoints.push(checkpoint);
      return { ok: true, value: undefined };
    },
    async appendUsage(_sessionId, usage) {
      usages.push(usage);
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

function provider(input: {
  streams: readonly (readonly ProviderStreamEvent[])[];
  completions: readonly (ProviderResponse | ProviderFailure)[];
  requests: ProviderRequest[];
  summaryRequests: ProviderRequest[];
}): ProviderClient {
  let streamIndex = 0;
  let completionIndex = 0;
  return {
    type: "openai-completion",
    async *stream(request) {
      input.requests.push(request);
      const events = input.streams[streamIndex++];
      if (events === undefined) {
        throw new Error("Unexpected streaming request");
      }
      yield* events;
    },
    async complete(request) {
      input.summaryRequests.push(request);
      const result = input.completions[completionIndex++];
      if (result === undefined) {
        throw new Error("Unexpected summary request");
      }
      return result;
    },
  };
}

const completed = (content: string): readonly ProviderStreamEvent[] => [
  {
    type: "response-complete",
    response: {
      assistant: { role: "assistant", content },
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    },
  },
];

const summary = (content = "checkpoint", usage?: ProviderUsage): ProviderResponse => ({
  assistant: { role: "assistant", content }, finishReason: "stop", ...(usage ? { usage } : {}),
});
const oldMessages: CompletionMessage[] = [
  { role: "user", content: "old-context ".repeat(9000) },
  { role: "assistant", content: "Old answer." },
];
const overflow: readonly ProviderStreamEvent[] = [{ type: "response-error", failure: {
  code: "PROVIDER_HTTP", message: "Maximum context length exceeded", contextOverflow: true, httpStatus: 400, hadSemanticOutput: false,
} }];
function setup(options: {
  messages?: CompletionMessage[]; session?: SessionTranscript;
  streams?: readonly (readonly ProviderStreamEvent[])[];
  completions?: (ProviderResponse | ProviderFailure)[];
  contextWindow?: number; maxOutputTokens?: number;
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
} = {}) {
  const requests: ProviderRequest[] = [], summaryRequests: ProviderRequest[] = [];
  const checkpoints: CompactionEntry[] = [], appended: CompletionMessage[] = [];
  const usages: ProviderUsage[] = [], events: HarnessEvent[] = [], delays: number[] = [];
  const harness = createHarness({
    provider: provider({ requests, summaryRequests, streams: options.streams ?? [completed("Done")], completions: options.completions ?? [summary()] }),
    sessionStore: store(appended, checkpoints, usages), session: options.session ?? transcript(options.messages ?? oldMessages),
    model: "model", reasoningEffort: "high", contextWindow: options.contextWindow ?? 25000,
    maxOutputTokens: options.maxOutputTokens ?? 1000, tools: [],
    compaction: { keepRecentTokens: 1, ...options.compaction },
    clock: { async sleep(ms) { delays.push(ms); } },
  });
  harness.subscribe((e) => events.push(e));
  return { harness, requests, summaryRequests, checkpoints, appended, usages, events, delays };
}

describe("Pi Compaction", () => {
  it("uses the exact initial prompt, standalone system, output budget, and summary replay wrapper", async () => {
    const t = setup({ completions: [summary("checkpoint", { inputTokens: 1000, outputTokens: 30, totalTokens: 1030 })] });
    expect(await t.harness.dispatch({ type: "submit", content: "Continue" })).toEqual({ ok: true });
    expect(t.summaryRequests).toHaveLength(1);
    expect(t.summaryRequests[0]).toMatchObject({ maxTokens: 1000, messages: [
      { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
      { role: "user", content: `<conversation>\n[User]: ${oldMessages[0].content}\n\n[Assistant]: Old answer.\n</conversation>\n\n${SUMMARIZATION_PROMPT}` },
    ] });
    expect(t.summaryRequests[0].tools).toBeUndefined();
    expect(t.requests[0].messages).toEqual([
      { role: "system", content: buildSystemPrompt([], "/workspace") },
      { role: "user", content: `${COMPACTION_SUMMARY_PREFIX}checkpoint${COMPACTION_SUMMARY_SUFFIX}` },
      { role: "user", content: "Continue" },
    ]);
    expect(t.checkpoints[0]).toMatchObject({ firstKeptEntryId: "message:2", retainedTail: [{ role: "user", content: "Continue" }], details: { readFiles: [], modifiedFiles: [] }, usage: { totalTokens: 1030 } });
    expect(t.harness.getSnapshot().messages.slice(0, 2)).toEqual(oldMessages);
    expect(t.harness.getSnapshot().sessionTotalTokens).toBe(1140);
  });

  it("uses strict threshold and fixed reserve independent of the model output cap", async () => {
    expect(shouldCompact(8616, 25000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
    expect(shouldCompact(8617, 25000, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
    const t = setup({ contextWindow: 100000, maxOutputTokens: 99000 });
    expect(await t.harness.dispatch({ type: "submit", content: "Continue" })).toEqual({ ok: true });
    expect(t.summaryRequests).toHaveLength(0);
  });

  it("splits a large current turn, preserving a complete assistant/tool-result tail", async () => {
    const messages: CompletionMessage[] = [
      { role: "user", content: "x".repeat(80000) },
      { role: "assistant", toolCalls: [{ id: "read-1", name: "read", arguments: { path: "a.ts" } }] },
      { role: "tool", toolCallId: "read-1", content: [{ type: "text", text: "data" }] },
      { role: "assistant", content: "Recent answer" },
    ];
    const t = setup({ messages, compaction: { keepRecentTokens: 10 }, maxOutputTokens: 20000, completions: [summary("turn prefix")] });
    expect(await t.harness.compact()).toEqual({ ok: true });
    expect(t.summaryRequests[0].maxTokens).toBe(8192);
    expect(t.summaryRequests[0].messages[1].content).toContain(TURN_PREFIX_SUMMARIZATION_PROMPT);
    expect(t.checkpoints[0].retainedTail).toEqual(messages.slice(1));
    expect(t.checkpoints[0].summary).toBe("No prior history.\n\n---\n\n**Turn Context (split turn):**\n\nturn prefix");
  });

  it("findCutPoint never starts on a Tool Result and includes thinking in the estimate", () => {
    const messages: CompletionMessage[] = [
      { role: "user", content: "old" },
      { role: "assistant", toolCalls: [{ id: "a", name: "read", arguments: {} }] },
      { role: "tool", toolCallId: "a", content: [{ type: "text", text: "x".repeat(20000) }] },
      { role: "assistant", content: "recent" },
    ];
    expect(findCutPoint(messages, 0, 4, 100)).toEqual({ firstKeptEntryIndex: 3, turnStartIndex: 0, isSplitTurn: true });
    expect(estimateMessageTokens({ role: "assistant", reasoning: "思考".repeat(100) })).toBe(50);
    expect(estimateMessageTokens({ role: "tool", toolCallId: "a", content: [{ type: "image", data: "ignored", mimeType: "image/png" }] })).toBe(1200);
  });

  it("serializes thinking, calls and text in Pi order, excluding system and truncating only summary tool text", () => {
    const text = "x".repeat(2100);
    const messages: CompletionMessage[] = [
      { role: "system", content: "private product prompt" },
      { role: "assistant", content: "answer", reasoning: "reason", toolCalls: [{ id: "a", name: "read", arguments: { path: "a.ts", limit: 2 } }] },
      { role: "tool", toolCallId: "a", content: [{ type: "text", text }] },
    ];
    expect(serializeConversation(messages)).toBe(`[Assistant thinking]: reason\n\n[Assistant]: answer\n\n[Assistant tool calls]: read(path="a.ts", limit=2)\n\n[Tool result]: ${"x".repeat(2000)}\n\n[... 100 more characters truncated]`);
    expect(messages[2].content).toEqual([{ type: "text", text }]);
  });

  it("restores retainedTail and updates the prior summary without re-summarizing discarded history", async () => {
    const prior: CompactionEntry = { type: "compaction", summary: "prior goal", firstKeptEntryId: "message:1", retainedTail: oldMessages,
      tokensBefore: 100000, timestamp: "2026-09-10T00:00:00Z", details: { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] } };
    const messages: CompletionMessage[] = [{ role: "user", content: "discarded" }, ...oldMessages];
    const session = transcript(messages);
    const t = setup({ session: { ...session, records: [...session.records, prior] } });
    expect(await t.harness.dispatch({ type: "submit", content: "Continue" })).toEqual({ ok: true });
    const prompt = t.summaryRequests[0].messages[1].content as string;
    expect(prompt).toContain(`<previous-summary>\nprior goal\n</previous-summary>\n\n${UPDATE_SUMMARIZATION_PROMPT}`);
    expect(prompt).not.toContain("discarded");
    expect(t.checkpoints[0].firstKeptEntryId).toBe("message:3");
    expect(t.checkpoints[0].summary).toContain("<read-files>\na.ts\n</read-files>");
    expect(t.checkpoints[0].summary).toContain("<modified-files>\nb.ts\n</modified-files>");
    const nextMessages = [...messages, ...t.appended, { role: "user" as const, content: "later" }];
    expect(modelContextMessages(nextMessages, t.checkpoints[0]).slice(1)).toEqual([
      { role: "user", content: "Continue" }, { role: "assistant", content: "Done" }, { role: "user", content: "later" },
    ]);
  });

  it("tracks reads and mutations across summaries, with mutations winning over reads", () => {
    const messages: CompletionMessage[] = [
      { role: "user", content: "change" },
      { role: "assistant", toolCalls: [
        { id: "r1", name: "read", arguments: { path: "a" } },
        { id: "r2", name: "read", arguments: { path: "b" } },
        { id: "w", name: "write", arguments: { path: "b" } },
        { id: "e", name: "edit", arguments: { path: "c" } },
      ] }, { role: "user", content: "next" },
    ];
    const p = prepareCompaction(messages, undefined, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1 });
    expect([...p!.fileOps.read]).toEqual(["a", "b"]);
    expect([...p!.fileOps.written]).toEqual(["b"]);
    expect([...p!.fileOps.edited]).toEqual(["c"]);
  });

  it.each([
    { code: "PROVIDER_INCOMPLETE", message: "length", hadSemanticOutput: true } as ProviderFailure,
    { assistant: { role: "assistant", toolCalls: [{ id: "a", name: "read", arguments: {} }] }, finishReason: "tool_calls" } as ProviderResponse,
  ])("never persists an incomplete or tool-calling summary", async (result) => {
    const t = setup({ completions: [result] });
    expect(await t.harness.dispatch({ type: "submit", content: "Continue" })).toMatchObject({ ok: false, error: { code: "HARNESS_COMPACTION" } });
    expect(t.summaryRequests).toHaveLength(1);
    expect(t.checkpoints).toEqual([]);
    expect(t.requests).toEqual([]);
  });

  it("retries transient summary errors including partial transport errors with Pi exponential backoff", async () => {
    const failure: ProviderFailure = { code: "PROVIDER_NETWORK", message: "terminated", hadSemanticOutput: true };
    const t = setup({ completions: [failure, failure, summary()] });
    expect(await t.harness.dispatch({ type: "submit", content: "Continue" })).toEqual({ ok: true });
    expect(t.delays).toEqual([1000, 2000]);
    expect(t.summaryRequests).toHaveLength(3);
    expect(t.checkpoints).toHaveLength(1);
  });

  it("does not retry billing limits or replace the checkpoint when summarization fails", async () => {
    const t = setup({ completions: [{ code: "PROVIDER_HTTP", httpStatus: 429, message: "insufficient_quota", hadSemanticOutput: false }] });
    expect(await t.harness.compact()).toMatchObject({ ok: false });
    expect(t.summaryRequests).toHaveLength(1);
    expect(t.checkpoints).toEqual([]);
    expect(t.harness.getSnapshot().status).toBe("idle");
  });

  it("compacts once and retries overflow even after partial output, without persisting the failed assistant", async () => {
    const t = setup({ contextWindow: 100000, streams: [[{ type: "text-delta", textDelta: "partial" }, ...overflow], completed("Recovered")] });
    expect(await t.harness.dispatch({ type: "submit", content: "Continue" })).toEqual({ ok: true });
    expect(t.requests).toHaveLength(2);
    expect(t.checkpoints).toHaveLength(1);
    expect(t.appended).toEqual([{ role: "user", content: "Continue" }, { role: "assistant", content: "Recovered" }]);
  });

  it("stops when the one overflow recovery also overflows", async () => {
    const t = setup({ contextWindow: 100000, streams: [overflow, overflow] });
    expect(await t.harness.dispatch({ type: "submit", content: "Continue" })).toMatchObject({ ok: false, error: { code: "HARNESS_PROVIDER" } });
    expect(t.requests).toHaveLength(2);
    expect(t.summaryRequests).toHaveLength(1);
  });

  it("checks threshold at the end of a successful turn and clears stale usage after compaction", async () => {
    const t = setup({
      contextWindow: 100000,
      compaction: { keepRecentTokens: 2 },
      streams: [[{ type: "response-complete", response: summary("Done", { inputTokens: 90000, outputTokens: 10, totalTokens: 90010 }) }], completed("Next")],
    });
    expect(await t.harness.dispatch({ type: "submit", content: "Continue" })).toEqual({ ok: true });
    expect(t.summaryRequests).toHaveLength(1);
    expect(t.harness.getSnapshot().status).toBe("idle");
    expect(t.harness.getSnapshot().contextTokens).toBeLessThan(10000);
    expect(await t.harness.dispatch({ type: "submit", content: "Next" })).toEqual({ ok: true });
    expect(t.summaryRequests).toHaveLength(1);
  });

  it("does not use old-model usage after model switching", async () => {
    const session = transcript([{ role: "user", content: "short" }, { role: "assistant", content: "answer" }]);
    const t = setup({ session: { ...session, records: [session.records[0], { type: "usage", model: "old-model", reasoningEffort: "high", usage: { inputTokens: 99999, outputTokens: 1, totalTokens: 100000 } }, session.records[1]] } });
    expect(t.harness.getSnapshot().contextTokens).toBeLessThan(10000);
    expect(await t.harness.dispatch({ type: "submit", content: "continue" })).toEqual({ ok: true });
    expect(t.summaryRequests).toEqual([]);
  });

  it("allows manual compaction while automatic compaction is disabled and accepts focus instructions", async () => {
    const t = setup({ compaction: { enabled: false, keepRecentTokens: 2 }, maxOutputTokens: 20000 });
    expect(await t.harness.dispatch({ type: "submit", content: "Continue" })).toEqual({ ok: true });
    expect(t.summaryRequests).toEqual([]);
    expect(await t.harness.compact("preserve paths")).toEqual({ ok: true });
    expect(t.summaryRequests).toHaveLength(1);
    const prompt = t.summaryRequests[0].messages[1].content as string;
    expect(prompt).toContain("Additional focus: preserve paths");
    expect(t.summaryRequests[0].maxTokens).toBe(13107);
  });

  it("skips automatic compaction when nothing can be summarized and reports manual no-op", async () => {
    const t = setup({ messages: [], contextWindow: 16384 });
    expect(await t.harness.compact()).toMatchObject({ ok: false, error: { message: "Nothing to compact" } });
    expect(await t.harness.dispatch({ type: "submit", content: "one user message" })).toEqual({ ok: true });
    expect(t.requests).toHaveLength(1);
  });
});
