import { useEffect, useState } from "react";
import { useInput, useStdout } from "ink";

const FOCUS_IN = "[I";
const FOCUS_OUT = "[O";

/** Track terminal-window focus when the terminal supports focus reporting. */
export function useTerminalFocus(): boolean {
  const [focused, setFocused] = useState(true);
  const { stdout } = useStdout();

  useEffect(() => {
    if (!stdout.isTTY) return;
    stdout.write("\x1b[?1004h");
    return () => { stdout.write("\x1b[?1004l"); };
  }, [stdout]);

  useEffect(() => {
    if (!stdout.isTTY || focused) return;
    stdout.write("\x1b]12;#ffffff\x07");
    return () => { stdout.write("\x1b]112\x07"); };
  }, [focused, stdout]);

  useInput((input) => {
    if (input === FOCUS_IN) setFocused(true);
    else if (input === FOCUS_OUT) setFocused(false);
  });

  return focused;
}
