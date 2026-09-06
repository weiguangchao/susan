import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, lstat, stat, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { env as processEnv, platform as processPlatform } from "node:process";
import { finished } from "node:stream/promises";
import { isRecord, type JsonObject } from "./json.js";
import {
  createSessionPathResolver,
  type CwdRelation,
  type PathResolution,
  type PathResolutionError,
  type SessionPathResolver,
} from "./path-resolver.js";
import {
  TOOL_RESULT_OUTPUT_BUDGET_BYTES,
  boundToolFailure,
  boundToolResult,
  normalizeToolResult,
  type ToolResult,
} from "./tool-result.js";

export const BASH_COMMAND_MAX_BYTES = 256 * 1024;
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MIN_TIMEOUT_MS = 1;
export const BASH_MAX_TIMEOUT_MS = 3_600_000;
export const BASH_KILL_GRACE_MS = 2_000;

const BASH_PROBE_TIMEOUT_MS = 3_000;
const BASH_DESCRIPTION =
  "Run one non-interactive, non-login Bash command as a one-shot process. Use bash for program execution, builds, tests, real Bash semantics, or work the dedicated Tools cannot express; do not use it as a substitute for read, write, edit, grep, find, or ls merely because a shell command is familiar. It supports an execution cwd, timeout, and environment overlay, but no PTY, persistent session, background-process contract, or later stdin. The command runs with Susan's process permissions, and bash.cwd does not restrict paths accessed by the command.";

export type BashErrorCode =
  | "EINVAL"
  | "EINVAL_PATH"
  | "ENOENT"
  | "ENOTDIR"
  | "ELOOP"
  | "EACCES"
  | "EUNSUPPORTED"
  | "ESPAWN"
  | "EEXIT"
  | "ESIGNAL"
  | "ETIMEDOUT"
  | "EIO"
  | "ETOOL";

export type BashTerminationScope =
  | "process-group"
  | "process-tree-best-effort"
  | "direct-process";

export type BashTermination = {
  readonly scope: BashTerminationScope;
  readonly forced: boolean;
  readonly cleanupConfirmed: boolean;
};

export type BashToolOptions = {
  readonly sessionCwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
};

export type BashTool = {
  readonly name: "bash";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult>;
};

type ValidatedArguments = {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly env?: Record<string, string | null>;
};

type ArgumentValidationResult =
  | { readonly ok: true; readonly value: ValidatedArguments }
  | { readonly ok: false; readonly result: ToolResult };

type OutputChunk = {
  field: "stdout" | "stderr";
  text: string;
};

type PathFacts = {
  readonly resolvedPath: string;
  readonly realTargetPath?: string;
  readonly cwdRelation: CwdRelation;
};

type ExecutionCwd = PathFacts & { readonly spawnCwd: string };

type ExecutionCwdResult =
  | { readonly ok: true; readonly value: ExecutionCwd }
  | { readonly ok: false; readonly result: ToolResult };

type ExecutionLock = "timeout" | "cancel" | "exit";

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function fail(
  code: BashErrorCode,
  message: string,
  details?: JsonObject,
): ToolResult {
  return {
    ok: false,
    error:
      details === undefined ? { code, message } : { code, message, details },
  };
}

function invalid(field: string, message = "Invalid bash arguments."): ToolResult {
  return fail("EINVAL", message, { field });
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) {
    return right;
  }
  if (right.length === 0) {
    return left;
  }
  const bytes = new Uint8Array(left.length + right.length);
  bytes.set(left, 0);
  bytes.set(right, left.length);
  return bytes;
}

function incompleteUtf8SuffixLength(data: Uint8Array): number {
  if (data.length === 0) {
    return 0;
  }
  let index = data.length - 1;
  let continuations = 0;
  while (index >= 0 && (data[index]! & 0xc0) === 0x80) {
    continuations += 1;
    index -= 1;
  }
  if (index < 0) {
    return 0;
  }
  const lead = data[index]!;
  const expected =
    lead < 0x80
      ? 1
      : (lead & 0xe0) === 0xc0
        ? 2
        : (lead & 0xf0) === 0xe0
          ? 3
          : (lead & 0xf8) === 0xf0
            ? 4
            : 0;
  if (expected === 0) {
    return 0;
  }
  const have = continuations + 1;
  return have < expected ? have : 0;
}

class Utf8StreamDecoder {
  lost = false;
  private pending: Uint8Array = new Uint8Array();

  decode(chunk: Uint8Array, finalize = false): string {
    const data = concatBytes(this.pending, chunk);
    if (!finalize) {
      const keep = incompleteUtf8SuffixLength(data);
      this.pending =
        keep === 0 ? new Uint8Array() : new Uint8Array(data.subarray(data.length - keep));
      return this.decodeComplete(data.subarray(0, data.length - keep));
    }
    this.pending = new Uint8Array();
    if (data.length === 0) {
      return "";
    }
    const keep = incompleteUtf8SuffixLength(data);
    const complete = this.decodeComplete(data.subarray(0, data.length - keep));
    if (keep === 0) {
      return complete;
    }
    this.lost = true;
    return complete + new TextDecoder("utf-8").decode(data.subarray(data.length - keep));
  }

  private decodeComplete(bytes: Uint8Array): string {
    if (bytes.length === 0) {
      return "";
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      this.lost = true;
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

function projectChunks(chunks: readonly OutputChunk[]): {
  readonly stdout: string;
  readonly stderr: string;
} {
  let stdout = "";
  let stderr = "";
  for (const chunk of chunks) {
    if (chunk.field === "stdout") {
      stdout += chunk.text;
    } else {
      stderr += chunk.text;
    }
  }
  return { stdout, stderr };
}

function projectedOutputBytes(chunks: readonly OutputChunk[]): number {
  const { stdout, stderr } = projectChunks(chunks);
  return (
    Buffer.byteLength(JSON.stringify(stdout), "utf8") +
    Buffer.byteLength(JSON.stringify(stderr), "utf8")
  );
}

function trimJointTail(chunks: OutputChunk[]): Array<"stdout" | "stderr"> {
  const truncated: Array<"stdout" | "stderr"> = [];
  while (
    chunks.length > 0 &&
    projectedOutputBytes(chunks) > TOOL_RESULT_OUTPUT_BUDGET_BYTES
  ) {
    const first = chunks[0]!;
    const rest = chunks.slice(1);
    if (projectedOutputBytes(rest) >= TOOL_RESULT_OUTPUT_BUDGET_BYTES) {
      truncated.push(first.field);
      chunks.shift();
      continue;
    }
    const codePoints = Array.from(first.text);
    let low = 0;
    let high = codePoints.length;
    let kept = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = codePoints.slice(codePoints.length - middle).join("");
      const bytes = projectedOutputBytes([
        { field: first.field, text: candidate },
        ...rest,
      ]);
      if (bytes <= TOOL_RESULT_OUTPUT_BUDGET_BYTES) {
        kept = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (kept.length === 0) {
      chunks.shift();
    } else {
      first.text = kept;
    }
    truncated.push(first.field);
    break;
  }
  return truncated;
}

function pushChunk(
  chunks: OutputChunk[],
  field: "stdout" | "stderr",
  text: string,
  truncatedFields: Set<"stdout" | "stderr">,
): void {
  if (text.length === 0) {
    return;
  }
  chunks.push({ field, text });
  for (const truncated of trimJointTail(chunks)) {
    truncatedFields.add(truncated);
  }
}

function collectStream(
  stream: NodeJS.ReadableStream | null | undefined,
  decoder: Utf8StreamDecoder,
  field: "stdout" | "stderr",
  chunks: OutputChunk[],
  truncatedFields: Set<"stdout" | "stderr">,
): Promise<void> {
  if (stream === undefined || stream === null) {
    return Promise.resolve();
  }
  stream.on("data", (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    pushChunk(chunks, field, decoder.decode(bytes), truncatedFields);
  });
  return finished(stream, { cleanup: true })
    .catch(() => undefined)
    .then(() => {
      pushChunk(chunks, field, decoder.decode(new Uint8Array(), true), truncatedFields);
    });
}

function copyEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function findEnvKey(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") {
    return Object.hasOwn(env, key) ? key : undefined;
  }
  const lower = key.toLowerCase();
  return Object.keys(env).find((candidate) => candidate.toLowerCase() === lower);
}

function applyEnvOverlay(
  base: NodeJS.ProcessEnv,
  overlay: Record<string, string | null>,
  platform: NodeJS.Platform,
):
  | { readonly ok: true; readonly env: NodeJS.ProcessEnv }
  | { readonly ok: false; readonly result: ToolResult } {
  const seen = new Map<string, string>();
  for (const key of Object.keys(overlay)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0")) {
      return { ok: false, result: invalid("env") };
    }
    const value = overlay[key];
    if (value !== null && (typeof value !== "string" || value.includes("\0"))) {
      return { ok: false, result: invalid("env") };
    }
    if (platform === "win32") {
      const lower = key.toLowerCase();
      const previous = seen.get(lower);
      if (previous !== undefined && previous !== key) {
        return { ok: false, result: invalid("env") };
      }
      seen.set(lower, key);
    }
  }
  const env = copyEnv(base);
  for (const [key, value] of Object.entries(overlay)) {
    const existing = findEnvKey(env, key, platform);
    if (existing !== undefined) {
      delete env[existing];
    }
    if (value !== null) {
      env[key] = value;
    }
  }
  return { ok: true, env };
}

function validateArguments(input: unknown): ArgumentValidationResult {
  if (!isRecord(input)) {
    return { ok: false, result: invalid("command") };
  }
  const allowed = new Set(["command", "cwd", "timeoutMs", "env"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return { ok: false, result: invalid("command") };
  }
  const command = input.command;
  if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
    return { ok: false, result: invalid("command") };
  }
  if (Buffer.byteLength(command, "utf8") > BASH_COMMAND_MAX_BYTES) {
    return { ok: false, result: invalid("command") };
  }
  const cwd = input.cwd;
  if (cwd !== undefined && typeof cwd !== "string") {
    return { ok: false, result: invalid("cwd") };
  }
  const timeoutMs = input.timeoutMs === undefined
    ? BASH_DEFAULT_TIMEOUT_MS
    : input.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < BASH_MIN_TIMEOUT_MS ||
    timeoutMs > BASH_MAX_TIMEOUT_MS
  ) {
    return { ok: false, result: invalid("timeoutMs") };
  }
  const env = input.env;
  if (env !== undefined) {
    if (!isRecord(env)) {
      return { ok: false, result: invalid("env") };
    }
    for (const value of Object.values(env)) {
      if (value !== null && typeof value !== "string") {
        return { ok: false, result: invalid("env") };
      }
    }
  }
  return {
    ok: true,
    value: {
      command,
      timeoutMs,
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env: env as Record<string, string | null> }),
    },
  };
}

function isWslGateway(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.endsWith("/system32/bash.exe") ||
    normalized.endsWith("/sysnative/bash.exe") ||
    normalized.endsWith("/syswow64/bash.exe")
  );
}

function bashCandidatePaths(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    if (candidate.length === 0 || isWslGateway(candidate)) {
      return;
    }
    const key = platform === "win32" ? candidate.replaceAll("/", "\\").toLowerCase() : candidate;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };
  const pathValue = platform === "win32"
    ? (env.PATH ?? env.Path ?? "")
    : (env.PATH ?? "");
  const executable = platform === "win32" ? "bash.exe" : "bash";
  if (platform !== "win32") {
    add("/bin/bash");
  }
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length > 0) {
      add(join(directory, executable));
    }
  }
  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    add(join(programFiles, "Git", "bin", "bash.exe"));
    add(join(programFilesX86, "Git", "bin", "bash.exe"));
    if (env.LOCALAPPDATA !== undefined && env.LOCALAPPDATA.length > 0) {
      add(join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
    }
  }
  return candidates;
}

async function probeBash(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const child = spawn(executable, ["--version"], {
    env,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, BASH_PROBE_TIMEOUT_MS);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

async function resolveBashExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<{ ok: true; path: string } | { ok: false; code: "EUNSUPPORTED" | "EACCES" }> {
  let permissionDenied = false;
  for (const candidate of bashCandidatePaths(env, platform)) {
    try {
      const stats = await stat(candidate);
      if (!stats.isFile()) {
        continue;
      }
      await access(candidate, constants.X_OK);
    } catch (error) {
      const code = nodeErrorCode(error);
      if (code === "EACCES" || code === "EPERM") {
        permissionDenied = true;
      }
      continue;
    }
    if (await probeBash(candidate, env)) {
      return { ok: true, path: candidate };
    }
  }
  return { ok: false, code: permissionDenied ? "EACCES" : "EUNSUPPORTED" };
}

function pathFacts(resolution: PathResolution): PathFacts {
  return {
    resolvedPath: resolution.resolvedPath,
    cwdRelation: resolution.cwdRelation,
    ...(resolution.resolvedPath === resolution.realTargetPath
      ? {}
      : { realTargetPath: resolution.realTargetPath }),
  };
}

function mapPathError(error: PathResolutionError, enotdir: boolean): ToolResult {
  const details = error.details === undefined ? undefined : { ...error.details };
  if (enotdir) {
    return fail("ENOTDIR", "Working directory is not a directory.", details);
  }
  if (error.code === "ENOENT") {
    return fail("ENOENT", "Working directory does not exist.", details);
  }
  if (error.code === "ELOOP") {
    return fail("ELOOP", "Working directory contains a symlink loop.", details);
  }
  if (error.code === "EACCES") {
    return fail("EACCES", "Working directory cannot be accessed.", details);
  }
  if (error.code === "EINVAL_PATH") {
    return fail("EINVAL_PATH", "Working directory path is invalid.", details);
  }
  return fail("EIO", "Working directory cannot be resolved.", details);
}

async function wasEnotdir(error: PathResolutionError): Promise<boolean> {
  const resolvedPath = error.details?.resolvedPath;
  if (resolvedPath === undefined) {
    return false;
  }
  try {
    await lstat(resolvedPath);
    return false;
  } catch (cause) {
    return nodeErrorCode(cause) === "ENOTDIR";
  }
}

async function resolveExecutionCwd(
  resolver: SessionPathResolver,
  cwd: string | undefined,
): Promise<ExecutionCwdResult> {
  if (cwd === undefined) {
    const resolution = {
      resolvedPath: resolver.sessionCwd,
      realTargetPath: resolver.canonicalSessionCwd,
      cwdRelation: "inside" as const,
    };
    return {
      ok: true,
      value: { ...pathFacts(resolution), spawnCwd: resolution.realTargetPath },
    };
  }
  const resolved = await resolver.resolve(cwd, {
    existence: "required",
    symlinks: "follow",
  });
  if (!resolved.ok) {
    return {
      ok: false,
      result: mapPathError(resolved.error, await wasEnotdir(resolved.error)),
    };
  }
  try {
    if (!(await stat(resolved.value.realTargetPath)).isDirectory()) {
      return {
        ok: false,
        result: fail("ENOTDIR", "Working directory is not a directory.", {
          ...resolved.value,
        }),
      };
    }
    await access(resolved.value.realTargetPath, constants.X_OK);
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ENOTDIR") {
      return {
        ok: false,
        result: fail("ENOTDIR", "Working directory is not a directory.", {
          ...resolved.value,
        }),
      };
    }
    if (code === "ENOENT") {
      return {
        ok: false,
        result: fail("ENOENT", "Working directory does not exist.", {
          ...resolved.value,
        }),
      };
    }
    if (code === "EACCES" || code === "EPERM") {
      return {
        ok: false,
        result: fail("EACCES", "Working directory cannot be accessed.", {
          ...resolved.value,
        }),
      };
    }
    return {
      ok: false,
      result: fail("EIO", "Working directory cannot be resolved.", {
        resolvedPath: resolved.value.resolvedPath,
      }),
    };
  }
  return {
    ok: true,
    value: { ...pathFacts(resolved.value), spawnCwd: resolved.value.realTargetPath },
  };
}

function outputFields() {
  return [
    { name: "stdout", kind: "text" as const, truncateOversizedRecords: true },
    { name: "stderr", kind: "text" as const, truncateOversizedRecords: true },
  ];
}

function outputRecords(chunks: readonly OutputChunk[]) {
  return chunks.map((chunk) => ({ field: chunk.field, value: chunk.text }));
}

function projectedRecords(chunks: readonly OutputChunk[]) {
  const { stdout, stderr } = projectChunks(chunks);
  return outputRecords([
    { field: "stdout", text: stdout },
    { field: "stderr", text: stderr },
  ]);
}

function withObservedTailTruncation(
  result: ToolResult,
  truncatedFields: ReadonlySet<"stdout" | "stderr">,
): ToolResult {
  if (truncatedFields.size === 0 || result.meta?.truncation !== undefined) {
    return result;
  }
  const payload = result.ok ? result.result : result.error.details;
  const stdout = typeof payload?.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload?.stderr === "string" ? payload.stderr : "";
  return normalizeToolResult({
    ...result,
    meta: {
      truncation: {
        reasons: ["bytes"],
        strategy: "tail",
        fields: (["stdout", "stderr"] as const).filter((field) =>
          truncatedFields.has(field),
        ),
        retained: {
          bytes:
            Buffer.byteLength(JSON.stringify(stdout), "utf8") +
            Buffer.byteLength(JSON.stringify(stderr), "utf8"),
        },
      },
    },
  });
}

function decodeLossDetails(
  stdout: Utf8StreamDecoder,
  stderr: Utf8StreamDecoder,
): { readonly decodeLoss?: readonly ("stdout" | "stderr")[] } {
  const fields: Array<"stdout" | "stderr"> = [];
  if (stdout.lost) {
    fields.push("stdout");
  }
  if (stderr.lost) {
    fields.push("stderr");
  }
  return fields.length === 0 ? {} : { decodeLoss: fields };
}

function posixGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPosixGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (nodeErrorCode(error) === "ESRCH") {
      return;
    }
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function killWindowsProcessTree(
  pid: number,
  child: ChildProcess,
): Promise<BashTerminationScope> {
  try {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    const [code] = (await once(killer, "exit")) as [number | null];
    if (code === 0) {
      return "process-tree-best-effort";
    }
  } catch {}
  try {
    child.kill();
  } catch {}
  return "direct-process";
}

function spawnFailure(error: unknown): ToolResult {
  const platformCode = nodeErrorCode(error);
  return fail(
    "ESPAWN",
    "Failed to start Bash.",
    platformCode === undefined ? undefined : { platformCode },
  );
}

export async function executeBash(
  input: unknown,
  options: BashToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult> {
  const validated = validateArguments(input);
  if (!validated.ok) {
    return validated.result;
  }
  const platform = options.platform ?? processPlatform;
  const parentEnv = options.env ?? processEnv;
  const posix = platform !== "win32";
  const childEnv = validated.value.env === undefined
    ? { ok: true as const, env: copyEnv(parentEnv) }
    : applyEnvOverlay(parentEnv, validated.value.env, platform);
  if (!childEnv.ok) {
    return childEnv.result;
  }
  const resolverResult = await createSessionPathResolver(options.sessionCwd);
  if (!resolverResult.ok) {
    return mapPathError(resolverResult.error, false);
  }
  const cwd = await resolveExecutionCwd(resolverResult.value, validated.value.cwd);
  if (!cwd.ok) {
    return cwd.result;
  }
  const bash = await resolveBashExecutable(parentEnv, platform);
  if (!bash.ok) {
    return fail(
      bash.code,
      bash.code === "EACCES" ? "Bash is not executable." : "Bash is not available.",
    );
  }

  const chunks: OutputChunk[] = [];
  const truncatedFields = new Set<"stdout" | "stderr">();
  const stdoutDecoder = new Utf8StreamDecoder();
  const stderrDecoder = new Utf8StreamDecoder();
  const child = spawn(
    bash.path,
    ["--noprofile", "--norc", "-c", validated.value.command],
    {
      cwd: cwd.value.spawnCwd,
      env: childEnv.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: posix,
      windowsHide: true,
      shell: false,
    },
  );
  const stdoutDone = collectStream(
    child.stdout,
    stdoutDecoder,
    "stdout",
    chunks,
    truncatedFields,
  );
  const stderrDone = collectStream(
    child.stderr,
    stderrDecoder,
    "stderr",
    chunks,
    truncatedFields,
  );

  try {
    await once(child, "spawn");
  } catch (error) {
    await Promise.all([stdoutDone, stderrDone]);
    return spawnFailure(error);
  }

  const pid = child.pid;
  if (pid === undefined) {
    await Promise.all([stdoutDone, stderrDone]);
    return fail("ESPAWN", "Failed to start Bash.");
  }

  let lock: ExecutionLock | undefined;
  let usedForce = false;
  let terminationScope: BashTerminationScope = posix
    ? "process-group"
    : "process-tree-best-effort";
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let windowsKill = Promise.resolve();

  const tryLock = (reason: ExecutionLock): boolean => {
    if (lock !== undefined) {
      return false;
    }
    lock = reason;
    return true;
  };

  const terminate = (force: boolean): void => {
    if (posix) {
      if (force) {
        usedForce = true;
      }
      killPosixGroup(pid, force ? "SIGKILL" : "SIGTERM");
      return;
    }
    usedForce = true;
    windowsKill = killWindowsProcessTree(pid, child).then((scope) => {
      terminationScope = scope;
    });
  };

  const beginTermination = (reason: ExecutionLock): void => {
    if (!tryLock(reason)) {
      return;
    }
    if (posix) {
      terminate(false);
      forceTimer = setTimeout(() => terminate(true), BASH_KILL_GRACE_MS);
      return;
    }
    terminate(true);
  };

  timeoutTimer = setTimeout(() => {
    beginTermination("timeout");
  }, validated.value.timeoutMs);

  const onAbort = () => beginTermination("cancel");
  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
  }

  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  try {
    const [exit] = await Promise.all([
      once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>,
      stdoutDone,
      stderrDone,
    ]);
    exitCode = exit[0];
    exitSignal = exit[1];
    tryLock("exit");
    await windowsKill;
  } finally {
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
    }
    if (forceTimer !== undefined) {
      clearTimeout(forceTimer);
    }
    options.signal?.removeEventListener("abort", onAbort);
  }

  const decodeLoss = decodeLossDetails(stdoutDecoder, stderrDecoder);
  const facts = {
    bashPath: bash.path,
    resolvedPath: cwd.value.resolvedPath,
    cwdRelation: cwd.value.cwdRelation,
    ...(cwd.value.realTargetPath === undefined
      ? {}
      : { realTargetPath: cwd.value.realTargetPath }),
    ...decodeLoss,
  };
  const records = projectedRecords(chunks);
  const cleanupConfirmed = posix ? !posixGroupAlive(pid) : false;
  const termination: BashTermination = {
    scope: terminationScope,
    forced: usedForce,
    cleanupConfirmed,
  };

  if (lock === "cancel") {
    return fail("ETOOL", "Tool execution failed.");
  }

  if (lock === "timeout") {
    return withObservedTailTruncation(
      boundToolFailure({
        error: {
          code: "ETIMEDOUT",
          message: "Command timed out.",
          details: {
            ...facts,
            exitCode,
            signal: exitSignal,
            timeoutMs: validated.value.timeoutMs,
            termination,
          },
        },
        fields: outputFields(),
        records,
        strategy: "tail",
      }),
      truncatedFields,
    );
  }

  if (exitSignal !== null) {
    return withObservedTailTruncation(
      boundToolFailure({
        error: {
          code: "ESIGNAL",
          message: "Command terminated by a signal.",
          details: {
            ...facts,
            exitCode,
            signal: exitSignal,
            termination,
          },
        },
        fields: outputFields(),
        records,
        strategy: "tail",
      }),
      truncatedFields,
    );
  }

  if (exitCode !== 0) {
    return withObservedTailTruncation(
      boundToolFailure({
        error: {
          code: "EEXIT",
          message: "Command exited with a non-zero status.",
          details: {
            ...facts,
            exitCode,
            signal: null,
            termination,
          },
        },
        fields: outputFields(),
        records,
        strategy: "tail",
      }),
      truncatedFields,
    );
  }

  return withObservedTailTruncation(
    boundToolResult({
      result: {
        exitCode: 0,
        ...facts,
      },
      fields: outputFields(),
      records,
      strategy: "tail",
    }),
    truncatedFields,
  );
}

export function createBashTool(options: BashToolOptions): BashTool {
  return {
    name: "bash",
    description: BASH_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "Bash command passed as a single argv value to bash -c",
        },
        cwd: {
          type: "string",
          description: "Optional execution directory relative to the Session cwd",
        },
        timeoutMs: {
          type: "integer",
          minimum: BASH_MIN_TIMEOUT_MS,
          maximum: BASH_MAX_TIMEOUT_MS,
          description: "Timeout in milliseconds; defaults to 120000",
        },
        env: {
          type: "object",
          additionalProperties: {
            anyOf: [{ type: "string" }, { type: "null" }],
          },
          description: "Environment overlay; string sets a value and null deletes a key",
        },
      },
      required: ["command"],
    },
    execute(input, signal) {
      return executeBash(input, { ...options, ...(signal === undefined ? {} : { signal }) });
    },
  };
}
