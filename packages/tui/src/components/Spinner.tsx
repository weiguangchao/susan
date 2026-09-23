import { useEffect, useState } from "react";
import { Text } from "ink";
import { spinnerFrames, theme } from "../theme.js";

export function Spinner({ color = theme.accent }: { color?: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % spinnerFrames.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return <Text color={color}>{spinnerFrames[frame]}</Text>;
}
