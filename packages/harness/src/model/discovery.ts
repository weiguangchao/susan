import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { writeFileAtomic } from "../atomic-write.js";
import type { ModelConfig, ProviderConfig } from "./schema.js";

/** Used when the models endpoint does not report a model's limits. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_OUTPUT_TOKEN = 8_192;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_FILE = "models.json";

interface CachedProvider {
  baseUrl: string;
  type: ProviderConfig["type"];
  models: ModelConfig[];
}

type ModelCache = Record<string, CachedProvider>;

function firstLimit(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** Reads limits from the field names used by Anthropic, OpenRouter, vLLM and similar gateways. */
export function modelFromListing(raw: Record<string, unknown>): ModelConfig {
  const top = raw.top_provider as Record<string, unknown> | undefined;
  const contextWindow = firstLimit(raw.max_input_tokens, raw.context_window,
    raw.context_length, raw.max_model_len, top?.context_length) ?? DEFAULT_CONTEXT_WINDOW;
  const outputToken = firstLimit(raw.max_tokens, raw.max_output_tokens,
    raw.max_completion_tokens, top?.max_completion_tokens) ?? DEFAULT_OUTPUT_TOKEN;
  return { id: String(raw.id), contextWindow, outputToken: Math.min(outputToken, contextWindow) };
}

export async function fetchProviderModels(provider: ProviderConfig): Promise<ModelConfig[]> {
  const options = { baseURL: provider.baseUrl, apiKey: provider.apiKey || "not-needed",
    timeout: FETCH_TIMEOUT_MS, maxRetries: 0 };
  const client = provider.type === "anthropic" ? new Anthropic(options) : new OpenAI(options);
  const models: ModelConfig[] = [];
  for await (const item of client.models.list()) {
    const raw = item as unknown as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id) continue;
    if (models.some((model) => model.id === raw.id)) continue;
    models.push(modelFromListing(raw));
  }
  if (!models.length) throw new Error("the models endpoint returned no models");
  return models;
}

async function readCache(file: string): Promise<ModelCache> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as ModelCache : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

function writeCache(file: string, cache: ModelCache): Promise<void> {
  return writeFileAtomic(file, JSON.stringify(cache, null, 2) + "\n");
}

/**
 * Fetches the model list of every given provider and saves the results in
 * Susan Home. A provider whose fetch fails uses its saved list, as long as its
 * baseUrl and type have not changed since that list was saved.
 */
export async function discoverModels(
  providers: Record<string, ProviderConfig>, home: string,
): Promise<Record<string, ModelConfig[]>> {
  const names = Object.keys(providers);
  if (!names.length) return {};
  const file = path.join(home, CACHE_FILE);
  const [saved, fetched] = await Promise.all([
    readCache(file),
    Promise.allSettled(names.map((name) => fetchProviderModels(providers[name]!))),
  ]);
  const cache: ModelCache = {};
  names.forEach((name, index) => {
    const provider = providers[name]!;
    const result = fetched[index]!;
    const previous = saved[name];
    if (result.status === "fulfilled") {
      cache[name] = { baseUrl: provider.baseUrl, type: provider.type, models: result.value };
    } else if (previous?.baseUrl === provider.baseUrl && previous.type === provider.type
      && Array.isArray(previous.models) && previous.models.length) {
      cache[name] = previous;
    } else {
      const reason = (result.reason as Error).message;
      throw new Error(`${name}: cannot load models from ${provider.baseUrl}: ${reason}`);
    }
  });
  if (fetched.some((result) => result.status === "fulfilled")) {
    await writeCache(file, { ...saved, ...cache });
  }
  return Object.fromEntries(names.map((name) => [name, cache[name]!.models]));
}
