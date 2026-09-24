import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { writeFileAtomic } from "../atomic-write.js";
import { modelSchema, type ModelConfig, type ProviderConfig } from "./schema.js";

/** Used when the models endpoint does not report a model's limits. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_OUTPUT_TOKEN = 8_192;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_FILE = "models-cache.json";
/** High enough to pass the `minimal_client_version` filter of Codex catalogs. */
const CODEX_CLIENT_VERSION = "99.0.0";

/** Provider name to the models its endpoint last returned. */
type ModelCache = Record<string, ModelConfig[]>;
const cachedModelsSchema = modelSchema.array().min(1);

function firstLimit(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * Reads limits from the field names used by Anthropic, OpenRouter, vLLM and
 * similar gateways. `context_window` wins over `max_context_window`. Reads
 * reasoning levels from Codex catalogs.
 */
export function modelFromListing(raw: Record<string, unknown>): ModelConfig {
  const top = raw.top_provider as Record<string, unknown> | undefined;
  const contextWindow = firstLimit(raw.max_input_tokens, raw.context_window,
    raw.max_context_window, raw.context_length, raw.max_model_len, top?.context_length) ?? DEFAULT_CONTEXT_WINDOW;
  const outputToken = firstLimit(raw.max_tokens, raw.max_output_tokens,
    raw.max_completion_tokens, top?.max_completion_tokens) ?? DEFAULT_OUTPUT_TOKEN;
  const model: ModelConfig = { id: String(raw.id), contextWindow, outputToken: Math.min(outputToken, contextWindow) };
  const levels = reasoningLevels(raw.supported_reasoning_levels);
  return levels ? { ...model, reasoningLevels: levels } : model;
}

/** Codex catalogs list levels as `[{ effort, description }]`. */
function reasoningLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = value.map((item) => (item as Record<string, unknown> | null)?.effort)
    .filter((effort): effort is string => typeof effort === "string" && effort.length > 0);
  return [...new Set(levels)];
}

async function* listModels(provider: ProviderConfig): AsyncGenerator<Record<string, unknown>> {
  const options = { baseURL: provider.baseUrl, apiKey: provider.apiKey || "not-needed",
    timeout: FETCH_TIMEOUT_MS, maxRetries: 0 };
  if (provider.type === "anthropic") {
    for await (const item of new Anthropic(options).models.list()) yield item as unknown as Record<string, unknown>;
    return;
  }
  // Codex-compatible gateways answer a request with `client_version` with a
  // `models` catalog that carries context windows; others ignore it and send `data`.
  const body = await new OpenAI(options).get<{ data?: unknown; models?: unknown }>("/models",
    { query: { client_version: CODEX_CLIENT_VERSION } });
  const items = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    yield raw.id === undefined ? { ...raw, id: raw.slug } : raw;
  }
}

export async function fetchProviderModels(provider: ProviderConfig): Promise<ModelConfig[]> {
  const models: ModelConfig[] = [];
  for await (const raw of listModels(provider)) {
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
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const cache: ModelCache = {};
    for (const [name, models] of Object.entries(value)) {
      const parsed = cachedModelsSchema.safeParse(models);
      if (parsed.success) cache[name] = parsed.data;
    }
    return cache;
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
 * Susan Home. A provider whose fetch fails uses its saved list.
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
    const result = fetched[index]!;
    const previous = saved[name];
    if (result.status === "fulfilled") {
      cache[name] = result.value;
    } else if (previous) {
      cache[name] = previous;
    } else {
      const reason = (result.reason as Error).message;
      throw new Error(`${name}: cannot load models from ${providers[name]!.baseUrl}: ${reason}`);
    }
  });
  if (fetched.some((result) => result.status === "fulfilled")) {
    await writeCache(file, { ...saved, ...cache });
  }
  return cache;
}
