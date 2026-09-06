import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const TRAVERSAL_ENTRY_BUDGET = 100_000;
export const TRAVERSAL_DEFAULT_TIMEOUT_MS = 10_000;
export const TRAVERSAL_MAX_DIAGNOSTICS = 100;
export const TRAVERSAL_MAX_DEPTH = 1_000;

export type TraversalEntryType = "file" | "directory" | "symlink";

export type TraversalEntry = {
  readonly path: string;
  readonly type: TraversalEntryType;
};

export type TraversalDiagnosticOperation =
  | "read-directory"
  | "read-file"
  | "read-metadata";

export type TraversalDiagnostic = {
  readonly path: string;
  readonly operation: TraversalDiagnosticOperation;
  readonly code: string;
};

export type TraversalErrorCode =
  | "EINVAL_GLOB"
  | "EINVAL_DEPTH"
  | "ENOENT"
  | "ENOTDIR"
  | "EACCES"
  | "ELOOP"
  | "EIO"
  | "EQUERY_TOO_LARGE"
  | "ETIMEDOUT";

export type TraversalError = {
  readonly code: TraversalErrorCode;
  readonly message: string;
  readonly details?: {
    readonly visitedEntries?: number;
    readonly matchedItems?: number;
    readonly field?: string;
  };
};

export type TraversalSuccess = {
  readonly entries: readonly TraversalEntry[];
  readonly diagnostics: readonly TraversalDiagnostic[];
};

export type TraversalResult<T = TraversalSuccess> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TraversalError };

export type GlobMatcher = {
  test(relativePath: string): boolean;
};

export type TraverseOptions = {
  readonly searchRoot: string;
  readonly glob?: string;
  readonly maxDepth?: number;
  readonly includeIgnored?: boolean;
  readonly timeoutMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
};

type GlobClass = {
  readonly kind: "class";
  readonly negated: boolean;
  readonly chars: ReadonlySet<string>;
};

type GlobPart =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "star" }
  | { readonly kind: "question" }
  | GlobClass;

type GlobSegment =
  | { readonly kind: "double-star" }
  | { readonly kind: "parts"; readonly parts: readonly GlobPart[] };

type CompiledGlob = {
  readonly hasSlash: boolean;
  readonly segments: readonly GlobSegment[];
};

function fail(
  code: TraversalErrorCode,
  message: string,
  details?: TraversalError["details"],
): TraversalResult<never> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

function matchParts(parts: readonly GlobPart[], text: string): boolean {
  const walk = (partIndex: number, textIndex: number): boolean => {
    if (partIndex === parts.length) {
      return textIndex === text.length;
    }
    const part = parts[partIndex]!;
    if (part.kind === "star") {
      for (let index = textIndex; index <= text.length; index += 1) {
        if (walk(partIndex + 1, index)) {
          return true;
        }
      }
      return false;
    }
    if (part.kind === "question") {
      return textIndex < text.length && walk(partIndex + 1, textIndex + 1);
    }
    if (part.kind === "class") {
      if (textIndex >= text.length) {
        return false;
      }
      const char = text[textIndex]!;
      const hit = part.chars.has(char);
      return (part.negated ? !hit : hit) && walk(partIndex + 1, textIndex + 1);
    }
    if (text.startsWith(part.value, textIndex)) {
      return walk(partIndex + 1, textIndex + part.value.length);
    }
    return false;
  };
  return walk(0, 0);
}

function matchSegments(
  segments: readonly GlobSegment[],
  pathSegments: readonly string[],
): boolean {
  const walk = (segmentIndex: number, pathIndex: number): boolean => {
    if (segmentIndex === segments.length) {
      return pathIndex === pathSegments.length;
    }
    const segment = segments[segmentIndex]!;
    if (segment.kind === "double-star") {
      const trailingAfterPrefix =
        segmentIndex > 0 && segmentIndex === segments.length - 1;
      if (trailingAfterPrefix) {
        return pathIndex < pathSegments.length &&
          (walk(segmentIndex + 1, pathIndex + 1) ||
            walk(segmentIndex, pathIndex + 1));
      }
      if (walk(segmentIndex + 1, pathIndex)) {
        return true;
      }
      return pathIndex < pathSegments.length && walk(segmentIndex, pathIndex + 1);
    }
    if (pathIndex >= pathSegments.length) {
      return false;
    }
    return matchParts(segment.parts, pathSegments[pathIndex]!) &&
      walk(segmentIndex + 1, pathIndex + 1);
  };
  return walk(0, 0);
}

function parseCharacterClass(
  pattern: string,
  start: number,
): TraversalResult<{ readonly chars: ReadonlySet<string>; readonly negated: boolean; readonly next: number }> {
  if (start >= pattern.length) {
    return fail("EINVAL_GLOB", "Glob pattern is invalid.");
  }
  let index = start;
  let negated = false;
  if (pattern[index] === "!") {
    negated = true;
    index += 1;
  }
  const chars = new Set<string>();
  let sawMember = false;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === "]" && sawMember) {
      return { ok: true, value: { chars, negated, next: index + 1 } };
    }
    if (
      index + 2 < pattern.length &&
      pattern[index + 1] === "-" &&
      pattern[index + 2] !== "]"
    ) {
      const from = char.charCodeAt(0);
      const to = pattern[index + 2]!.charCodeAt(0);
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      for (let code = lo; code <= hi; code += 1) {
        chars.add(String.fromCharCode(code));
      }
      index += 3;
      sawMember = true;
      continue;
    }
    chars.add(char);
    index += 1;
    sawMember = true;
  }
  return fail("EINVAL_GLOB", "Glob pattern is invalid.");
}

const EXT_GLOB_PREFIXES = new Set(["!", "*", "?", "+", "@"]);

function parseGlob(
  pattern: string,
  lenient = false,
): TraversalResult<CompiledGlob> {
  const segments: GlobSegment[] = [];
  let parts: GlobPart[] = [];
  let literal = "";
  let hasSlash = false;

  const flushLiteral = () => {
    if (literal.length > 0) {
      parts.push({ kind: "literal", value: literal });
      literal = "";
    }
  };

  const flushSegment = () => {
    flushLiteral();
    if (
      parts.length === 2 &&
      parts[0]?.kind === "star" &&
      parts[1]?.kind === "star"
    ) {
      segments.push({ kind: "double-star" });
    } else {
      segments.push({ kind: "parts", parts });
    }
    parts = [];
  };

  let source = pattern;
  if (source.startsWith("/")) {
    hasSlash = true;
    source = source.replace(/^\/+/, "");
    if (source.length === 0) {
      return fail("EINVAL_GLOB", "Glob pattern is invalid.");
    }
  }

  for (let index = 0; index < source.length; ) {
    const char = source[index]!;
    if (char === "/") {
      hasSlash = true;
      flushSegment();
      index += 1;
      continue;
    }
    if (!lenient && EXT_GLOB_PREFIXES.has(char) && source[index + 1] === "(") {
      return fail("EINVAL_GLOB", "Glob pattern is invalid.");
    }
    if (!lenient && (char === "{" || char === "}")) {
      return fail("EINVAL_GLOB", "Glob pattern is invalid.");
    }
    if (char === "*") {
      flushLiteral();
      parts.push({ kind: "star" });
      index += 1;
      continue;
    }
    if (char === "?") {
      flushLiteral();
      parts.push({ kind: "question" });
      index += 1;
      continue;
    }
    if (char === "[") {
      flushLiteral();
      const parsed = parseCharacterClass(source, index + 1);
      if (!parsed.ok) {
        return parsed;
      }
      parts.push({
        kind: "class",
        negated: parsed.value.negated,
        chars: parsed.value.chars,
      });
      index = parsed.value.next;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= source.length) {
        return fail("EINVAL_GLOB", "Glob pattern is invalid.");
      }
      literal += source[index + 1]!;
      index += 2;
      continue;
    }
    literal += char;
    index += 1;
  }
  flushSegment();
  if (segments.some((segment) => segment.kind === "parts" && segment.parts.length === 0)) {
    return fail("EINVAL_GLOB", "Glob pattern is invalid.");
  }

  return { ok: true, value: { hasSlash, segments } };
}

export function compileGlob(pattern: string): TraversalResult<GlobMatcher> {
  if (pattern.length === 0 || pattern.startsWith("!")) {
    return fail("EINVAL_GLOB", "Glob pattern is invalid.");
  }
  const parsed = parseGlob(pattern);
  if (!parsed.ok) {
    return parsed;
  }
  return {
    ok: true,
    value: matcherFromCompiled(parsed.value),
  };
}

function matcherFromCompiled(
  compiled: CompiledGlob,
  forcePath = false,
): GlobMatcher {
  const hasSlash = forcePath || compiled.hasSlash;
  const { segments } = compiled;
  return {
    test(relativePath) {
      const pathSegments = relativePath.split("/").filter((segment) => segment.length > 0);
      if (!hasSlash) {
        const basename = pathSegments[pathSegments.length - 1] ?? "";
        return matchSegments(segments, [basename]);
      }
      return matchSegments(segments, pathSegments);
    },
  };
}

type IgnoreRule = {
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly matcher: GlobMatcher;
};

function stripGitignoreLine(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    if (end >= 2 && line[end - 2] === "\\") {
      break;
    }
    end -= 1;
  }
  return line.slice(0, end);
}

function compileIgnoreMatcher(
  pattern: string,
  forcePath: boolean,
): GlobMatcher | undefined {
  const parsed = parseGlob(pattern, true);
  if (!parsed.ok) {
    return undefined;
  }
  return matcherFromCompiled(parsed.value, forcePath);
}

function parseGitignore(content: string): readonly IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = stripGitignoreLine(raw);
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    if (pattern.startsWith("\\!")) {
      pattern = pattern.slice(1);
    }
    if (pattern.length === 0) {
      continue;
    }
    let directoryOnly = false;
    if (pattern.endsWith("/") && !pattern.endsWith("\\/")) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }
    if (pattern.length === 0) {
      continue;
    }
    let forcePath = false;
    if (pattern.startsWith("/")) {
      forcePath = true;
      pattern = pattern.slice(1);
    } else if (pattern.includes("/")) {
      forcePath = true;
    }
    if (pattern.length === 0) {
      continue;
    }
    const matcher = compileIgnoreMatcher(pattern, forcePath);
    if (matcher === undefined) {
      continue;
    }
    rules.push({ negated, directoryOnly, matcher });
  }
  return rules;
}

function pathRelativeToIgnore(path: string, ignoreDir: string): string {
  if (ignoreDir.length === 0) {
    return path;
  }
  if (path === ignoreDir) {
    return "";
  }
  if (path.startsWith(`${ignoreDir}/`)) {
    return path.slice(ignoreDir.length + 1);
  }
  return path;
}

function isIgnored(
  relativePath: string,
  isDirectory: boolean,
  ignoreStack: readonly (readonly IgnoreRule[])[],
  ignoreDirs: readonly string[],
): boolean {
  let ignored = false;
  for (const [index, rules] of ignoreStack.entries()) {
    const relative = pathRelativeToIgnore(relativePath, ignoreDirs[index] ?? "");
    if (relative.length === 0) {
      continue;
    }
    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory) {
        continue;
      }
      if (rule.matcher.test(relative)) {
        ignored = !rule.negated;
      }
    }
  }
  return ignored;
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

type GitignoreLoad = {
  readonly rules: readonly IgnoreRule[];
  readonly diagnostic?: TraversalDiagnostic;
};

async function loadGitignore(
  directory: string,
  relativeDir: string,
): Promise<GitignoreLoad> {
  const relativePath = relativeDir.length === 0 ? ".gitignore" : `${relativeDir}/.gitignore`;
  try {
    const stats = await lstat(join(directory, ".gitignore"));
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return { rules: [] };
    }
    const text = decodeUtf8(await readFile(join(directory, ".gitignore")));
    if (text === undefined) {
      return {
        rules: [],
        diagnostic: { path: relativePath, operation: "read-file", code: "EBINARY" },
      };
    }
    return { rules: parseGitignore(text) };
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return { rules: [] };
    }
    return {
      rules: [],
      diagnostic: {
        path: relativePath,
        operation: "read-file",
        code: filesystemErrorCode(error),
      },
    };
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

const TRAVERSAL_ERROR_MESSAGES: Record<TraversalErrorCode, string> = {
  EINVAL_GLOB: "Glob pattern is invalid.",
  EINVAL_DEPTH: "maxDepth is invalid.",
  ENOENT: "Path does not exist",
  ENOTDIR: "Path is not a directory",
  EACCES: "Path cannot be resolved",
  ELOOP: "Path contains a symlink loop",
  EIO: "Traversal failed",
  EQUERY_TOO_LARGE: "Query exceeded the entry budget.",
  ETIMEDOUT: "Query timed out.",
};

export function filesystemErrorCode(error: unknown): TraversalErrorCode {
  const platformCode = nodeErrorCode(error);
  return platformCode === "ENOENT"
    ? "ENOENT"
    : platformCode === "ENOTDIR"
      ? "ENOTDIR"
      : platformCode === "ELOOP"
        ? "ELOOP"
        : platformCode === "EACCES" || platformCode === "EPERM"
          ? "EACCES"
          : "EIO";
}

function filesystemRootFailure(error: unknown): TraversalResult<never> {
  const code = filesystemErrorCode(error);
  return fail(code, TRAVERSAL_ERROR_MESSAGES[code]);
}

type WalkState = {
  entries: TraversalEntry[];
  diagnostics: TraversalDiagnostic[];
  visitedEntries: number;
};

async function walk(
  directory: string,
  relativeDir: string,
  state: WalkState,
  includeIgnored: boolean,
  ignoreStack: readonly (readonly IgnoreRule[])[],
  ignoreDirs: readonly string[],
  glob: GlobMatcher | undefined,
  depth: number,
  maxDepth: number | undefined,
  maxEntries: number,
  now: () => number,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<TraversalResult<void>> {
  if (isTimedOut(signal, now, deadline)) {
    return timeoutFailure(state);
  }
  if (isCancelled(signal)) {
    return fail("EIO", TRAVERSAL_ERROR_MESSAGES.EIO, {
      visitedEntries: state.visitedEntries,
      matchedItems: state.entries.length,
    });
  }
  let names: Buffer[];
  try {
    names = await readdir(directory, { encoding: "buffer" });
  } catch (error) {
    if (relativeDir.length === 0) {
      return filesystemRootFailure(error);
    }
    state.diagnostics.push({
      path: relativeDir,
      operation: "read-directory",
      code: filesystemErrorCode(error),
    });
    return { ok: true, value: undefined };
  }
  let childIgnoreStack = ignoreStack;
  let childIgnoreDirs = ignoreDirs;
  if (!includeIgnored) {
    const loaded = await loadGitignore(directory, relativeDir);
    if (loaded.diagnostic !== undefined) {
      state.diagnostics.push(loaded.diagnostic);
    }
    childIgnoreStack = [...ignoreStack, loaded.rules];
    childIgnoreDirs = [...ignoreDirs, relativeDir];
  }
  for (const name of names) {
    if (isTimedOut(signal, now, deadline)) {
      return timeoutFailure(state);
    }
    if (isCancelled(signal)) {
      return fail("EIO", TRAVERSAL_ERROR_MESSAGES.EIO, {
        visitedEntries: state.visitedEntries,
        matchedItems: state.entries.length,
      });
    }
    state.visitedEntries += 1;
    if (state.visitedEntries > maxEntries) {
      return fail("EQUERY_TOO_LARGE", TRAVERSAL_ERROR_MESSAGES.EQUERY_TOO_LARGE, {
        visitedEntries: state.visitedEntries,
        matchedItems: state.entries.length,
      });
    }
    const decodedName = decodeUtf8(name);
    if (decodedName === undefined) {
      const lossyName = new TextDecoder("utf-8").decode(name);
      const relativePath = relativeDir.length === 0 ? lossyName : `${relativeDir}/${lossyName}`;
      state.diagnostics.push({
        path: relativePath,
        operation: "read-metadata",
        code: "EUNSUPPORTED_NAME",
      });
      continue;
    }
    const entryName = decodedName;
    const relativePath = relativeDir.length === 0 ? entryName : `${relativeDir}/${entryName}`;
    let stats;
    try {
      stats = await lstat(join(directory, entryName));
    } catch (error) {
      state.diagnostics.push({
        path: relativePath,
        operation: "read-metadata",
        code: filesystemErrorCode(error),
      });
      continue;
    }
    if (stats.isSymbolicLink()) {
      if (
        !includeIgnored &&
        isIgnored(relativePath, false, childIgnoreStack, childIgnoreDirs)
      ) {
        continue;
      }
      if (glob === undefined || glob.test(relativePath)) {
        state.entries.push({ path: relativePath, type: "symlink" });
      }
      continue;
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      if (
        includeIgnored ||
        !isIgnored(relativePath, false, childIgnoreStack, childIgnoreDirs)
      ) {
        state.diagnostics.push({
          path: relativePath,
          operation: "read-metadata",
          code: "EUNSUPPORTED",
        });
      }
      continue;
    }
    const type: TraversalEntryType = stats.isDirectory() ? "directory" : "file";
    const isDirectory = type === "directory";
    if (
      !includeIgnored &&
      (isDirectory && entryName === ".git" ||
        isIgnored(relativePath, isDirectory, childIgnoreStack, childIgnoreDirs))
    ) {
      continue;
    }
    if (glob === undefined || glob.test(relativePath)) {
      state.entries.push({ path: relativePath, type });
    }
    if (isDirectory && (maxDepth === undefined || depth + 1 < maxDepth)) {
      const nested = await walk(
        join(directory, entryName),
        relativePath,
        state,
        includeIgnored,
        childIgnoreStack,
        childIgnoreDirs,
        glob,
        depth + 1,
        maxDepth,
        maxEntries,
        now,
        deadline,
        signal,
      );
      if (!nested.ok) {
        return nested;
      }
    }
  }
  return { ok: true, value: undefined };
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function isTimedOut(
  signal: AbortSignal | undefined,
  now: () => number,
  deadline: number,
): boolean {
  return now() >= deadline ||
    (signal?.aborted === true && isTimeoutReason(signal.reason));
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && !isTimeoutReason(signal.reason);
}

function timeoutFailure(state: WalkState): TraversalResult<never> {
  return fail("ETIMEDOUT", TRAVERSAL_ERROR_MESSAGES.ETIMEDOUT, {
    visitedEntries: state.visitedEntries,
    matchedItems: state.entries.length,
  });
}

function validateMaxDepth(maxDepth: number | undefined): TraversalResult<number | undefined> {
  if (maxDepth === undefined) {
    return { ok: true, value: undefined };
  }
  if (
    !Number.isInteger(maxDepth) ||
    maxDepth < 1 ||
    maxDepth > TRAVERSAL_MAX_DEPTH
  ) {
    return fail("EINVAL_DEPTH", "maxDepth is invalid.", { field: "maxDepth" });
  }
  return { ok: true, value: maxDepth };
}

export async function traverse(
  options: TraverseOptions,
): Promise<TraversalResult> {
  const depth = validateMaxDepth(options.maxDepth);
  if (!depth.ok) {
    return depth;
  }
  let glob: GlobMatcher | undefined;
  if (options.glob !== undefined) {
    const compiled = compileGlob(options.glob);
    if (!compiled.ok) {
      return compiled;
    }
    glob = compiled.value;
  }
  try {
    const rootStats = await lstat(options.searchRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return fail("ENOTDIR", "Path is not a directory");
    }
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? TRAVERSAL_DEFAULT_TIMEOUT_MS;
    const deadline = now() + timeoutMs;
    const state: WalkState = { entries: [], diagnostics: [], visitedEntries: 0 };
    const walked = await walk(
      options.searchRoot,
      "",
      state,
      options.includeIgnored === true,
      [],
      [],
      glob,
      0,
      depth.value,
      options.maxEntries ?? TRAVERSAL_ENTRY_BUDGET,
      now,
      deadline,
      options.signal,
    );
    if (!walked.ok) {
      return walked;
    }
    state.entries.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    state.diagnostics.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    return {
      ok: true,
      value: {
        entries: state.entries,
        diagnostics: state.diagnostics.slice(0, TRAVERSAL_MAX_DIAGNOSTICS),
      },
    };
  } catch (error) {
    return filesystemRootFailure(error);
  }
}
