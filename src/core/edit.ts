import { readFile } from "node:fs/promises";
import {
  observeReplacementTarget,
  replaceFile,
  type FileReplacementError,
  type FileReplacementHooks,
  type FileReplacementIdentity,
} from "./file-replacement.js";
import { isRecord, type JsonObject } from "./json.js";
import {
  createSessionPathResolver,
  type CwdRelation,
  type PathResolution,
  type PathResolutionError,
} from "./path-resolver.js";
import {
  countLineEndings,
  decodeUtf8Text,
  detectLineEnding,
  isWellFormedUnicode,
  type LineEnding,
} from "./text-file.js";
import {
  boundToolFailure,
  boundToolResult,
  type ToolResult,
} from "./tool-result.js";

export const EDIT_MAX_CONTENT_BYTES = 10 * 1024 * 1024;
export const EDIT_MAX_EDITS = 100;
export const EDIT_DEFAULT_TIMEOUT_MS = 10_000;

const DIFF_CONTEXT_LINES = 3;
const DIFF_NO_NEWLINE_MARKER = "\\ No newline at end of file";

const EDIT_DESCRIPTION =
  "Apply one batch of exact text replacements to an existing UTF-8 regular file. Use edit instead of shell text-processing commands when the existing text to change is known. Replacements are validated against the original content before one commit; matching is not fuzzy, each match must be unique by default, and replaceAll must be requested explicitly. The result includes a bounded unified diff.";

export type EditLineEnding = LineEnding;

export type EditErrorCode =
  | "EINVAL"
  | "EINVAL_PATH"
  | "ENOENT"
  | "EACCES"
  | "ELOOP"
  | "EIO"
  | "EISDIR"
  | "EUNSUPPORTED"
  | "EFILE_TOO_LARGE"
  | "EBINARY"
  | "EINVAL_EDIT"
  | "ENOMATCH"
  | "ENONUNIQUE"
  | "EOVERLAP"
  | "ENOCHANGE"
  | "ECONFLICT"
  | "ESYMLINK"
  | "ETIMEDOUT"
  | "ETOOL";

export type EditToolOptions = {
  readonly sessionCwd: string;
  readonly timeoutMs?: number;
  readonly replacementHooks?: FileReplacementHooks;
};

export type EditTool = {
  readonly name: "edit";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult>;
};

type ValidatedEdit = {
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll: boolean;
};

type ValidatedArguments = {
  readonly path: string;
  readonly edits: readonly ValidatedEdit[];
};

type PathFacts = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
};

/** A source span of the original content together with its replacement text. */
type ReplacementSpan = {
  readonly start: number;
  readonly end: number;
  readonly editIndex: number;
  readonly replacement: string;
};

type PlanFailure =
  | { readonly code: "ENOMATCH"; readonly editIndex: number }
  | {
      readonly code: "ENONUNIQUE";
      readonly editIndex: number;
      readonly matches: number;
    }
  | {
      readonly code: "EOVERLAP";
      readonly editIndexes: readonly [number, number];
    };

type ReplacementPlan =
  | { readonly ok: true; readonly spans: readonly ReplacementSpan[] }
  | { readonly ok: false; readonly failure: PlanFailure };

/** Offsets of every line of the original content, terminators excluded and included. */
type LineIndex = {
  readonly starts: readonly number[];
  readonly contentEnds: readonly number[];
  readonly ends: readonly number[];
};

/** A contiguous run of original lines replaced by `newLines`. */
type ChangeGroup = {
  readonly firstLine: number;
  readonly lastLine: number;
  readonly newLines: readonly string[];
  readonly reachesUpdatedEnd: boolean;
};

function fail(
  code: EditErrorCode,
  message: string,
  details?: JsonObject,
): ToolResult {
  if (details === undefined) {
    return { ok: false, error: { code, message } };
  }
  try {
    return boundToolFailure({
      error: { code, message, details },
      fields: [],
      records: [],
      strategy: "head",
    });
  } catch {
    return {
      ok: false,
      error: { code: "ETOOL", message: "Tool result exceeds its size limit." },
    };
  }
}

function invalid(field: string): ToolResult {
  return fail("EINVAL", "Invalid edit arguments.", { field });
}

function invalidEdit(message: string, details: JsonObject): ToolResult {
  return fail("EINVAL_EDIT", message, details);
}

function validateEdit(
  value: unknown,
  editIndex: number,
):
  | { readonly ok: true; readonly value: ValidatedEdit }
  | { readonly ok: false; readonly result: ToolResult } {
  if (!isRecord(value)) {
    return {
      ok: false,
      result: invalidEdit("Each edit must be an object.", { editIndex }),
    };
  }
  const extra = Object.keys(value).find(
    (key) => key !== "oldText" && key !== "newText" && key !== "replaceAll",
  );
  if (extra !== undefined) {
    return {
      ok: false,
      result: invalidEdit("Edit has an unknown field.", {
        editIndex,
        field: extra,
      }),
    };
  }
  if (typeof value.oldText !== "string" || value.oldText.length === 0) {
    return {
      ok: false,
      result: invalidEdit("oldText must be a non-empty string.", {
        editIndex,
        field: "oldText",
      }),
    };
  }
  if (typeof value.newText !== "string") {
    return {
      ok: false,
      result: invalidEdit("newText must be a string.", {
        editIndex,
        field: "newText",
      }),
    };
  }
  if (value.replaceAll !== undefined && typeof value.replaceAll !== "boolean") {
    return {
      ok: false,
      result: invalidEdit("replaceAll must be a boolean.", {
        editIndex,
        field: "replaceAll",
      }),
    };
  }
  return {
    ok: true,
    value: {
      oldText: value.oldText,
      newText: value.newText,
      replaceAll: value.replaceAll ?? false,
    },
  };
}

function validateArguments(input: unknown):
  | { readonly ok: true; readonly value: ValidatedArguments }
  | { readonly ok: false; readonly result: ToolResult } {
  if (!isRecord(input)) {
    return { ok: false, result: invalid("path") };
  }
  const extra = Object.keys(input).find(
    (key) => key !== "path" && key !== "edits",
  );
  if (extra !== undefined) {
    return { ok: false, result: invalid(extra) };
  }
  if (typeof input.path !== "string") {
    return { ok: false, result: invalid("path") };
  }
  if (!Array.isArray(input.edits)) {
    return { ok: false, result: invalid("edits") };
  }
  if (input.edits.length === 0 || input.edits.length > EDIT_MAX_EDITS) {
    return {
      ok: false,
      result: invalidEdit(`edits must hold 1 to ${EDIT_MAX_EDITS} items.`, {
        field: "edits",
        actualItems: input.edits.length,
        limitItems: EDIT_MAX_EDITS,
      }),
    };
  }
  const edits: ValidatedEdit[] = [];
  for (const [editIndex, candidate] of input.edits.entries()) {
    const validated = validateEdit(candidate, editIndex);
    if (!validated.ok) {
      return { ok: false, result: validated.result };
    }
    edits.push(validated.value);
  }
  return { ok: true, value: { path: input.path, edits } };
}

function pathFacts(resolution: PathResolution): PathFacts {
  return {
    resolvedPath: resolution.resolvedPath,
    realTargetPath: resolution.realTargetPath,
    cwdRelation: resolution.cwdRelation,
  };
}

function mapPathError(error: PathResolutionError): ToolResult {
  const details = error.details === undefined ? undefined : { ...error.details };
  const messages: Record<PathResolutionError["code"], string> = {
    EINVAL_PATH: "Path syntax is invalid.",
    ENOENT: "Path does not exist.",
    ELOOP: "Path contains a symlink loop.",
    EACCES: "Path cannot be edited.",
    EIO: "Path cannot be resolved.",
    ESYMLINK: "Final path component is a symlink.",
  };
  return fail(error.code, messages[error.code], details);
}

function mapReplacementError(
  error: FileReplacementError,
  facts: PathFacts,
): ToolResult {
  return fail(error.code, error.message, { ...facts, ...error.details });
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function mapReadError(error: unknown, facts: PathFacts): ToolResult {
  const code = nodeErrorCode(error);
  return code === "ENOENT"
    ? fail("ECONFLICT", "File changed during edit.", facts)
    : code === "EACCES" || code === "EPERM"
      ? fail("EACCES", "File cannot be read.", facts)
      : code === "EISDIR"
        ? fail("EISDIR", "Path is a directory.", facts)
        : fail("EIO", "File cannot be read.", facts);
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function abortResult(signal: AbortSignal, details?: JsonObject): ToolResult {
  return isTimeoutReason(signal.reason)
    ? fail("ETIMEDOUT", "Edit timed out.", details)
    : fail("ETOOL", "Tool execution failed.", details);
}

function mapPlanFailure(failure: PlanFailure, facts: PathFacts): ToolResult {
  if (failure.code === "ENOMATCH") {
    return fail("ENOMATCH", "oldText does not appear in the file.", {
      ...facts,
      editIndex: failure.editIndex,
    });
  }
  if (failure.code === "ENONUNIQUE") {
    return fail("ENONUNIQUE", "oldText appears more than once.", {
      ...facts,
      editIndex: failure.editIndex,
      matches: failure.matches,
    });
  }
  return fail("EOVERLAP", "Two edits replace the same source text.", {
    ...facts,
    editIndexes: [...failure.editIndexes],
  });
}

/**
 * The original content with CRLF folded to LF, plus the original offset of every
 * folded position. `offsets` is omitted when the content holds no CRLF, in which
 * case folded positions are original offsets.
 */
type MatchIndex = {
  readonly folded: string;
  readonly offsets: readonly number[] | undefined;
};

function buildMatchIndex(text: string): MatchIndex {
  if (!text.includes("\r\n")) {
    return { folded: text, offsets: undefined };
  }
  const folded = text.replaceAll("\r\n", "\n");
  const offsets = new Array<number>(folded.length + 1);
  let position = 0;
  let index = 0;
  while (index < text.length) {
    offsets[position] = index;
    position += 1;
    index += text[index] === "\r" && text[index + 1] === "\n" ? 2 : 1;
  }
  offsets[position] = text.length;
  return { folded, offsets };
}

function originalOffset(index: MatchIndex, position: number): number {
  return index.offsets === undefined ? position : index.offsets[position]!;
}

function foldToLf(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

function applyLineEnding(text: string, ending: "lf" | "crlf"): string {
  const folded = foldToLf(text);
  return ending === "crlf" ? folded.replaceAll("\n", "\r\n") : folded;
}

function regionLineEnding(region: string): "lf" | "crlf" {
  const at = region.indexOf("\n");
  return at > 0 && region[at - 1] === "\r" ? "crlf" : "lf";
}

function findMatches(haystack: string, needle: string): readonly number[] {
  const positions: number[] = [];
  let from = 0;
  while (true) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return positions;
    }
    positions.push(at);
    from = at + needle.length;
  }
}

/**
 * Resolves every edit against the same original content and returns the source
 * spans in source order, or the first deterministic match or overlap failure.
 */
function planReplacements(
  text: string,
  edits: readonly ValidatedEdit[],
): ReplacementPlan {
  const matchIndex = buildMatchIndex(text);
  const { lf, crlf } = countLineEndings(text);
  const dominant = crlf > lf ? "crlf" : lf > crlf ? "lf" : undefined;
  const spans: ReplacementSpan[] = [];
  for (const [editIndex, edit] of edits.entries()) {
    const needle = foldToLf(edit.oldText);
    const positions = findMatches(matchIndex.folded, needle);
    if (positions.length === 0) {
      return { ok: false, failure: { code: "ENOMATCH", editIndex } };
    }
    if (!edit.replaceAll && positions.length > 1) {
      return {
        ok: false,
        failure: {
          code: "ENONUNIQUE",
          editIndex,
          matches: positions.length,
        },
      };
    }
    for (const position of positions) {
      const start = originalOffset(matchIndex, position);
      const end = originalOffset(matchIndex, position + needle.length);
      spans.push({
        start,
        end,
        editIndex,
        replacement: applyLineEnding(
          edit.newText,
          dominant ?? regionLineEnding(text.slice(start, end)),
        ),
      });
    }
  }

  const ordered = [...spans].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.start < previous.end) {
      return {
        ok: false,
        failure: {
          code: "EOVERLAP",
          editIndexes: [
            Math.min(previous.editIndex, current.editIndex),
            Math.max(previous.editIndex, current.editIndex),
          ],
        },
      };
    }
  }
  return { ok: true, spans: ordered };
}

function applyReplacements(
  text: string,
  spans: readonly ReplacementSpan[],
): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    parts.push(text.slice(cursor, span.start), span.replacement);
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function indexLines(text: string): LineIndex {
  const starts: number[] = [];
  const contentEnds: number[] = [];
  const ends: number[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }
    starts.push(start);
    contentEnds.push(index > start && text[index - 1] === "\r" ? index - 1 : index);
    ends.push(index + 1);
    start = index + 1;
  }
  if (start < text.length) {
    starts.push(start);
    contentEnds.push(text.length);
    ends.push(text.length);
  }
  return { starts, contentEnds, ends };
}

function lineAt(lines: LineIndex, offset: number): number {
  let low = 0;
  let high = lines.starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lines.starts[middle]! <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function splitRegionLines(region: string): readonly string[] {
  if (region === "") {
    return [];
  }
  const body = region.endsWith("\r\n")
    ? region.slice(0, -2)
    : region.endsWith("\n")
      ? region.slice(0, -1)
      : region;
  return body.split(/\r\n|\n/);
}

function buildChangeGroups(
  updated: string,
  spans: readonly ReplacementSpan[],
  lines: LineIndex,
): readonly ChangeGroup[] {
  const runs: { firstLine: number; lastLine: number }[] = [];
  for (const span of spans) {
    const firstLine = lineAt(lines, span.start);
    const lastLine = lineAt(lines, span.end - 1);
    const previous = runs.at(-1);
    if (previous !== undefined && firstLine <= previous.lastLine + 1) {
      previous.lastLine = Math.max(previous.lastLine, lastLine);
      continue;
    }
    runs.push({ firstLine, lastLine });
  }

  const groups: ChangeGroup[] = [];
  let spanIndex = 0;
  let delta = 0;
  for (const run of runs) {
    const regionStart = lines.starts[run.firstLine]!;
    const regionEnd = lines.ends[run.lastLine]!;
    while (spanIndex < spans.length && spans[spanIndex]!.end <= regionStart) {
      const span = spans[spanIndex]!;
      delta += span.replacement.length - (span.end - span.start);
      spanIndex += 1;
    }
    const updatedStart = regionStart + delta;
    while (spanIndex < spans.length && spans[spanIndex]!.end <= regionEnd) {
      const span = spans[spanIndex]!;
      delta += span.replacement.length - (span.end - span.start);
      spanIndex += 1;
    }
    const updatedEnd = regionEnd + delta;
    groups.push({
      firstLine: run.firstLine,
      lastLine: run.lastLine,
      newLines: splitRegionLines(updated.slice(updatedStart, updatedEnd)),
      reachesUpdatedEnd: updatedEnd === updated.length,
    });
  }
  return groups;
}

/**
 * Renders the applied spans as a compact unified diff without file headers.
 * Returned as one string per diff line so the caller can bound it line by line.
 */
function buildDiffLines(
  original: string,
  updated: string,
  spans: readonly ReplacementSpan[],
): readonly string[] {
  const lines = indexLines(original);
  const groups = buildChangeGroups(updated, spans, lines);
  if (groups.length === 0) {
    return [];
  }
  const lastLine = lines.starts.length - 1;
  const originalOpenEnded = original.length > 0 && !original.endsWith("\n");
  const updatedOpenEnded = updated.length > 0 && !updated.endsWith("\n");
  const lineText = (index: number): string =>
    original.slice(lines.starts[index]!, lines.contentEnds[index]!);

  const hunks: ChangeGroup[][] = [];
  for (const group of groups) {
    const current = hunks.at(-1);
    if (
      current !== undefined &&
      group.firstLine - current.at(-1)!.lastLine - 1 <= DIFF_CONTEXT_LINES * 2
    ) {
      current.push(group);
      continue;
    }
    hunks.push([group]);
  }

  const output: string[] = [];
  let lineDelta = 0;
  for (const hunk of hunks) {
    const start = Math.max(0, hunk[0]!.firstLine - DIFF_CONTEXT_LINES);
    const end = Math.min(lastLine, hunk.at(-1)!.lastLine + DIFF_CONTEXT_LINES);
    const body: string[] = [];
    let contextCount = 0;
    let addedCount = 0;
    let cursor = start;
    for (const group of hunk) {
      for (let line = cursor; line < group.firstLine; line += 1) {
        body.push(` ${lineText(line)}`);
        contextCount += 1;
      }
      for (let line = group.firstLine; line <= group.lastLine; line += 1) {
        body.push(`-${lineText(line)}`);
      }
      if (group.lastLine === lastLine && originalOpenEnded) {
        body.push(DIFF_NO_NEWLINE_MARKER);
      }
      for (const line of group.newLines) {
        body.push(`+${line}`);
        addedCount += 1;
      }
      if (
        group.newLines.length > 0 &&
        group.reachesUpdatedEnd &&
        updatedOpenEnded
      ) {
        body.push(DIFF_NO_NEWLINE_MARKER);
      }
      cursor = group.lastLine + 1;
    }
    for (let line = cursor; line <= end; line += 1) {
      body.push(` ${lineText(line)}`);
      contextCount += 1;
    }
    if (cursor <= end && end === lastLine && originalOpenEnded) {
      body.push(DIFF_NO_NEWLINE_MARKER);
    }
    const originalCount = end - start + 1;
    const updatedCount = contextCount + addedCount;
    output.push(
      `@@ -${formatDiffRange(start, originalCount)} +${formatDiffRange(start + lineDelta, updatedCount)} @@`,
      ...body,
    );
    lineDelta += updatedCount - originalCount;
  }
  return output;
}

function formatDiffRange(start: number, count: number): string {
  return count === 0
    ? `${start},0`
    : count === 1
      ? `${start + 1}`
      : `${start + 1},${count}`;
}

function failOversized(
  facts: PathFacts,
  actualBytes: number,
  message: string,
): ToolResult {
  return fail("EFILE_TOO_LARGE", message, {
    ...facts,
    actualBytes,
    limitBytes: EDIT_MAX_CONTENT_BYTES,
  });
}

function boundedSuccess(
  facts: PathFacts,
  identity: FileReplacementIdentity,
  edits: readonly ValidatedEdit[],
  spans: readonly ReplacementSpan[],
  updated: string,
  bom: boolean,
  bytesWritten: number,
  diffLines: readonly string[],
): ToolResult {
  try {
    return boundToolResult({
      result: {
        ...facts,
        editsApplied: edits.length,
        replacementsApplied: spans.length,
        bytesWritten,
        bom,
        lineEnding: detectLineEnding(updated),
        detachedHardLinks: identity.nlink > 1,
      },
      fields: [
        {
          name: "diff",
          kind: "text",
          separator: "\n",
          truncateOversizedRecords: true,
        },
      ],
      records: diffLines.map((line) => ({
        field: "diff",
        value: line,
        lines: 1 as const,
      })),
      strategy: "head",
      includeTotal: ["bytes", "lines"],
    });
  } catch {
    return {
      ok: false,
      error: { code: "ETOOL", message: "Tool result exceeds its size limit." },
    };
  }
}

export async function executeEdit(
  input: unknown,
  options: EditToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult> {
  const validated = validateArguments(input);
  if (!validated.ok) {
    return validated.result;
  }

  const timeout = AbortSignal.timeout(
    options.timeoutMs ?? EDIT_DEFAULT_TIMEOUT_MS,
  );
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([timeout, options.signal]);
  if (signal.aborted) {
    return abortResult(signal);
  }

  const resolverResult = await createSessionPathResolver(options.sessionCwd);
  if (signal.aborted) {
    return abortResult(signal);
  }
  if (!resolverResult.ok) {
    return mapPathError(resolverResult.error);
  }
  const resolved = await resolverResult.value.resolve(validated.value.path, {
    existence: "required",
    symlinks: "reject-final",
  });
  if (signal.aborted) {
    return abortResult(signal);
  }
  if (!resolved.ok) {
    return mapPathError(resolved.error);
  }
  const facts = pathFacts(resolved.value);

  const observed = await observeReplacementTarget(facts.realTargetPath);
  if (signal.aborted) {
    return abortResult(signal, facts);
  }
  if (!observed.ok) {
    return mapReplacementError(observed.error, facts);
  }
  const baseline = observed.value;
  if (!baseline.exists) {
    return fail("ENOENT", "Path does not exist.", facts);
  }
  if (baseline.identity.size > EDIT_MAX_CONTENT_BYTES) {
    return failOversized(
      facts,
      baseline.identity.size,
      "File exceeds the 10 MiB size limit.",
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(facts.realTargetPath, { signal });
  } catch (error) {
    return signal.aborted
      ? abortResult(signal, facts)
      : mapReadError(error, facts);
  }
  const decoded = decodeUtf8Text(bytes);
  if (!decoded.ok) {
    return fail("EBINARY", "File is not valid UTF-8 text.", facts);
  }
  const binaryEditIndex = validated.value.edits.findIndex(
    (edit) => edit.newText.includes("\0") || !isWellFormedUnicode(edit.newText),
  );
  if (binaryEditIndex !== -1) {
    return fail(
      "EBINARY",
      "newText must be valid UTF-8 text without NUL bytes.",
      { ...facts, editIndex: binaryEditIndex, field: "newText" },
    );
  }
  if (signal.aborted) {
    return abortResult(signal, facts);
  }

  const planned = planReplacements(decoded.text, validated.value.edits);
  if (!planned.ok) {
    return mapPlanFailure(planned.failure, facts);
  }
  const updated = applyReplacements(decoded.text, planned.spans);
  const contents = `${decoded.bom ? "\uFEFF" : ""}${updated}`;
  const bytesWritten = Buffer.byteLength(contents, "utf8");
  if (bytesWritten > EDIT_MAX_CONTENT_BYTES) {
    return failOversized(
      facts,
      bytesWritten,
      "Edit result exceeds the 10 MiB size limit.",
    );
  }
  if (updated === decoded.text) {
    return fail("ENOCHANGE", "The batch leaves the file unchanged.", facts);
  }
  if (bytes.byteLength !== baseline.identity.size) {
    return fail("ECONFLICT", "File changed during edit.", facts);
  }

  const successResult = boundedSuccess(
    facts,
    baseline.identity,
    validated.value.edits,
    planned.spans,
    updated,
    decoded.bom,
    bytesWritten,
    buildDiffLines(decoded.text, updated, planned.spans),
  );
  if (!successResult.ok) {
    return successResult;
  }
  if (signal.aborted) {
    return abortResult(signal, facts);
  }

  const replaced = await replaceFile({
    targetPath: facts.realTargetPath,
    contents: Buffer.from(contents, "utf8"),
    baseline,
    signal,
    ...(options.replacementHooks === undefined
      ? {}
      : { hooks: options.replacementHooks }),
  });
  return replaced.ok
    ? successResult
    : mapReplacementError(replaced.error, facts);
}

export function createEditTool(options: EditToolOptions): EditTool {
  return {
    name: "edit",
    description: EDIT_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Absolute or Session-cwd-relative file path",
        },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: EDIT_MAX_EDITS,
          description:
            "Replacements to apply as one batch, all matched against the original content",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              oldText: {
                type: "string",
                minLength: 1,
                description:
                  "Exact text to replace; include enough surrounding text to make it unique",
              },
              newText: {
                type: "string",
                description: "Replacement text; empty deletes oldText",
              },
              replaceAll: {
                type: "boolean",
                description:
                  "Replace every non-overlapping match instead of requiring exactly one; defaults to false",
              },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "edits"],
    },
    execute(input, signal) {
      return executeEdit(input, {
        ...options,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  };
}
