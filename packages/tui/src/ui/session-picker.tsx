import { Box, Text, useInput } from "ink";
import { useState } from "react";
import {
  createSessionPickerState,
  reduceSessionPickerState,
  resolveSessionPickerIntent,
} from "../core/picker";
import type { SessionSummary } from "@weiguangchao/susan-harness";

export type SessionPickerAppProps = {
  readonly sessions: readonly SessionSummary[];
  readonly onSelect: (sessionId: string) => void;
  readonly onNew: () => void;
  readonly onExit: () => void;
};

export function SessionPickerApp({
  sessions,
  onSelect,
  onNew,
  onExit,
}: SessionPickerAppProps) {
  const [state, setState] = useState(() => createSessionPickerState(sessions));

  useInput((input, key) => {
    const intent = resolveSessionPickerIntent({
      input,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
      return: key.return,
      escape: key.escape,
    });
    if (intent.type === "exit") {
      onExit();
      return;
    }
    if (intent.type === "new") {
      onNew();
      return;
    }
    if (intent.type === "select") {
      const selected = state.sessions[state.selectedIndex];
      if (selected !== undefined) {
        onSelect(selected.header.id);
      }
      return;
    }
    setState((current) => reduceSessionPickerState(current, intent));
  });

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text>恢复 Session</Text>
      {state.sessions.map((session, index) => (
        <Text
          key={session.header.id}
          color={index === state.selectedIndex ? "cyan" : undefined}
        >
          {index === state.selectedIndex ? "▸ " : "  "}
          {session.title} · {session.header.id.slice(0, 8)} · {session.header.cwd}
        </Text>
      ))}
      <Text dimColor>
        ↑/↓ 或 k/j 选择 · Enter 恢复 · n 新 Session · Esc 退出
      </Text>
    </Box>
  );
}
