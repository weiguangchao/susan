import { useCallback, useRef, useState } from "react";
import {
  Agent,
  resolveSusanHome,
  type ModelProvider,
} from "@susan/harness";
import { type LogItem, nextItemId, type ToolItem } from "./session-state.js";
import type { UsageDisplay } from "./usage-display.js";

/** The reasoning block still streaming. */
export interface ReasoningState {
  /** The full block so far, never truncated. */
  text: string;
  startedAt: number;
}

export interface UseAgentOptions {
  root: string;
  provider: ModelProvider;
  onSessionStarted?: () => Promise<void>;
}

export interface AgentView {
  agent: Agent;
  /** Finished runs - immutable, so Ink can print them once and forget them. */
  history: LogItem[];
  /** The run in flight, still mutating. */
  live: LogItem[];
  streamingText: string;
  reasoning: ReasoningState | null;
  busy: boolean;
  /** When the run in flight was sent, for the working row's timer. */
  runStartedAt: number | null;
  usageDisplay: UsageDisplay | null;
  send(input: string): void;
  interrupt(): void;
  reset(): void;
  clearUsageDisplay(): void;
  pushNotice(level: "info" | "warn" | "error", text: string): void;
}

/**
 * Bridges the harness event stream to React state.
 *
 * Refs hold the authoritative values: the event loop writes to them
 * synchronously and mirrors into state for rendering, so flushing a finished
 * run never depends on a batched update having landed.
 */
export function useAgent(options: UseAgentOptions): AgentView {
  const [history, setHistory] = useState<LogItem[]>([]);
  const [live, setLive] = useState<LogItem[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [reasoning, setReasoning] = useState<ReasoningState | null>(null);
  const [busy, setBusy] = useState(false);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [usageDisplay, setUsageDisplay] = useState<UsageDisplay | null>(null);

  const liveRef = useRef<LogItem[]>([]);
  const streamRef = useRef("");
  const reasoningRef = useRef<ReasoningState | null>(null);

  const applyLive = useCallback((fn: (items: LogItem[]) => LogItem[]) => {
    liveRef.current = fn(liveRef.current);
    setLive(liveRef.current);
  }, []);

  const applyStream = useCallback((text: string) => {
    streamRef.current = text;
    setStreamingText(text);
  }, []);

  const applyReasoning = useCallback((value: ReasoningState | null) => {
    reasoningRef.current = value;
    setReasoning(value);
  }, []);

  const [agent] = useState(
    () =>
      new Agent({
        root: options.root,
        provider: options.provider,
        sessionHome: resolveSusanHome(),
      }),
  );

  const updateTool = useCallback(
    (id: string, patch: Partial<ToolItem>) => {
      applyLive((items) =>
        items.map((item) =>
          item.kind === "tool" && item.id === id ? { ...item, ...patch } : item,
        ),
      );
    },
    [applyLive],
  );

  const appendLive = useCallback(
    (item: LogItem) => applyLive((items) => [...items, item]),
    [applyLive],
  );

  /**
   * Move the open reasoning block, if any, into the run with its timer stopped.
   * `text` is the harness's whole block; without it, what streamed so far.
   */
  const commitReasoning = useCallback((text?: string) => {
    const open = reasoningRef.current;
    if (!open) return;
    applyReasoning(null);
    appendLive({
      kind: "reasoning",
      id: nextItemId("reasoning"),
      text: text ?? open.text,
      ms: Date.now() - open.startedAt,
    });
  }, [appendLive, applyReasoning]);

  const pushNotice = useCallback(
    (level: "info" | "warn" | "error", text: string) => {
      setHistory((items) => [
        ...items,
        { kind: "notice", id: nextItemId("notice"), level, text },
      ]);
    },
    [],
  );

  const send = useCallback(
    (input: string) => {
      if (agent.busy) return;

      setBusy(true);
      setRunStartedAt(Date.now());
      setUsageDisplay({ usage: null, measuredTotal: agent.session.usage });
      applyStream("");
      applyReasoning(null);
      liveRef.current = [
        { kind: "user", id: nextItemId("user"), text: input },
      ];
      setLive(liveRef.current);

      void (async () => {
        try {
          for await (const event of agent.run(input)) {
            switch (event.type) {
              case "turn_start":
                if (event.turn === 1) {
                  try { await options.onSessionStarted?.(); }
                  catch (error) {
                    appendLive({
                      kind: "notice",
                      id: nextItemId("notice"),
                      level: "error",
                      text: `could not save last used model: ${(error as Error).message}`,
                    });
                  }
                }
                break;

              case "text_delta":
                applyStream(streamRef.current + event.text);
                break;

              case "thinking_delta": {
                const open = reasoningRef.current;
                applyReasoning({
                  text: (open?.text ?? "") + event.text,
                  startedAt: open?.startedAt ?? Date.now(),
                });
                break;
              }

              case "thinking_end":
                commitReasoning(event.text);
                break;

              case "text_end":
                applyStream("");
                appendLive({
                  kind: "assistant",
                  id: nextItemId("assistant"),
                  text: event.text,
                });
                break;

              case "tool_pending":
                appendLive({
                  kind: "tool",
                  id: event.id,
                  name: event.name,
                  summary: event.summary,
                  status: "pending",
                });
                break;

              case "tool_call":
                updateTool(event.id, {
                  summary: event.summary,
                  status: "running",
                });
                break;

              case "tool_result":
                updateTool(event.id, {
                  status: event.ok ? "done" : "error",
                  display: event.display,
                });
                break;

              case "usage_progress":
                setUsageDisplay({ usage: event.usage, measuredTotal: event.measuredTotal });
                break;

              case "usage":
                setUsageDisplay({ usage: event.usage, measuredTotal: event.total });
                break;

              case "notice":
                appendLive({
                  kind: "notice",
                  id: nextItemId("notice"),
                  level: event.level,
                  text: event.message,
                });
                break;

              case "done":
                // An interrupted block keeps the thought that was in progress.
                commitReasoning();
                if (event.reason !== "end_turn") {
                  // Whatever was mid-flight never finished - freeze those rows
                  // instead of leaving a spinner running forever.
                  applyLive((items) =>
                    items.map((item) =>
                      item.kind === "tool" &&
                      (item.status === "pending" || item.status === "running")
                        ? { ...item, status: "denied", display: "not finished" }
                        : item,
                    ),
                  );
                }
                if (event.reason === "aborted") {
                  appendLive({
                    kind: "notice",
                    id: nextItemId("notice"),
                    level: "warn",
                    text: "interrupted",
                  });
                }
                break;

              default:
                break;
            }
          }
        } catch (error) {
          commitReasoning();
          appendLive({
            kind: "notice",
            id: nextItemId("notice"),
            level: "error",
            text: (error as Error).message,
          });
        } finally {
          // Commit the finished run: it never changes again, so Ink can print
          // it once and let it scroll away.
          const tail: LogItem[] = streamRef.current
            ? [
                {
                  kind: "assistant",
                  id: nextItemId("assistant"),
                  text: streamRef.current,
                },
              ]
            : [];
          const finished = [...liveRef.current, ...tail];
          liveRef.current = [];
          streamRef.current = "";
          setHistory((prev) => [...prev, ...finished]);
          setLive([]);
          setStreamingText("");
          applyReasoning(null);
          setBusy(false);
          setRunStartedAt(null);
        }
      })();
    },
    [agent, appendLive, applyLive, applyReasoning, applyStream, commitReasoning,
      options.onSessionStarted, updateTool],
  );

  const interrupt = useCallback(() => {
    agent.abort();
  }, [agent]);

  const reset = useCallback(() => {
    if (agent.busy) {
      pushNotice("warn", "wait for the current run before clearing the session");
      return;
    }
    agent.clearSession();
    liveRef.current = [];
    streamRef.current = "";
    setHistory([]);
    setLive([]);
    setStreamingText("");
    applyReasoning(null);
    setUsageDisplay(null);
  }, [agent, applyReasoning, pushNotice]);

  const clearUsageDisplay = useCallback(() => setUsageDisplay(null), []);

  return {
    agent,
    history,
    live,
    streamingText,
    reasoning,
    busy,
    runStartedAt,
    usageDisplay,
    send,
    interrupt,
    reset,
    clearUsageDisplay,
    pushNotice,
  };
}
