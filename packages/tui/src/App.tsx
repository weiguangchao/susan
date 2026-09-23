import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import type { ModelProvider } from "@susan/harness";
import { Banner, bannerRows } from "./components/Banner.js";
import { Composer } from "./components/Composer.js";
import { LogEntry, LogList } from "./components/LogView.js";
import { StatusBar } from "./components/StatusBar.js";
import { Spinner } from "./components/Spinner.js";
import { runCommand } from "./commands.js";
import { InputHistory } from "./input-history.js";
import { ModelSelection } from "./model-selection.js";
import type { LogItem } from "./session-state.js";
import { glyphs, theme } from "./theme.js";
import { useAgent } from "./use-agent.js";
import { useTerminalFocus } from "./use-terminal-focus.js";

export interface AppProps {
  root: string;
  provider: ModelProvider;
  mocked: boolean;
  selection: ModelSelection | null;
  inputHistory: InputHistory;
}

type SpacerEntry = { kind: "spacer"; id: string; rows: number; afterHistory: number };
type StaticEntry = { kind: "banner"; id: "banner" } | SpacerEntry | LogItem;
const footerRows = 5; // Composer: 3, StatusBar: 2.

export function App({ root, provider, mocked, selection, inputHistory }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalFocused = useTerminalFocus();
  const [, refreshModel] = useState(0);
  const view = useAgent({ root, provider, onSessionStarted: () => selection?.recordUse() ?? Promise.resolve() });
  const historyCount = useRef(view.history.length);
  historyCount.current = view.history.length;
  const previousRows = useRef(stdout.rows ?? 24);
  const resizeId = useRef(0);
  const [resizeSpacers, setResizeSpacers] = useState<SpacerEntry[]>([]);
  const modelLabel = selection?.label ?? provider.label;
  // Print the initial gap once. Static preserves it in scrollback as output grows.
  const spacerRows = Math.max(0,
    (stdout.rows ?? 24) - bannerRows(root, modelLabel, mocked, stdout.columns ?? 80) - footerRows);

  useEffect(() => {
    const onResize = () => {
      const rows = stdout.rows ?? previousRows.current;
      const added = rows - previousRows.current;
      previousRows.current = rows;
      if (added > 0) setResizeSpacers((items) => [...items, {
        kind: "spacer", id: `resize-${++resizeId.current}`,
        rows: added, afterHistory: historyCount.current,
      }]);
    };
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  // The banner scrolls with the transcript instead of being re-painted every
  // frame, so it has to live inside <Static> as the first entry.
  const staticEntries: StaticEntry[] = useMemo(
    () => {
      const entries: StaticEntry[] = [
        { kind: "banner", id: "banner" },
        { kind: "spacer", id: "spacer", rows: spacerRows, afterHistory: 0 },
      ];
      for (let index = 0; index <= view.history.length; index++) {
        entries.push(...resizeSpacers.filter((item) => item.afterHistory === index));
        if (index < view.history.length) entries.push(view.history[index]!);
      }
      return entries;
    },
    [view.history, resizeSpacers, spacerRows],
  );

  useInput(
    (_input, key) => {
      if (key.escape && view.busy) view.interrupt();
    },
  );

  const handleSubmit = (value: string) => {
    void inputHistory.record(value).catch((error: unknown) =>
      view.pushNotice("error", `could not save input history: ${(error as Error).message}`));
    const handled = runCommand(value, {
      agent: view.agent,
      reset: view.reset,
      exit,
      notice: view.pushNotice,
      selection,
      onModelChange: () => {
        if (!selection) return;
        view.agent.setProvider(selection.provider());
        view.clearUsageDisplay();
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
              model={modelLabel}
              mocked={mocked}
            />
          ) : entry.kind === "spacer" ? (
            <Box key={entry.id} height={entry.rows} />
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
        terminalFocused={terminalFocused}
        initialHistory={inputHistory.entries}
        placeholder={
          view.busy ? "working - esc to interrupt" : "ask susan to do something"
        }
        onSubmit={handleSubmit}
      />

      <StatusBar
        root={root}
        usageDisplay={view.usageDisplay}
        contextWindow={selection?.current.model.contextWindow}
        model={modelLabel}
      />
    </Box>
  );
}
