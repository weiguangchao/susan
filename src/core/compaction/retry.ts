// Pi 400d690 retryAssistantCall; Susan typed Provider result and clock adapters.
import type { ProviderFailure, ProviderResponse } from "../provider.js";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Generic quota/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",
]);

export async function retryAssistantCall(
  produce: () => Promise<ProviderResponse | ProviderFailure>,
  signal: AbortSignal,
  clock: { sleep(ms: number, signal?: AbortSignal): Promise<void> },
  onRetry: (attempt: 1 | 2, delay: number, failure: ProviderFailure) => void,
): Promise<ProviderResponse | ProviderFailure> {
  let attempt = 0;
  for (;;) {
    const response = await produce();
    if (!("code" in response) || response.code === "PROVIDER_ABORT" || response.code === "PROVIDER_INCOMPLETE") return response;
    const text = `${response.message} ${response.httpStatus ?? ""} ${response.code === "PROVIDER_NETWORK" ? "network error" : response.code === "PROVIDER_TIMEOUT" ? "timeout" : ""}`;
    if (attempt >= 2 || NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(text) || !RETRYABLE_PROVIDER_ERROR_PATTERN.test(text)) return response;
    attempt++;
    const delay = Math.min(1000 * 2 ** (attempt - 1), 60000);
    onRetry(attempt as 1 | 2, delay, response);
    try { await clock.sleep(delay, signal); }
    catch (error) {
      if (signal.aborted) return { code: "PROVIDER_ABORT", message: "Compaction aborted", hadSemanticOutput: false };
      throw error;
    }
  }
}
