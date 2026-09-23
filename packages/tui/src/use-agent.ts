import { useCallback, useRef, useState } from "react";
import {
  Agent,
  type ModelProvider,
  type PermissionDecision,
  type PermissionHandler,
  type PermissionMode,
  type PermissionRequest,
  type Usage,
} from "@susan/harness";
import { type LogItem, nextItemId, type ToolItem } from "./session-state.js";

export interface UseAgentOptions {
  root: string;
  provider: ModelProvider;
  permissionMode: PermissionMode;
}

export interface AgentView {
  agent: Agent;
  /** Finished runs - immutable, so Ink can print them once and forget them. */
  history: LogItem[];
  /** The run in flight, still mutating. */
  live: LogItem[];
  streamingText: string;
  thinkingText: string;
  busy: boolean;
  status: string;
  usage: Usage;
  permission: PermissionRequest | null;
  send(input: string): void;
  answerPermission(decision: PermissionDecision): void;
  interrupt(): void;
  reset(): void;
  pushNotice(level: "info" | "warn" | "error", text: string): void;
}

const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
};

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
  const [thinkingText, setThinkingText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [usage, setUsage] = useState<Usage>(EMPTY_USAGE);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);

  const liveRef = useRef<LogItem[]>([]);
  const streamRef = useRef("");
  const resolvePermission = useRef<((d: PermissionDecision) => void) | null>(
    null,
  );
  const pendingRequest = useRef<PermissionRequest | null>(null);

  const applyLive = useCallback((fn: (items: LogItem[]) => LogItem[]) => {
    liveRef.current = fn(liveRef.current);
    setLive(liveRef.current);
  }, []);

  const applyStream = useCallback((text: string) => {
    streamRef.current = text;
    setStreamingText(text);
  }, []);

  const permissionHandler = useRef<PermissionHandler>((request) => {
    return new Promise<PermissionDecision>((resolve) => {
      resolvePermission.current = resolve;
      pendingRequest.current = request;
      setPermission(request);
      setStatus(`waiting for approval: ${request.toolName}`);
    });
  });

  const [agent] = useState(
    () =>
      new Agent({
        root: options.root,
        provider: options.provider,
        permissionMode: options.permissionMode,
        onPermissionRequest: (request) => permissionHandler.current(request),
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
      setStatus("thinking");
      applyStream("");
      setThinkingText("");
      liveRef.current = [
        { kind: "user", id: nextItemId("user"), text: input },
      ];
      setLive(liveRef.current);

      void (async () => {
        try {
          for await (const event of agent.run(input)) {
            switch (event.type) {
              case "text_delta":
                applyStream(streamRef.current + event.text);
                setStatus("responding");
                break;

              case "thinking_delta":
                setThinkingText((text) => (text + event.text).slice(-400));
                setStatus("thinking");
                break;

              case "text_end":
                applyStream("");
                setThinkingText("");
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
                setStatus(`${event.name}: ${event.summary}`);
                break;

              case "tool_result":
                updateTool(event.id, {
                  status: event.ok ? "done" : "error",
                  display: event.display,
                });
                break;

              case "usage":
                setUsage(event.total);
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
          setThinkingText("");
          setPermission(null);
          setBusy(false);
          setStatus("");
        }
      })();
    },
    [agent, appendLive, applyLive, applyStream, updateTool],
  );

  const answerPermission = useCallback((decision: PermissionDecision) => {
    const resolve = resolvePermission.current;
    const request = pendingRequest.current;
    resolvePermission.current = null;
    pendingRequest.current = null;
    setPermission(null);
    // The next event may be a while away (the tool is about to run), so move
    // the status off "waiting for approval" right now.
    setStatus(
      decision === "deny"
        ? "denied"
        : `${request?.toolName ?? "tool"}: ${request?.summary ?? "running"}`,
    );
    resolve?.(decision);
  }, []);

  const interrupt = useCallback(() => {
    if (resolvePermission.current) answerPermission("deny");
    agent.abort();
  }, [agent, answerPermission]);

  const reset = useCallback(() => {
    agent.session.clear();
    liveRef.current = [];
    streamRef.current = "";
    setHistory([]);
    setLive([]);
    setStreamingText("");
    setThinkingText("");
    setUsage(EMPTY_USAGE);
  }, [agent]);

  return {
    agent,
    history,
    live,
    streamingText,
    thinkingText,
    busy,
    status,
    usage,
    permission,
    send,
    answerPermission,
    interrupt,
    reset,
    pushNotice,
  };
}
