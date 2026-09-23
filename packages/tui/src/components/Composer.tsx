import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { glyphs, theme } from "../theme.js";

export interface ComposerProps {
  isActive: boolean;
  placeholder: string;
  onSubmit(value: string): void;
}

/**
 * A single-line editor with predictable key handling for input and history.
 */
export function Composer({ isActive, placeholder, onSubmit }: ComposerProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  useInput(
    (input, key) => {
      if (key.return) {
        const trimmed = value.trim();
        if (!trimmed) return;
        setHistory((prev) => [trimmed, ...prev].slice(0, 100));
        setHistoryIndex(null);
        setValue("");
        setCursor(0);
        onSubmit(trimmed);
        return;
      }

      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }

      if (key.upArrow) {
        if (history.length === 0) return;
        const next = historyIndex === null ? 0 : Math.min(historyIndex + 1, history.length - 1);
        const entry = history[next] ?? "";
        setHistoryIndex(next);
        setValue(entry);
        setCursor(entry.length);
        return;
      }
      if (key.downArrow) {
        if (historyIndex === null) return;
        const next = historyIndex - 1;
        if (next < 0) {
          setHistoryIndex(null);
          setValue("");
          setCursor(0);
          return;
        }
        const entry = history[next] ?? "";
        setHistoryIndex(next);
        setValue(entry);
        setCursor(entry.length);
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
        setCursor((c) => c - 1);
        return;
      }

      if (key.ctrl) {
        if (input === "a") setCursor(0);
        else if (input === "e") setCursor(value.length);
        else if (input === "u") {
          setValue((v) => v.slice(cursor));
          setCursor(0);
        } else if (input === "k") {
          setValue((v) => v.slice(0, cursor));
        }
        return;
      }

      if (key.meta || key.tab || key.escape) return;
      if (!input) return;

      // A paste arrives as one chunk, so an embedded newline never reaches the
      // key.return branch above. Fold those into spaces and let the user press
      // enter themselves rather than firing a half-read request.
      const text = /[\r\n]/.test(input)
        ? input.replace(/\r\n|[\r\n]/g, " ").replace(/\s+$/, "")
        : input;
      if (!text) return;

      setValue((v) => v.slice(0, cursor) + text + v.slice(cursor));
      setCursor((c) => c + text.length);
    },
    { isActive },
  );

  const before = value.slice(0, cursor);
  const at = value.slice(cursor, cursor + 1) || " ";
  const after = value.slice(cursor + 1);
  const empty = value.length === 0;

  return (
    <Box
      borderStyle="round"
      borderColor={isActive ? theme.accent : theme.border}
      paddingX={1}
    >
      <Text color={isActive ? theme.accent : theme.border}>
        {glyphs.prompt}{" "}
      </Text>
      {empty && !isActive ? (
        <Text color={theme.muted}>{placeholder}</Text>
      ) : empty ? (
        <>
          <Text inverse> </Text>
          <Text color={theme.muted}>{placeholder}</Text>
        </>
      ) : (
        <Text>
          {before}
          <Text inverse>{at}</Text>
          {after}
        </Text>
      )}
    </Box>
  );
}
