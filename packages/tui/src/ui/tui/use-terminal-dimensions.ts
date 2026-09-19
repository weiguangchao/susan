import { useEffect, useState } from "react";

type TerminalDimensions = {
  readonly rows: number;
  readonly columns: number;
};

function readTerminalDimensions(stdout: NodeJS.WriteStream): TerminalDimensions {
  const output = stdout as NodeJS.WriteStream & { readonly terminalRows?: number };
  const rows =
    output.terminalRows ?? (stdout.rows > 0 ? stdout.rows : 24);
  return {
    rows: rows > 0 ? rows : 24,
    columns: stdout.columns > 0 ? stdout.columns : 80,
  };
}

export function useTerminalDimensions(
  stdout: NodeJS.WriteStream,
): TerminalDimensions {
  const [dimensions, setDimensions] = useState(() =>
    readTerminalDimensions(stdout),
  );

  useEffect(() => {
    const updateDimensions = () => {
      const next = readTerminalDimensions(stdout);
      setDimensions((current) =>
        current.rows === next.rows && current.columns === next.columns
          ? current
          : next,
      );
    };

    updateDimensions();
    stdout.on("resize", updateDimensions);
    return () => {
      stdout.off("resize", updateDimensions);
    };
  }, [stdout]);

  return dimensions;
}
