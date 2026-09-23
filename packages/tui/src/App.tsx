import { useMemo, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { ModelProvider, PermissionMode } from "@susan/harness";
import { Banner } from "./components/Banner.js";
import { Composer } from "./components/Composer.js";
import { LogEntry, LogList } from "./components/LogView.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { StatusBar } from "./components/StatusBar.js";
import { runCommand } from "./commands.js";
import type { LogItem } from "./session-state.js";
import { glyphs, theme } from "./theme.js";
import { useAgent } from "./use-agent.js";

export interface AppProps {
  root: string;
  provider: ModelProvider;
  mode: PermissionMode;
  mocked: boolean;
}

type StaticEntry = { kind: "banner"; id: "banner" } | LogItem;

export function App({ root, provider, mode: initialMode, mocked }: AppProps) {
  const { exit } = useApp();
  const [mode, setMode] = useState<PermissionMode>(initialMode);
  const view = useAgent({ root, provider, permissionMode: initialMode });

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
    { isActive: view.permission === null },
  );

  const handleSubmit = (value: string) => {
    const handled = runCommand(value, {
      agent: view.agent,
      mode,
      setMode,
      reset: view.reset,
      exit,
      notice: view.pushNotice,
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
              model={provider.label}
              mode={mode}
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

      {view.permission ? (
        <PermissionPrompt
          request={view.permission}
          onAnswer={view.answerPermission}
        />
      ) : null}

      <Composer
        isActive={view.permission === null}
        placeholder={
          view.busy ? "working - esc to interrupt" : "ask susan to do something"
        }
        onSubmit={handleSubmit}
      />

      <StatusBar
        busy={view.busy}
        status={view.status}
        usage={view.usage}
        mode={mode}
      />
    </Box>
  );
}
