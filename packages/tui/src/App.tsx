import { useMemo, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { ModelProvider } from "@susan/harness";
import { Banner } from "./components/Banner.js";
import { Composer } from "./components/Composer.js";
import { LogEntry, LogList } from "./components/LogView.js";
import { StatusBar } from "./components/StatusBar.js";
import { Spinner } from "./components/Spinner.js";
import { runCommand } from "./commands.js";
import { ModelSelection } from "./model-selection.js";
import type { LogItem } from "./session-state.js";
import { glyphs, theme } from "./theme.js";
import { useAgent } from "./use-agent.js";

export interface AppProps {
  root: string;
  provider: ModelProvider;
  mocked: boolean;
  selection: ModelSelection | null;
}

type StaticEntry = { kind: "banner"; id: "banner" } | LogItem;

export function App({ root, provider, mocked, selection }: AppProps) {
  const { exit } = useApp();
  const [, refreshModel] = useState(0);
  const view = useAgent({ root, provider, onSessionStarted: () => selection?.recordUse() ?? Promise.resolve() });

  // The banner scrolls with the transcript instead of being re-painted every
  // frame, so it has to live inside <Static> as the first entry.
  const staticEntries: StaticEntry[] = useMemo(
    () => [{ kind: "banner", id: "banner" }, ...view.history],
    [view.history],
  );

  useInput(
    (_input, key) => {
      if (key.escape && view.busy) view.interrupt();
    },
  );

  const handleSubmit = (value: string) => {
    const handled = runCommand(value, {
      agent: view.agent,
      reset: view.reset,
      exit,
      notice: view.pushNotice,
      selection,
      onModelChange: () => {
        if (!selection) return;
        view.agent.setProvider(selection.provider());
        view.clearContextUsage();
        refreshModel((value) => value + 1);
        void selection.save().catch((error: unknown) =>
          view.pushNotice("error", `could not save model preference: ${(error as Error).message}`));
      },
      busy: view.busy,
    });
    if (!handled) view.send(value);
  };

  return (
    <Box flexDirection="column">
      <Static items={staticEntries}>
        {(entry) =>
          entry.kind === "banner" ? (
            <Banner
              key="banner"
              root={root}
              model={selection?.label ?? provider.label}
              mocked={mocked}
            />
          ) : (
            <LogEntry key={entry.id} item={entry} />
          )
        }
      </Static>

      <LogList items={view.live} />

      {view.thinkingText ? (
        <Box marginBottom={1}>
          <Text color={theme.thinking}>{glyphs.thinking} </Text>
          <Text color={theme.thinking} dimColor>
            {view.thinkingText}
          </Text>
        </Box>
      ) : null}

      {view.streamingText ? (
        <Box marginBottom={1}>
          <Text color={theme.text}>{view.streamingText}</Text>
        </Box>
      ) : null}

      {view.busy ? (
        <Box paddingX={1}>
          <Spinner color={theme.thinking} />
          <Text color={theme.thinking}> working</Text>
        </Box>
      ) : null}

      <Composer
        isActive
        placeholder={
          view.busy ? "working - esc to interrupt" : "ask susan to do something"
        }
        onSubmit={handleSubmit}
      />

      <StatusBar
        root={root}
        contextUsage={view.contextUsage}
        contextWindow={selection?.current.model.contextWindow}
        model={selection?.label ?? provider.label}
      />
    </Box>
  );
}
