import OpenAI from "openai";
import { SUSAN_USER_AGENT } from "../../version";
import type {
  ProviderAdapter,
  ProviderClient,
  ProviderFailure,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
  ResolvedProviderConfig,
} from "../../core/provider";
import { failureFromError } from "./failures";
import { toChatCompletionsRequest } from "./request";
import { parseNonStreamingResponse } from "./response";
import {
  streamChatCompletions,
  type ChatCompletionsClient,
} from "./stream";

const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_BASE_URL = new URL("https://api.deepseek.com");

type OpenAIClientOptions = {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly defaultHeaders: { readonly "User-Agent": string };
};

type OpenAIClientFactory = (
  options: OpenAIClientOptions,
) => ChatCompletionsClient;

function createOpenAIClient(options: OpenAIClientOptions): ChatCompletionsClient {
  return new OpenAI(options);
}

function createClient(
  config: ResolvedProviderConfig,
  clientFactory: OpenAIClientFactory,
): ProviderClient {
  const client = clientFactory({
    apiKey: config.apiKey,
    baseURL: config.baseURL.href,
    timeout: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    // Replaces the SDK default User-Agent (OpenAI/JS x.y.z) intentionally.
    defaultHeaders: { "User-Agent": SUSAN_USER_AGENT },
  });

  return {
    type: "openai-completion",
    async *stream(
      request: ProviderRequest,
      signal: AbortSignal,
    ): AsyncGenerator<ProviderStreamEvent> {
      yield* streamChatCompletions(client, request, signal);
    },
    async complete(
      request: ProviderRequest,
      signal: AbortSignal,
    ): Promise<ProviderResponse | ProviderFailure> {
      if (signal.aborted) {
        return {
          code: "PROVIDER_ABORT",
          message: "Provider request was aborted.",
          hadSemanticOutput: false,
        };
      }
      try {
        const response = await client.chat.completions.create(
          toChatCompletionsRequest(request, false),
          { signal },
        );
        return parseNonStreamingResponse(response);
      } catch (error) {
        return failureFromError(error, false);
      }
    },
  };
}

export function createOpenAICompletionAdapter(
  clientFactory: OpenAIClientFactory = createOpenAIClient,
): ProviderAdapter {
  return {
    type: "openai-completion",
    defaultBaseURL: DEFAULT_BASE_URL,
    createClient(config: ResolvedProviderConfig): ProviderClient {
      return createClient(config, clientFactory);
    },
  };
}

export const openAICompletionProvider: ProviderAdapter =
  createOpenAICompletionAdapter();
