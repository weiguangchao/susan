import type {
  HarnessEvent,
  HarnessSnapshot,
  HarnessStatus,
  PendingAgentLoop,
  ToolResult,
} from "../core/harness.js";
import type {
  ProviderFailure,
  ProviderToolCall,
} from "../core/provider.js";

export type TuiMessage =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "interrupted"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

export type TuiToolStatus =
  | "waiting-approval"
  | "running"
  | "completed"
  | "denied"
  | "failed"
  | "interrupted";

export type TuiToolCard = {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly status: TuiToolStatus;
  readonly summary: string;
  readonly preview?: readonly string[];
};

export type TuiApproval = {
  readonly approvalId: string;
  readonly toolCall: ProviderToolCall;
};

export type TuiRetry = {
  readonly reason: string;
  readonly retry: 1 | 2;
  readonly maxRetries: 2;
  readonly delayMs: number;
  readonly startedAt: number;
};

export type TuiState = {
  readonly status: HarnessStatus;
  readonly messages: readonly TuiMessage[];
  readonly tools: readonly TuiToolCard[];
  readonly approval: TuiApproval | null;
  readonly stream: {
    readonly text: string;
    readonly reasoning: string;
  } | null;
  readonly retry: TuiRetry | null;
  readonly failure: ProviderFailure | null;
  readonly pending: PendingAgentLoop | null;
  readonly notice: string | null;
  readonly input: string;
};

export type TuiInputKey = {
  readonly input: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
};

export type TuiInputIntent =
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "newline" }
  | { readonly type: "backspace" }
  | { readonly type: "submit"; readonly content: string }
  | { readonly type: "clear-input" }
  | { readonly type: "clear" }
  | { readonly type: "exit" }
  | { readonly type: "interrupt" }
  | { readonly type: "approve-approval"; readonly approvalId: string }
  | { readonly type: "deny-approval"; readonly approvalId: string }
  | { readonly type: "retry" }
  | { readonly type: "new-session" }
  | { readonly type: "dismiss-failure" }
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "none" };

export type TuiSubmissionIntent =
  | { readonly type: "exit" }
  | { readonly type: "clear" }
  | { readonly type: "submit"; readonly content: string };

export type TuiAction =
  | { readonly type: "harness-event"; readonly event: HarnessEvent }
  | { readonly type: "snapshot"; readonly snapshot: HarnessSnapshot }
  | { readonly type: "input-key"; readonly key: TuiInputKey }
  | { readonly type: "input-intent"; readonly intent: TuiInputIntent }
  | { readonly type: "notice"; readonly message: string }
  | { readonly type: "clear-input" }
  | { readonly type: "new-session"; readonly snapshot: HarnessSnapshot };

const emptyStream = { text: "", reasoning: "" };

export function createTuiState(snapshot: HarnessSnapshot): TuiState {
  return {
    status: snapshot.status,
    messages: snapshot.messages.flatMap(messageToTuiMessages),
    tools: [],
    approval: null,
    stream: null,
    retry: null,
    failure: null,
    pending: snapshot.pending,
    notice: snapshot.pending === null ? null : pendingNotice(snapshot.pending),
    input: "",
  };
}

export function normalizeSubmission(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function resolveSubmission(value: string): TuiSubmissionIntent {
  const content = normalizeSubmission(value);
  if (content === "/exit") {
    return { type: "exit" };
  }
  if (content === "/clear") {
    return { type: "clear" };
  }
  return { type: "submit", content };
}

export function resolveInputIntent(
  state: TuiState,
  key: TuiInputKey,
): TuiInputIntent {
  if (key.ctrl && key.input === "c") {
    if (state.approval !== null) {
      return {
        type: "deny-approval",
        approvalId: state.approval.approvalId,
      };
    }
    if (state.status === "running" || state.status === "awaiting-approval") {
      return { type: "interrupt" };
    }
    if (state.input !== "") {
      return { type: "clear-input" };
    }
    return { type: "exit" };
  }

  if (key.ctrl && key.input === "j") {
    return { type: "newline" };
  }
  if (key.input === "\n" && key.return !== true) {
    return { type: "newline" };
  }
  if (key.shift && key.input === " ") {
    return { type: "newline" };
  }

  if (state.approval !== null) {
    if (key.return) {
      return {
        type: "approve-approval",
        approvalId: state.approval.approvalId,
      };
    }
    if (key.escape) {
      return {
        type: "deny-approval",
        approvalId: state.approval.approvalId,
      };
    }
    return { type: "none" };
  }

  if (key.escape && state.failure !== null) {
    return { type: "dismiss-failure" };
  }

  if (state.status === "running" || state.status === "awaiting-approval") {
    if (key.return) {
      return { type: "notice", message: "生成中 · Ctrl+C 可中断" };
    }
    if (key.backspace) {
      return { type: "backspace" };
    }
    return { type: "insert", text: key.input };
  }

  if (state.status === "pending") {
    if (state.input === "") {
      if (key.input === "r") {
        return { type: "retry" };
      }
      if (key.input === "n") {
        return { type: "new-session" };
      }
      if (key.return && state.failure !== null) {
        return { type: "retry" };
      }
      if (key.return) {
        return {
          type: "notice",
          message: "Pending Agent Loop · r 重试 · n 新对话",
        };
      }
    }
    if (key.backspace) {
      return { type: "backspace" };
    }
    if (key.return) {
      return {
        type: "notice",
        message: "Pending Agent Loop · 清空输入后 r 重试 / n 新对话",
      };
    }
    return { type: "insert", text: key.input };
  }

  if (key.backspace) {
    return { type: "backspace" };
  }
  if (key.return) {
    const submission = resolveSubmission(state.input);
    if (submission.type === "submit" && submission.content.length === 0) {
      return { type: "none" };
    }
    return submission;
  }
  if (key.input === "") {
    return { type: "none" };
  }
  return { type: "insert", text: key.input };
}

export function reduceTuiState(
  state: TuiState,
  action: TuiAction,
): TuiState {
  switch (action.type) {
    case "harness-event":
      return reduceHarnessEvent(state, action.event);
    case "snapshot":
      return {
        ...state,
        status: action.snapshot.status,
        pending: action.snapshot.pending,
        ...(action.snapshot.pending === null
          ? {}
          : { notice: pendingNotice(action.snapshot.pending) }),
      };
    case "input-key":
      return applyInputIntent(state, resolveInputIntent(state, action.key));
    case "input-intent":
      return applyInputIntent(state, action.intent);
    case "notice":
      return { ...state, notice: action.message };
    case "clear-input":
      return { ...state, input: "", notice: null };
    case "new-session":
      return createTuiState(action.snapshot);
    default:
      return state;
  }
}

function applyInputIntent(
  state: TuiState,
  intent: TuiInputIntent,
): TuiState {
  switch (intent.type) {
    case "insert":
      return { ...state, input: state.input + intent.text, notice: null };
    case "newline":
      return { ...state, input: `${state.input}\n`, notice: null };
    case "backspace":
      return { ...state, input: state.input.slice(0, -1), notice: null };
    case "submit":
      return {
        ...state,
        status: "running",
        messages: [
          ...state.messages,
          { kind: "user", text: intent.content },
        ],
        input: "",
        notice: null,
        failure: null,
      };
    case "clear-input":
      return { ...state, input: "", notice: "已清空输入" };
    case "notice":
      return { ...state, notice: intent.message };
    case "approve-approval":
    case "deny-approval":
      const deniedToolId = state.approval?.toolCall.id;
      return {
        ...state,
        status: "running",
        approval: null,
        ...(intent.type === "deny-approval"
          ? {
              tools:
                deniedToolId === undefined
                  ? state.tools
                  : denyTool(state.tools, deniedToolId),
            }
          : {}),
      };
    case "retry":
      return {
        ...state,
        status: "running",
        pending: null,
        failure: null,
        notice: null,
      };
    case "dismiss-failure":
      return { ...state, failure: null, notice: "已放弃重试 · Pending Agent Loop 保留" };
    default:
      return state;
  }
}

function reduceHarnessEvent(
  state: TuiState,
  event: HarnessEvent,
): TuiState {
  switch (event.type) {
    case "text-delta":
    case "reasoning-delta": {
      const stream = state.stream ?? emptyStream;
      return {
        ...state,
        stream: {
          text:
            event.type === "text-delta"
              ? stream.text + event.textDelta
              : stream.text,
          reasoning:
            event.type === "reasoning-delta"
              ? stream.reasoning + event.textDelta
              : stream.reasoning,
        },
        retry: null,
        notice: null,
      };
    }
    case "tool-call-delta": {
      const id = event.id ?? `tool-call-${event.index}`;
      const tools =
        event.id === undefined
          ? state.tools
          : state.tools.filter((tool) => tool.id !== `tool-call-${event.index}`);
      return {
        ...state,
        tools: upsertTool(tools, {
          id,
          name: event.name ?? "tool",
          detail: "",
          status: "waiting-approval",
          summary: "等待审批",
        }),
      };
    }
    case "approval-requested":
      return {
        ...state,
        approval: {
          approvalId: event.approvalId,
          toolCall: event.toolCall,
        },
        tools: upsertTool(state.tools, toolCard(event.toolCall, "waiting-approval")),
        notice: null,
      };
    case "tool-started":
      return {
        ...state,
        tools: updateTool(
          state.tools,
          event.toolCall.id,
          toolCard(event.toolCall, "running"),
        ),
      };
    case "tool-completed": {
      const card = completedToolCard(event.toolCall, event.result);
      return {
        ...state,
        tools: updateTool(state.tools, event.toolCall.id, card),
      };
    }
    case "tool-round-limit-reached":
      return { ...state, notice: `Tool 轮次达到上限 ${event.limit}，改为无 Tool 最终请求` };
    case "context-compacted":
      return {
        ...state,
        notice: `上下文已压缩 · ${event.tokensBefore} → ${event.tokensAfterEstimate} est.`,
      };
    case "compaction-failed":
      return {
        ...state,
        messages: [...state.messages, { kind: "error", text: event.message }],
      };
    case "provider-retrying":
      return {
        ...state,
        retry: {
          reason: formatProviderFailure(event.failure),
          retry: event.retry,
          maxRetries: event.maxRetries,
          delayMs: event.delayMs,
          startedAt: Date.now(),
        },
        notice: null,
      };
    case "agent-loop-completed":
      return {
        ...state,
        messages: finalizeStream(state),
        stream: null,
        retry: null,
        failure: null,
        pending: null,
        status: "idle",
        notice: null,
      };
    case "provider-failed":
      return {
        ...state,
        retry: null,
        failure: event.failure,
        pending: { reason: "provider-failure", failure: event.failure },
        status: "pending",
      };
    case "interrupted-response":
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            kind: "interrupted",
            text: event.response.content ?? event.response.reasoning ?? "",
          },
        ],
        stream: null,
        retry: null,
        failure: event.failure,
        pending: { reason: "interrupted", failure: event.failure },
        status: "pending",
      };
    case "agent-loop-interrupted":
      return {
        ...state,
        stream: null,
        retry: null,
        tools: state.tools.map((tool) =>
          tool.status === "running" ? { ...tool, status: "interrupted", summary: "已中断" } : tool,
        ),
        pending: { reason: "user-interrupt" },
        status: "pending",
        notice: "Agent Loop 已中断",
      };
    case "harness-failed":
      return {
        ...state,
        messages: [...state.messages, { kind: "error", text: event.error.message }],
      };
    default:
      return state;
  }
}

function messageToTuiMessages(message: HarnessSnapshot["messages"][number]): TuiMessage[] {
  if (message.role === "user") {
    return [{ kind: "user", text: message.content }];
  }
  if (message.role === "assistant") {
    return [
      ...(message.reasoning === undefined
        ? []
        : [{ kind: "reasoning" as const, text: message.reasoning }]),
      ...(message.content === undefined
        ? []
        : [{ kind: "assistant" as const, text: message.content }]),
    ];
  }
  return [];
}

function finalizeStream(state: TuiState): readonly TuiMessage[] {
  if (state.stream === null) {
    return state.messages;
  }
  return [
    ...state.messages,
    ...(state.stream.reasoning === ""
      ? []
      : [{ kind: "reasoning" as const, text: state.stream.reasoning }]),
    ...(state.stream.text === ""
      ? []
      : [{ kind: "assistant" as const, text: state.stream.text }]),
  ];
}

function pendingNotice(pending: PendingAgentLoop): string {
  if (pending.reason === "restored") {
    return "上次响应未完成（Pending Agent Loop）";
  }
  if (pending.reason === "interrupted" || pending.reason === "user-interrupt") {
    return "响应未完成（Interrupted Response / Pending Agent Loop）";
  }
  return pending.failure === undefined
    ? "上次响应未完成（Pending Agent Loop）"
    : formatProviderFailure(pending.failure);
}

export function formatProviderFailure(failure: ProviderFailure): string {
  return [
    failure.httpStatus === undefined ? failure.code : `${failure.httpStatus}`,
    failure.message,
    ...(failure.requestId === undefined ? [] : [`request_id: ${failure.requestId}`]),
  ].join(" · ");
}

function toolCard(
  toolCall: ProviderToolCall,
  status: TuiToolStatus,
): TuiToolCard {
  return {
    id: toolCall.id,
    name: toolCall.name,
    detail: formatToolCallDetail(toolCall),
    status,
    summary:
      status === "waiting-approval"
        ? "等待审批"
        : status === "running"
          ? "执行中"
          : "",
  };
}

function completedToolCard(
  toolCall: ProviderToolCall,
  result: ToolResult,
): TuiToolCard {
  const card = toolCard(toolCall, result.ok ? "completed" : "failed");
  if (!result.ok) {
    const denied = result.error.code === "EAPPROVAL_DENIED";
    return {
      ...card,
      status: denied ? "denied" : "failed",
      summary: `${result.error.code} · ${result.error.message}`,
    };
  }

  const value = result.result;
  if (
    toolCall.name === "read_file" &&
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).content === "string"
  ) {
    const record = value as {
      path?: unknown;
      content: string;
      truncated?: unknown;
    };
    const content = record.content;
    const lines = content.split("\n");
    const bytes = new TextEncoder().encode(content).length;
    return {
      ...card,
      summary: `已读 ${lines.length} 行 · ${bytes} B${record.truncated === true ? " · 截断" : ""}`,
      preview: lines.slice(0, 2),
      detail: formatToolCallDetail(toolCall),
    };
  }
  return { ...card, summary: "完成" };
}

export function formatToolCallDetail(toolCall: ProviderToolCall): string {
  const arguments_ = toolCall.arguments;
  if (typeof arguments_ !== "object" || arguments_ === null) {
    return toolCall.name;
  }
  const record = arguments_ as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  const offset =
    typeof record.offset === "number" ? ` offset=${record.offset}` : "";
  const limit =
    typeof record.limit === "number" ? ` limit=${record.limit}` : "";
  return path === undefined ? toolCall.name : `${path}${offset}${limit}`;
}

function upsertTool(
  tools: readonly TuiToolCard[],
  next: TuiToolCard,
): readonly TuiToolCard[] {
  return updateTool(tools, next.id, next);
}

function updateTool(
  tools: readonly TuiToolCard[],
  id: string,
  next: TuiToolCard,
): readonly TuiToolCard[] {
  const index = tools.findIndex((tool) => tool.id === id);
  if (index === -1) {
    return [...tools, next];
  }
  return tools.map((tool, toolIndex) => (toolIndex === index ? next : tool));
}

function denyTool(
  tools: readonly TuiToolCard[],
  approvalId: string,
): readonly TuiToolCard[] {
  const tool = tools.find((candidate) => candidate.id === approvalId);
  if (tool === undefined) {
    return tools;
  }
  return tools.map((candidate) =>
    candidate.id === tool.id
      ? { ...candidate, status: "denied" as const, summary: "EAPPROVAL_DENIED · 已拒绝" }
      : candidate,
  );
}
