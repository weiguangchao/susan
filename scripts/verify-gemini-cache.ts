import { join } from "node:path";
import { createProviderClient, loadConfig } from "../src/config.js";
import type {
  CompletionMessage,
  ProviderClient,
  ProviderUsage,
  ReasoningEffort,
} from "../src/core/provider.js";

const PROVIDER_ALIAS = "cliproxyapi";
const MODEL = "gemini-3.8-flash-high";
const REASONING_EFFORT: ReasoningEffort = "max";
const CONFIG_PATH = join(process.cwd(), ".susan/config.json");
const PAD_UNIT =
  "You are Susan. Keep the session prefix stable so implicit prompt cache can hit. ";
const PAD_REPEAT = 1_200;

function statusBarCache(usage: {
  readonly sessionInputTokens: number;
  readonly sessionCachedInputTokens: number;
}): string {
  const visible =
    usage.sessionCachedInputTokens > 0 && usage.sessionInputTokens > 0;
  if (!visible) {
    return "(hidden)";
  }
  const rate =
    (usage.sessionCachedInputTokens / usage.sessionInputTokens) * 100;
  return `CH ${rate.toFixed(1)}%`;
}

async function complete(
  client: ProviderClient,
  messages: readonly CompletionMessage[],
): Promise<ProviderUsage> {
  let usage: ProviderUsage | undefined;
  let failure: string | undefined;
  for await (const event of client.stream(
    {
      model: MODEL,
      reasoningEffort: REASONING_EFFORT,
      messages,
    },
    AbortSignal.timeout(60_000),
  )) {
    if (event.type === "response-complete") {
      usage = event.response.usage;
    }
    if (event.type === "response-error") {
      failure = `${event.failure.code}: ${event.failure.message}`;
    }
  }
  if (failure !== undefined) {
    throw new Error(failure);
  }
  if (usage === undefined) {
    throw new Error("Provider stream completed without usage.");
  }
  return usage;
}

function printUsage(label: string, usage: ProviderUsage): void {
  const cached = usage.cachedInputTokens ?? 0;
  const hit =
    usage.inputTokens > 0 ? (cached / usage.inputTokens) * 100 : 0;
  console.log(
    `${label}: input=${usage.inputTokens} output=${usage.outputTokens} cached=${
      usage.cachedInputTokens ?? "absent"
    } hit=${usage.cachedInputTokens === undefined ? "n/a" : `${hit.toFixed(1)}%`}`,
  );
}

const loaded = await loadConfig({ configPath: CONFIG_PATH });
if (!loaded.ok) {
  throw new Error(
    `Unable to load ${CONFIG_PATH}: ${loaded.error.issues
      .map((issue) => issue.message)
      .join("; ")}`,
  );
}

const provider = loaded.config.providers[PROVIDER_ALIAS];
if (provider === undefined || provider.apiKey === undefined) {
  throw new Error(`Provider ${PROVIDER_ALIAS} is missing from ${CONFIG_PATH}.`);
}

const client = createProviderClient({
  type: provider.type,
  apiKey: provider.apiKey,
  baseURL: provider.baseURL,
});

const system: CompletionMessage = {
  role: "system",
  content: PAD_UNIT.repeat(PAD_REPEAT),
};

console.log(`model=${MODEL}`);
console.log(`provider=${PROVIDER_ALIAS}`);
console.log(`system_chars=${system.content.length}`);

const warm = await complete(client, [
  system,
  { role: "user", content: "Reply with exactly WARM." },
]);
printUsage("round 1 warm", warm);

await new Promise((resolve) => setTimeout(resolve, 1_000));

const hit = await complete(client, [
  system,
  { role: "user", content: "Reply with exactly WARM." },
  { role: "assistant", content: "WARM" },
  { role: "user", content: "Reply with exactly HIT." },
]);
printUsage("round 2 hit", hit);

const session = {
  sessionInputTokens: warm.inputTokens + hit.inputTokens,
  sessionCachedInputTokens:
    (warm.cachedInputTokens ?? 0) + (hit.cachedInputTokens ?? 0),
};
const bar = statusBarCache(session);
console.log(
  `session: input=${session.sessionInputTokens} cached=${session.sessionCachedInputTokens} status=${bar}`,
);

if (session.sessionCachedInputTokens === 0) {
  console.log("result: FAIL — Cache Hit Rate would stay hidden");
  process.exitCode = 1;
} else {
  console.log(`result: PASS — status bar would show ${bar}`);
}
