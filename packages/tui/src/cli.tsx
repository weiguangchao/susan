#!/usr/bin/env node
import path from "node:path";
import { render } from "ink";
import {
  AnthropicProvider,
  loadModelConfig,
  loadModelPreferences,
  MockProvider,
  OpenAIProvider,
  resolveSusanHome,
  type ModelProvider,
} from "@susan/harness";
import { App } from "./App.js";
import { runHeadless } from "./headless.js";
import { InputHistory } from "./input-history.js";
import { ModelSelection } from "./model-selection.js";

interface Options {
  root: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  prompt?: string;
  help: boolean;
}

const USAGE = `susan - a code agent in your terminal

usage
  susan [options]
  susan --prompt "list the source files"     run one request without the UI

options
  --cwd <dir>        project root the agent may touch (default: current dir)
  --provider <p>     configured provider name; without config: anthropic | openai | mock
  --model <id>       model id
  --base-url <url>   custom endpoint; implies --provider openai unless
                     --provider says otherwise
  --mock             use the scripted provider instead of a real API
  --prompt <text>    headless: run one request, print the result, exit
  --help             show this

providers
  anthropic   Claude over the Messages API      (default model claude-opus-5)
  openai      any OpenAI-compatible Chat Completions endpoint - OpenAI, vLLM,
              Ollama, LM Studio, DeepSeek, OpenRouter, ...  (default gpt-4o)
  mock        scripted replies, real loop and tools, no network

environment
  ANTHROPIC_API_KEY   selects the anthropic provider
  OPENAI_API_KEY      selects the openai provider
  OPENAI_BASE_URL     default endpoint for the openai provider
  SUSAN_MODEL         default model id for anthropic
  SUSAN_OPENAI_MODEL  default model id for openai
  SUSAN_HOME          session storage directory (default: ~/.susan)
                      also contains confg.json and model-state.json

examples
  susan                                        # pick from the environment
  susan --provider openai --model gpt-4o
  susan --base-url http://localhost:11434/v1 --model qwen2.5-coder
`;

function parseArgs(argv: string[]): Options {
  const options: Options = {
    root: process.cwd(),
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = argv[i + 1];
    switch (arg) {
      case "--cwd":
        if (value) options.root = path.resolve(value);
        i++;
        break;
      case "--model":
        if (value) options.model = value;
        i++;
        break;
      case "--provider":
        if (value) options.provider = value;
        i++;
        break;
      case "--base-url":
        if (value) {
          options.baseUrl = value;
          options.provider ??= "openai";
        }
        i++;
        break;
      case "--mock":
        options.provider = "mock";
        break;
      case "--prompt":
      case "-p":
        if (value) options.prompt = value;
        i++;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`susan: unknown option ${arg}`);
          process.exit(2);
        }
    }
  }

  return options;
}

/**
 * Explicit choice wins; otherwise take whichever credentials are present, with
 * Anthropic first. Nothing configured at all falls back to the mock so susan
 * still starts and shows what it would do.
 */
function pickProvider(options: Options): {
  provider: ModelProvider;
  mocked: boolean;
} {
  const hasAnthropic = Boolean(
    process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN,
  );
  const hasOpenAI = Boolean(
    process.env.OPENAI_API_KEY ?? process.env.OPENAI_BASE_URL,
  );

  const choice =
    options.provider ??
    (hasAnthropic ? "anthropic" : hasOpenAI ? "openai" : "mock");

  if (choice !== "anthropic" && choice !== "openai" && choice !== "mock") {
    throw new Error(`unknown provider ${choice}`);
  }

  switch (choice) {
    case "anthropic":
      return {
        provider: new AnthropicProvider({
          ...(options.model ? { model: options.model } : {}),
          ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
        }),
        mocked: false,
      };
    case "openai":
      return {
        provider: new OpenAIProvider({
          ...(options.model ? { model: options.model } : {}),
          ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
        }),
        mocked: false,
      };
    default:
      return { provider: new MockProvider(), mocked: true };
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const home = resolveSusanHome();
  const choices = await loadModelConfig(home);
  const selection = choices
    ? new ModelSelection(choices, await loadModelPreferences(home), home)
    : null;
  if (selection && options.baseUrl) throw new Error("--base-url cannot override a configured provider; edit confg.json");
  if (selection && (options.provider || options.model)) {
    const matching = selection.choices.filter((choice) =>
      (!options.provider || choice.providerName === options.provider) &&
      (!options.model || choice.model.id === options.model));
    if (matching.length !== 1) throw new Error("--provider and --model must identify one configured model");
    selection.select(`${matching[0]!.providerName}/${matching[0]!.model.id}`);
  }
  const { provider, mocked } = selection
    ? { provider: selection.provider(), mocked: false }
    : pickProvider(options);

  if (options.prompt !== undefined) {
    const code = await runHeadless({
      root: options.root,
      provider,
      prompt: options.prompt,
    });
    process.exit(code);
  }

  if (!process.stdin.isTTY) {
    console.error(
      "susan: no TTY. Run it in a terminal, or use --prompt for one-shot mode.",
    );
    process.exit(2);
  }

  const inputHistory = await InputHistory.load(home);

  const app = render(
    <App
      root={options.root}
      provider={provider}
      mocked={mocked}
      selection={selection}
      inputHistory={inputHistory}
    />,
  );
  await app.waitUntilExit();
}

main().catch((error: unknown) => {
  console.error(`susan: ${(error as Error).message}`);
  process.exit(1);
});
