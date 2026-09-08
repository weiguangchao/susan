const INK_FULL_CLEAR = "\u001B[2J\u001B[3J\u001B[H";
const HOME_AND_ERASE_DOWN = "\u001B[1;1H\u001B[J";
const INK_CURSOR_SUFFIX = /\u001B\[(\d+)A(\u001B\[\d+G\u001B\[\?25h)$/;

function correctFullscreenCursor(chunk: string): string {
  // Ink 7.1.1 omits the trailing newline for fullscreen frames, but its
  // useCursor suffix still moves up from a virtual row below the frame.
  // Return-to-bottom/erase already use the real last row. Correct only the
  // final cursor suffix so both directions agree; history text is untouched.
  return chunk.replace(INK_CURSOR_SUFFIX, (_, up: string, suffix: string) => {
    const distance = Number(up) - 1;
    return (distance > 0 ? `\u001B[${distance}A` : "") + suffix;
  });
}

// For TuiApp's full-height frames only; other Ink screens may end in a newline.
export function createFullscreenTuiOutput(
  stdout: NodeJS.WriteStream,
): NodeJS.WriteStream {
  const write = ((chunk: string | Uint8Array, ...args: readonly unknown[]) => {
    const safeChunk =
      typeof chunk === "string"
        ? correctFullscreenCursor(
            chunk.replaceAll(INK_FULL_CLEAR, HOME_AND_ERASE_DOWN),
          )
        : chunk;
    return Reflect.apply(stdout.write, stdout, [safeChunk, ...args]);
  }) as NodeJS.WriteStream["write"];

  return new Proxy(stdout, {
    get(target, property) {
      if (property === "write") {
        return write;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
}
