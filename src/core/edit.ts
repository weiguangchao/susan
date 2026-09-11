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
import { type ToolResult } from "./tool-result.js";

export const EDIT_MAX_CONTENT_BYTES = 10 * 1024 * 1024;
export const EDIT_MAX_EDITS = 100;
export const EDIT_DEFAULT_TIMEOUT_MS = 10_000;

const DIFF_CONTEXT_LINES = 3;
const DIFF_NO_NEWLINE_MARKER = "\\ No newline at end of file";

const EDIT_DESCRIPTION =
  "Apply one batch of exact text replacements to an existing UTF-8 regular file. Use edit instead of shell text-processing commands when the existing text to change is known. Replacements are validated against the original content before one commit; matching is not fuzzy, each match must be unique by default, and replaceAll must be requested explicitly. The result includes a bounded unified diff.";

export type EditLineEnding = LineEnding;

export type EditToolOptions = {
  readonly sessionCwd: string;
  readonly timeoutMs?: number;
  readonly replacementHooks?: FileReplacementHooks;
};

export type EditToolDetails = {
  readonly resolvedPath: string;
  readonly realTargetPath: string;
  readonly cwdRelation: CwdRelation;
  readonly editsApplied: number;
  readonly replacementsApplied: number;
  readonly bytesWritten: number;
  readonly bom: boolean;
  readonly lineEnding: EditLineEnding;
  readonly detachedHardLinks: boolean;
  readonly diff: string;
};

export type EditTool = {
  readonly name: "edit";
  readonly description: string;
  readonly parameters: JsonObject;
  execute(input: unknown, signal?: AbortSignal): Promise<ToolResult<EditToolDetails>>;
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

function fail(message: string): never {
  throw new Error(message);
}

function invalid(_field: string): never {
  fail("Invalid edit arguments.");
}

function invalidEdit(message: string, _details: JsonObject): never {
  fail(message);
}

function validateEdit(value: unknown, editIndex: number): ValidatedEdit {
  if (!isRecord(value)) {
    invalidEdit("Each edit must be an object.", { editIndex });
  }
  const extra = Object.keys(value).find(
    (key) => key !== "oldText" && key !== "newText" && key !== "replaceAll",
  );
  if (extra !== undefined) {
    invalidEdit("Edit has an unknown field.", {
      editIndex,
      field: extra,
    });
  }
  if (typeof value.oldText !== "string" || value.oldText.length === 0) {
    invalidEdit("oldText must be a non-empty string.", {
      editIndex,
      field: "oldText",
    });
  }
  if (typeof value.newText !== "string") {
    invalidEdit("newText must be a string.", {
      editIndex,
      field: "newText",
    });
  }
  if (value.replaceAll !== undefined && typeof value.replaceAll !== "boolean") {
    invalidEdit("replaceAll must be a boolean.", {
      editIndex,
      field: "replaceAll",
    });
  }
  return {
    oldText: value.oldText,
    newText: value.newText,
    replaceAll: value.replaceAll ?? false,
  };
}

function validateArguments(input: unknown): ValidatedArguments {
  if (!isRecord(input)) {
    invalid("path");
  }
  const extra = Object.keys(input).find(
    (key) => key !== "path" && key !== "edits",
  );
  if (extra !== undefined) {
    invalid(extra);
  }
  if (typeof input.path !== "string") {
    invalid("path");
  }
  if (!Array.isArray(input.edits)) {
    invalid("edits");
  }
  if (input.edits.length === 0 || input.edits.length > EDIT_MAX_EDITS) {
    invalidEdit(`edits must hold 1 to ${EDIT_MAX_EDITS} items.`, {
      field: "edits",
      actualItems: input.edits.length,
      limitItems: EDIT_MAX_EDITS,
    });
  }
  const edits = input.edits.map((candidate, editIndex) =>
    validateEdit(candidate, editIndex),
  );
  return { path: input.path, edits };
}

function pathFacts(resolution: PathResolution): PathFacts {
  return {
    resolvedPath: resolution.resolvedPath,
    realTargetPath: resolution.realTargetPath,
    cwdRelation: resolution.cwdRelation,
  };
}

function mapPathError(error: PathResolutionError): never {
  const messages: Record<PathResolutionError["code"], string> = {
    EINVAL_PATH: "Path syntax is invalid.",
    ENOENT: "Path does not exist.",
    ELOOP: "Path contains a symlink loop.",
    EACCES: "Path cannot be edited.",
    EIO: "Path cannot be resolved.",
    ESYMLINK: "Final path component is a symlink.",
  };
  fail(messages[error.code]);
}

function mapReplacementError(error: FileReplacementError): never {
  fail(error.message);
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function mapReadError(error: unknown): never {
  const code = nodeErrorCode(error);
  if (code === "ENOENT") {
    fail("File changed during edit.");
  }
  if (code === "EACCES" || code === "EPERM") {
    fail("File cannot be read.");
  }
  if (code === "EISDIR") {
    fail("Path is a directory.");
  }
  fail("File cannot be read.");
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "TimeoutError";
}

function abortResult(signal: AbortSignal): never {
  if (isTimeoutReason(signal.reason)) {
    fail("Edit timed out.");
  }
  fail("Tool execution failed.");
}

function mapPlanFailure(failure: PlanFailure): never {
  if (failure.code === "ENOMATCH") {
    fail("oldText does not appear in the file.");
  }
  if (failure.code === "ENONUNIQUE") {
    fail("oldText appears more than once.");
  }
  fail("Two edits replace the same source text.");
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

function boundedSuccess(
  facts: PathFacts,
  identity: FileReplacementIdentity,
  edits: readonly ValidatedEdit[],
  spans: readonly ReplacementSpan[],
  updated: string,
  bom: boolean,
  bytesWritten: number,
  diffLines: readonly string[],
): ToolResult<EditToolDetails> {
  const diff = diffLines.join("\n");
  return {
    content: [
      {
        type: "text",
        text: `Successfully replaced ${edits.length} block(s) in ${facts.resolvedPath}.`,
      },
    ],
    details: {
      ...facts,
      editsApplied: edits.length,
      replacementsApplied: spans.length,
      bytesWritten,
      bom,
      lineEnding: detectLineEnding(updated),
      detachedHardLinks: identity.nlink > 1,
      diff,
    },
  };
}

export async function executeEdit(
  input: unknown,
  options: EditToolOptions & { readonly signal?: AbortSignal },
): Promise<ToolResult<EditToolDetails>> {
  const validated = validateArguments(input);

  const timeout = AbortSignal.timeout(
    options.timeoutMs ?? EDIT_DEFAULT_TIMEOUT_MS,
  );
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([timeout, options.signal]);
  if (signal.aborted) {
    abortResult(signal);
  }

  const resolverResult = await createSessionPathResolver(options.sessionCwd);
  if (signal.aborted) {
    abortResult(signal);
  }
  if (!resolverResult.ok) {
    mapPathError(resolverResult.error);
  }
  const resolved = await resolverResult.value.resolve(validated.path, {
    existence: "required",
    symlinks: "reject-final",
  });
  if (signal.aborted) {
    abortResult(signal);
  }
  if (!resolved.ok) {
    mapPathError(resolved.error);
  }
  const facts = pathFacts(resolved.value);

  const observed = await observeReplacementTarget(facts.realTargetPath);
  if (signal.aborted) {
    abortResult(signal);
  }
  if (!observed.ok) {
    mapReplacementError(observed.error);
  }
  const baseline = observed.value;
  if (!baseline.exists) {
    fail("Path does not exist.");
  }
  if (baseline.identity.size > EDIT_MAX_CONTENT_BYTES) {
    fail("File exceeds the 10 MiB size limit.");
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(facts.realTargetPath, { signal });
  } catch (error) {
    if (signal.aborted) {
      abortResult(signal);
    }
    mapReadError(error);
  }
  const decoded = decodeUtf8Text(bytes);
  if (!decoded.ok) {
    fail("File is not valid UTF-8 text.");
  }
  const binaryEditIndex = validated.edits.findIndex(
    (edit) => edit.newText.includes("\0") || !isWellFormedUnicode(edit.newText),
  );
  if (binaryEditIndex !== -1) {
    fail("newText must be valid UTF-8 text without NUL bytes.");
  }
  if (signal.aborted) {
    abortResult(signal);
  }

  const planned = planReplacements(decoded.text, validated.edits);
  if (!planned.ok) {
    mapPlanFailure(planned.failure);
  }
  const updated = applyReplacements(decoded.text, planned.spans);
  const contents = `${decoded.bom ? "\uFEFF" : ""}${updated}`;
  const bytesWritten = Buffer.byteLength(contents, "utf8");
  if (bytesWritten > EDIT_MAX_CONTENT_BYTES) {
    fail("Edit result exceeds the 10 MiB size limit.");
  }
  if (updated === decoded.text) {
    fail("The batch leaves the file unchanged.");
  }
  if (bytes.byteLength !== baseline.identity.size) {
    fail("File changed during edit.");
  }

  const successResult = boundedSuccess(
    facts,
    baseline.identity,
    validated.edits,
    planned.spans,
    updated,
    decoded.bom,
    bytesWritten,
    buildDiffLines(decoded.text, updated, planned.spans),
  );
  if (signal.aborted) {
    abortResult(signal);
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
  if (!replaced.ok) {
    mapReplacementError(replaced.error);
  }
  return successResult;
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
