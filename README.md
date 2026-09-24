# susan

A code agent in your terminal. TypeScript monorepo, two packages:

| Package | What lives there |
|---|---|
| `@susan/harness` | The harness: agent loop, tools, conversation state, model providers (Anthropic, OpenAI-compatible, mock). No UI code. |
| `@susan/tui` | The terminal UI: Ink components, key handling, slash commands. No model or tool logic. |

The seam between them is an event stream. `agent.run(input)` is an async
generator of `AgentEvent`s; the TUI renders them. Neither side reaches across.

## Run it

```bash
pnpm install
pnpm build
pnpm start                  # or: node packages/tui/dist/cli.js
```

With no credentials at all susan falls back to a scripted mock provider - the
loop and tools are real, only the model is
canned.

### Options

```
susan [options]

  --cwd <dir>        project root the agent may touch (default: current dir)
  --provider <p>     anthropic | openai | mock       (default: whichever key is set)
  --model <id>       model id
  --base-url <url>   OpenAI-compatible endpoint (implies --provider openai)
  --mock             use the scripted provider
  --prompt <text>    headless: run one request, print the result, exit
```

Headless mode is handy for scripting and for watching the raw event stream:

```bash
node packages/tui/dist/cli.js --prompt "what does the harness package do?"
```

## Providers

### Configure providers and models

Put `confg.json` in Susan Home (`SUSAN_HOME`, or `~/.susan` when unset).
`config.json` is also accepted when `confg.json` does not exist. For example:

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://gateway.example.com/v1",
      "type": "responses",
      "apiKey": "replace-with-your-key",
      "model": [
        {
          "id": "coder-model-id",
          "contextWindow": 128000,
          "outputToken": 8192,
          "reasoningEffort": { "low": null }
        }
      ]
    }
  }
}
```

`type` is `openai-completion`, `responses`, or `anthropic`. `model` accepts one
model object or an array.

`model` is optional. When a provider leaves it out, Susan fetches the
provider's model list at startup: `GET {baseUrl}/models?client_version=99.0.0`
for the OpenAI types, and `GET {baseUrl}/v1/models` for `anthropic`, as the
Anthropic SDK does. Codex-compatible gateways answer `client_version` with a
`models` catalog; other servers ignore it and return the usual `data` list.
Susan saves the lists to `models-cache.json` in Susan Home, keyed by provider
name, and `/model` lists these models. If the fetch fails, Susan uses the saved
list for that provider. If there is no saved list, Susan stops with an error.
Susan reads each model's limits from the listing when the endpoint reports them
(`max_input_tokens`/`max_tokens` from Anthropic; `context_window`, falling back
to `max_context_window`, from Codex catalogs; `context_length`,
`max_model_len`, or `max_completion_tokens` from gateways such as OpenRouter
and vLLM). Missing limits default to a 128000 token
`contextWindow` and an 8192 token `outputToken`. To set other limits, list the
model in `model`. `outputToken` limits each model request;
`contextWindow` records the model's capacity for configuration validation.
`reasoningEffort` is optional. Each type has built-in levels; setting a level
to `null` hides it from selection. In the example, `/reasoning` will not show
`low`. The built-in levels are:

| Type | Levels |
|---|---|
| `openai-completion` | none, minimal, low, medium, high, xhigh, max |
| `responses` | none, minimal, low, medium, high, xhigh, max |
| `anthropic` | low, medium, high, xhigh, max |

These are API-level choices, not a guarantee that every model accepts every
level. Check the model's supported levels and hide unsupported choices with
`reasoningEffort` entries set to `null`.

`reasoningLevels` is optional. It lists the levels a model supports, such as
`["low", "high", "ultra"]`, and replaces the type's built-in levels;
`reasoningEffort` then applies to that list. An empty list means the model takes
no level, so `/reasoning` offers only `default`. When a Codex catalog reports a
model's `supported_reasoning_levels`, Susan saves them as `reasoningLevels` in
`models-cache.json`.

Use `/model` to list configured models and `/model my-gateway/coder-model-id`
to switch. Use `/reasoning` to list visible levels, with `default` first. Use
`/reasoning high` to select a level or `/reasoning default` to let the provider
choose. Susan saves each provider/model's selected level in
`model-state.json` under Susan Home and restores it on the next switch or run.
Until a level is selected, Susan omits the effort field and lets the provider
choose its default.
After a TUI conversation starts, Susan also saves its model in `model-state.json`
and selects that model on the next launch. Selecting a model without sending a
message does not change the next launch's default.
When there is no configuration file, the CLI and environment behavior below
still applies.

| Provider | Selected by | Default model |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-opus-5` |
| `openai` | `OPENAI_API_KEY` or `OPENAI_BASE_URL` | `gpt-4o` |
| `mock` | nothing configured, or `--mock` | - |

An explicit `--provider` always wins; otherwise Anthropic is preferred when
both keys are present.

```bash
# Claude
ANTHROPIC_API_KEY=sk-ant-... pnpm start

# OpenAI
OPENAI_API_KEY=sk-... pnpm start --provider openai --model gpt-4o

# Anything that speaks OpenAI Chat Completions: vLLM, Ollama, LM Studio,
# DeepSeek, OpenRouter, ...
node packages/tui/dist/cli.js --base-url http://localhost:11434/v1 --model qwen2.5-coder
```

A provider is one small interface - `stream(request)` returns an async iterable
of deltas plus a `final()` - so adding another is one file in
`packages/harness/src/providers/`. Nothing above it changes.

The two wire formats disagree in places the provider has to reconcile:

| | Anthropic | OpenAI-compatible |
|---|---|---|
| Tool results | all blocks in one `user` message | one `tool` message per call |
| Tool arguments | parsed JSON object | JSON **string** to parse (and it can be malformed) |
| Reasoning | `thinking` blocks, replayed with signatures | dropped; `reasoning_content` deltas are shown when a server sends them |
| Usage while streaming | on the message | only with `stream_options.include_usage` |
| Stop reason | `stop_reason` | `finish_reason`, and some servers say `stop` even with tool calls |

Assistant turns keep the producing provider's own payload, tagged with its
provider id, so replay is byte-exact where it matters and a mid-session
provider switch rebuilds the turn from neutral blocks instead of sending one
vendor's format to another.

## Tests

```bash
pnpm test
```

There are no mocks of the harness itself. Both providers are pointed at a local
server that speaks the real wire format - Messages API SSE for Anthropic, Chat
Completions SSE for OpenAI - so the tests exercise the actual streaming,
tool-call assembly and replay paths without a key or a network.

What they pin down:

| | |
|---|---|
| Request shape | adaptive thinking, effort, `cache_control`, frozen tool order, eager input streaming |
| Streaming | tool inputs arriving in fragments are reassembled correctly |
| Replay | thinking blocks go back with their signature byte-exact |
| Batching | every tool result for a turn lands in one user message (Anthropic) / one `tool` message per call (OpenAI) |
| Stop reasons | `refusal` and truncated `max_tokens` never run the tool; `pause_turn` resumes |
| Bad input | unparseable tool arguments become an error result, not a wrong call |
| Tool execution | Valid tool calls run automatically |
| Invariant | every `tool_use` has a matching `tool_result`, whatever went wrong |
| Sandbox | `../` and absolute paths rejected; interrupt kills the whole process tree |

## Keys and commands

```
enter        send                 esc      interrupt the run
up / down    input history        ctrl+c   quit
/help  /tools  /cost  /clear  /exit
```

Up and down browse the last 100 submitted inputs, including inputs from other
providers and models. The history is saved in `SUSAN_HOME/input-history.json`
and remains available after restarting Susan. Down restores an unfinished draft.

## Saved sessions

Susan saves each conversation as JSONL under `SUSAN_HOME/session/YYYY/MM/`.
`SUSAN_HOME` defaults to `~/.susan`. The repository's `pnpm start` and
`pnpm dev` scripts set it to `.susan` in the repository root.
Filenames start with local date and time and end with the first user input's
12-character SHA-256 prefix.
The first line records the session and project root; following lines record
user messages, assistant messages, tool results, and per-turn token usage.
`/clear` starts a new file on the next message. Saved sessions are not yet
loaded into the UI on startup.

## Tools

| Tool | Risk | What it does |
|---|---|---|
| `read` | safe | Read a file with line numbers, `offset`/`limit` for big ones |
| `ls` | safe | List a directory, `depth` to recurse, skips `node_modules`/`.git`/… |
| `grep` | safe | Regex search over file contents, `include` glob filter |
| `write` | write | Write a file, creating parent directories |
| `edit` | write | Exact string replacement, unique match required |
| `bash` | exec | Run a shell command from the project root |

All tools run automatically after their inputs pass validation.

## How the loop works

```
user input
   │
   ▼
┌──────────────────────────────────────────────┐
│ Agent.run()                                  │
│   build request (system + frozen tool list   │──▶ ModelProvider.stream()
│                 + full history)              │◀── text / thinking deltas
│   stream deltas ────────────────────────────────▶ AgentEvent
│   stop_reason?                               │
│     end_turn  → done                         │
│     refusal   → stop, never run the tools    │
│     max_tokens+tool_use → stop, input may be │
│                           truncated          │
│     pause_turn → re-send                     │
│     tool_use  → ▼                            │
│   for each tool_use:                         │
│     parse input (zod)   ─ bad → error result │
│     run valid calls in parallel              │
│   append every result in ONE user message    │
│   loop                                       │
└──────────────────────────────────────────────┘
```

Things the loop takes seriously:

- **Every `tool_use` gets a `tool_result`.** Parse failures and
  crashes all come back as error results rather than vanishing - a missing
  result makes the next request malformed.
- **Model output is untrusted.** Tool inputs are validated with Zod before they
  run, and every path is resolved inside the project root; `../` and absolute
  paths are rejected.
- **History is append-only.** Assistant turns are replayed as the provider's own
  blocks, so thinking-block signatures round-trip intact.
- **Interrupts reach the process tree.** `bash` runs detached, so esc kills the
  whole group instead of orphaning grandchildren that hold the pipes open.
- **Results are batched.** All results for one turn go back in a single user
  message, which is what keeps the model making parallel calls.

## Tool execution

Susan runs valid tool calls automatically. Tool inputs are still validated, and
file paths must stay inside the project root. After a prompt is submitted, the
status bar shows usage estimates while the agent runs. Provider measurements
replace them as they arrive. The cache hit rate uses all measured requests in
the current session. When the run finishes, the bar keeps the last measured
request usage against the selected model's context window.

## Adding a tool

```ts
import { defineTool, ok, fail } from "@susan/harness";
import { z } from "zod";

export const wcTool = defineTool({
  name: "wc",
  description: "Count the lines in a file.",
  risk: "safe",
  schema: z.object({ path: z.string() }),
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  summarize: (input) => input.path,
  async run(input, ctx) {
    // ctx.root is the sandbox; ctx.signal aborts on esc
    return ok("42", "42 lines");
  },
});
```

Then add it to the list in `packages/harness/src/tools/index.ts`. Order there
is deliberate: the tool list is part of the cached request prefix, so it must
not shuffle between turns.

## Layout

```
packages/harness/src/
  loop.ts              the agent loop
  session.ts           conversation state + token totals
  prompt.ts            system prompt
  paths.ts             project-root confinement
  types.ts             the shared vocabulary
  model/               model config, model discovery, reasoning levels, model preferences
  tools/               read write edit ls grep bash
  providers/           anthropic.ts, openai.ts, mock.ts

packages/harness/test/
  harness.test.mjs     the suite
  fakes/               servers that speak each provider's real wire format

packages/tui/src/
  cli.tsx              arg parsing, provider choice, entry point
  App.tsx              layout and wiring
  use-agent.ts         harness events → React state
  commands.ts          slash commands
  headless.ts          --prompt mode
  components/          Banner Composer LogView StatusBar
```
