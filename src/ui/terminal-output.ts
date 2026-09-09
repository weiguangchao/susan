const INK_CURSOR_SUFFIX = /\u001B\[(\d+)A(\u001B\[\d+G\u001B\[\?25h)$/;

function correctFullscreenCursor(chunk: string): string {
  // Ink 7.1.1 omits the trailing newline for fullscreen frames, but its
  // useCursor suffix still moves up from a virtual row below the frame.
  return chunk.replace(INK_CURSOR_SUFFIX, (_, up: string, suffix: string) => {
    const distance = Number(up) - 1;
    return (distance > 0 ? `\u001B[${distance}A` : "") + suffix;
  });
}

type TuiOutput = NodeJS.WriteStream & {
  readonly terminalRows: number;
  setLiveFrameRows(rows: number | undefined): void;
};

// Near-full live frames report their height as the viewport so Ink skips its
// extra trailing newline and the status bar can sit on the last row. History
// preservation is handled by patches/ink@7.1.1.patch at the redraw boundary;
// ordinary redraws append only new Static output; resize rebuilds the terminal
// from Ink's complete Static cache after reflow invalidates live-row coordinates.
export function createTuiOutput(
  stdout: NodeJS.WriteStream,
): TuiOutput {
  let liveFrameRows: number | undefined;
  const write = ((chunk: string | Uint8Array, ...args: readonly unknown[]) => {
    const safeChunk =
      typeof chunk === "string"
        ? correctFullscreenCursor(chunk)
        : chunk;
    return Reflect.apply(stdout.write, stdout, [safeChunk, ...args]);
  }) as NodeJS.WriteStream["write"];

  return new Proxy(stdout, {
    get(target, property) {
      if (property === "write") {
        return write;
      }
      if (property === "rows") {
        return liveFrameRows ?? (target.rows > 0 ? target.rows : 24);
      }
      if (property === "terminalRows") {
        return target.rows > 0 ? target.rows : 24;
      }
      if (property === "setLiveFrameRows") {
        return (value: number | undefined) => {
          liveFrameRows = value;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value);
    },
  }) as TuiOutput;
}

export function pinLiveFrameRows(
  stdout: NodeJS.WriteStream,
  frameRows: number,
): void {
  const output = stdout as Partial<TuiOutput>;
  // Report the live frame height as the viewport so Ink treats it as
  // fullscreen and does not add a trailing newline under the status bar.
  output.setLiveFrameRows?.(frameRows);
}
