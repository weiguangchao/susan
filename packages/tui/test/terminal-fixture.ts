import { PassThrough } from "node:stream";

export function terminalInput(): NodeJS.ReadStream & { fd: 0 } {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    ref(): void;
    setRawMode(mode: boolean): void;
    unref(): void;
  };
  input.isTTY = true;
  input.ref = () => {};
  input.setRawMode = () => {};
  input.unref = () => {};
  return input as unknown as NodeJS.ReadStream & { fd: 0 };
}

export function terminalOutput(
  onWrite: (chunk: string) => void,
): NodeJS.WriteStream & { fd: 1 } {
  const output = new PassThrough() as PassThrough & {
    columns: number;
    isTTY: boolean;
    rows: number;
  };
  output.columns = 80;
  output.isTTY = true;
  output.rows = 24;
  output.on("data", (chunk: Buffer) => onWrite(chunk.toString("utf8")));
  return output as unknown as NodeJS.WriteStream & { fd: 1 };
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function latestVisibleFrame(frames: readonly string[]): string {
  return frames.findLast((frame) => frame.trim() !== "") ?? "";
}

export async function flushEffects(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
