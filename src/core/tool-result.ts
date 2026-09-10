import { isDeepStrictEqual } from "node:util";
import {
  isRecord,
  type JsonObject,
  type JsonValue,
} from "./json.js";

export const TOOL_RESULT_OUTPUT_BUDGET_BYTES = 50 * 1024;
export const TOOL_RESULT_FIXED_BUDGET_BYTES = 8 * 1024;

const TOOL_ERROR_CODE_MAX_BYTES = 128;
const TOOL_ERROR_MESSAGE_MAX_BYTES = 1024;
const TOOL_RESULT_ENVELOPE_OVERHEAD_BYTES = 1024;
const TOOL_RESULT_FIXED_PAYLOAD_MAX_BYTES =
  TOOL_RESULT_FIXED_BUDGET_BYTES - TOOL_RESULT_ENVELOPE_OVERHEAD_BYTES;
const SENSITIVE_DETAIL_KEYS = new Set([
  "cause",
  "env",
  "environment",
  "input",
  "stack",
  "stacktrace",
]);

export const SHARED_TOOL_ERROR_CODES = [
  "EINVAL",
  "ENOENT",
  "EACCES",
  "ETIMEDOUT",
  "EUNSUPPORTED",
  "EIO",
  "ETOOL",
] as const;

export type SharedToolErrorCode = (typeof SHARED_TOOL_ERROR_CODES)[number];
export type ToolTruncationReason =
  | "bytes"
  | "lines"
  | "items"
  | "line-length";
export type ToolResultStrategy = "head" | "tail";

export type ToolResultMeta = {
  readonly truncation?: {
    readonly reasons: readonly ToolTruncationReason[];
    readonly strategy: ToolResultStrategy;
    readonly fields: readonly string[];
    readonly retained: {
      readonly bytes: number;
      readonly lines?: number;
      readonly items?: number;
    };
    readonly total?: {
      readonly bytes?: number;
      readonly lines?: number;
      readonly items?: number;
    };
    readonly nextArguments?: JsonObject;
  };
};

export type ToolError<Code extends string = string> = {
  readonly code: Code;
  readonly message: string;
  readonly details?: JsonObject;
};

export type ToolResult<T extends JsonObject = JsonObject> =
  | { readonly ok: true; readonly result: T; readonly meta?: ToolResultMeta }
  | {
      readonly ok: false;
      readonly error: ToolError;
      readonly meta?: ToolResultMeta;
    };

export type ToolResultField =
  | {
      readonly name: string;
      readonly kind: "text";
      readonly separator?: string;
      readonly truncateOversizedRecords?: boolean;
    }
  | { readonly name: string; readonly kind: "items" };

export type ToolResultRecord = {
  readonly field: string;
  readonly value: JsonValue;
  readonly lines?: number;
  readonly items?: number;
  readonly truncatedBy?: "line-length";
};

export type ToolResultContinuationContext = {
  readonly firstOmittedRecordIndex: number | undefined;
  readonly retainedRecordIndices: readonly number[];
};

export type BoundToolResultOptions<T extends JsonObject> = {
  readonly result: T;
  readonly fields: readonly ToolResultField[];
  readonly records: readonly ToolResultRecord[];
  readonly strategy: ToolResultStrategy;
  readonly limits?: {
    readonly bytes?: number;
    readonly lines?: number;
    readonly items?: number;
  };
  readonly includeTotal?: readonly ("bytes" | "lines" | "items")[];
  readonly continuation?: (
    context: ToolResultContinuationContext,
  ) => JsonObject | undefined;
};

export type BoundToolFailureOptions<Code extends string = string> = Omit<
  BoundToolResultOptions<JsonObject>,
  "result"
> & {
  readonly error: ToolError<Code>;
};

const TRUNCATION_REASON_ORDER: readonly ToolTruncationReason[] = [
  "bytes",
  "lines",
  "items",
  "line-length",
];

const INVALID_TOOL_RESULT: ToolResult = {
  ok: false,
  error: { code: "ETOOL", message: "Tool returned an invalid result." },
};

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function normalizeJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return undefined;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const normalized: JsonValue[] = [];
      for (const item of value) {
        const next = normalizeJsonValue(item, ancestors);
        if (next === undefined) {
          return undefined;
        }
        normalized.push(next);
      }
      return normalized;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      let raw: unknown;
      try {
        raw = (value as Record<string, unknown>)[key];
      } catch {
        return undefined;
      }
      const next = normalizeJsonValue(raw, ancestors);
      if (next === undefined) {
        return undefined;
      }
      normalized[key] = next;
    }
    return normalized;
  } catch {
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeJsonObject(value: unknown): JsonObject | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized = normalizeJsonValue(value);
  return normalized !== undefined && !Array.isArray(normalized)
    ? (normalized as JsonObject)
    : undefined;
}

function jsonByteLength(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function containsSensitiveDetail(value: JsonValue): boolean {
  if (Array.isArray(value)) {
    return value.some(containsSensitiveDetail);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(
    ([key, nested]) =>
      SENSITIVE_DETAIL_KEYS.has(key.toLowerCase()) ||
      containsSensitiveDetail(nested),
  );
}

function isCanonicalEnvelopeBounded(value: ToolResult): boolean {
  const envelopeBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  return envelopeBytes <=
    TOOL_RESULT_OUTPUT_BUDGET_BYTES + TOOL_RESULT_FIXED_BUDGET_BYTES;
}

function fixedEnvelopeBytes(
  value: ToolResult,
  variableFields: readonly ToolResultField[],
): number {
  const record = value.ok ? value.result : (value.error.details ?? {});
  const withoutVariableContent: Record<string, JsonValue> = { ...record };
  for (const field of variableFields) {
    withoutVariableContent[field.name] = field.kind === "text" ? "" : [];
  }
  const envelope: ToolResult = value.ok
    ? { ...value, result: withoutVariableContent }
    : {
        ...value,
        error: { ...value.error, details: withoutVariableContent },
      };
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function normalizeCountObject(
  value: unknown,
  bytesRequired: boolean,
): { readonly bytes?: number; readonly lines?: number; readonly items?: number } | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, bytesRequired ? ["bytes"] : [], ["bytes", "lines", "items"])
  ) {
    return undefined;
  }
  const normalized: { bytes?: number; lines?: number; items?: number } = {};
  for (const key of ["bytes", "lines", "items"] as const) {
    if (Object.hasOwn(value, key)) {
      if (!isNonNegativeInteger(value[key])) {
        return undefined;
      }
      normalized[key] = value[key];
    }
  }
  return normalized;
}

function normalizeMeta(value: unknown): ToolResultMeta | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [], ["truncation"])) {
    return undefined;
  }
  if (!Object.hasOwn(value, "truncation")) {
    return {};
  }
  const truncation = value.truncation;
  if (
    !isRecord(truncation) ||
    !hasExactKeys(
      truncation,
      ["reasons", "strategy", "fields", "retained"],
      ["total", "nextArguments"],
    ) ||
    !Array.isArray(truncation.reasons) ||
    truncation.reasons.length === 0 ||
    !truncation.reasons.every((reason) =>
      TRUNCATION_REASON_ORDER.includes(reason as ToolTruncationReason),
    ) ||
    new Set(truncation.reasons).size !== truncation.reasons.length ||
    (truncation.reasons as unknown[]).some(
      (reason, index) =>
        index > 0 &&
        TRUNCATION_REASON_ORDER.indexOf(reason as ToolTruncationReason) <=
        TRUNCATION_REASON_ORDER.indexOf(
          (truncation.reasons as unknown[])[index - 1] as ToolTruncationReason,
        ),
    ) ||
    (truncation.strategy !== "head" && truncation.strategy !== "tail") ||
    !Array.isArray(truncation.fields) ||
    truncation.fields.length === 0 ||
    !truncation.fields.every(
      (field) => typeof field === "string" && field.length > 0,
    ) ||
    new Set(truncation.fields).size !== truncation.fields.length
  ) {
    return undefined;
  }
  const retained = normalizeCountObject(truncation.retained, true);
  const total = Object.hasOwn(truncation, "total")
    ? normalizeCountObject(truncation.total, false)
    : undefined;
  const nextArguments = Object.hasOwn(truncation, "nextArguments")
    ? normalizeJsonObject(truncation.nextArguments)
    : undefined;
  if (
    retained === undefined ||
    (Object.hasOwn(truncation, "total") && total === undefined) ||
    (Object.hasOwn(truncation, "nextArguments") && nextArguments === undefined)
  ) {
    return undefined;
  }
  return {
    truncation: {
      reasons: [...(truncation.reasons as ToolTruncationReason[])],
      strategy: truncation.strategy,
      fields: [...(truncation.fields as string[])],
      retained: retained as { bytes: number; lines?: number; items?: number },
      ...(total === undefined ? {} : { total }),
      ...(nextArguments === undefined ? {} : { nextArguments }),
    },
  };
}

export function normalizeToolResult(value: unknown): ToolResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return INVALID_TOOL_RESULT;
  }
  const meta = Object.hasOwn(value, "meta") ? normalizeMeta(value.meta) : undefined;
  if (Object.hasOwn(value, "meta") && meta === undefined) {
    return INVALID_TOOL_RESULT;
  }
  if (value.ok) {
    if (!hasExactKeys(value, ["ok", "result"], ["meta"])) {
      return INVALID_TOOL_RESULT;
    }
    const result = normalizeJsonObject(value.result);
    if (result === undefined) {
      return INVALID_TOOL_RESULT;
    }
    const normalized: ToolResult = {
      ok: true,
      result,
      ...(meta === undefined ? {} : { meta }),
    };
    return isCanonicalEnvelopeBounded(normalized)
      ? normalized
      : INVALID_TOOL_RESULT;
  }
  if (
    !hasExactKeys(value, ["ok", "error"], ["meta"]) ||
    !isRecord(value.error) ||
    !hasExactKeys(value.error, ["code", "message"], ["details"]) ||
    typeof value.error.code !== "string" ||
    value.error.code.length === 0 ||
    typeof value.error.message !== "string"
  ) {
    return INVALID_TOOL_RESULT;
  }
  const details = Object.hasOwn(value.error, "details")
    ? normalizeJsonObject(value.error.details)
    : undefined;
  if (Object.hasOwn(value.error, "details") && details === undefined) {
    return INVALID_TOOL_RESULT;
  }
  if (
    Buffer.byteLength(value.error.code, "utf8") > TOOL_ERROR_CODE_MAX_BYTES ||
    Buffer.byteLength(value.error.message, "utf8") >
      TOOL_ERROR_MESSAGE_MAX_BYTES ||
    (details !== undefined && containsSensitiveDetail(details))
  ) {
    return INVALID_TOOL_RESULT;
  }
  const normalized: ToolResult = {
    ok: false,
    error: {
      code: value.error.code,
      message: value.error.message,
      ...(details === undefined ? {} : { details }),
    },
    ...(meta === undefined ? {} : { meta }),
  };
  return isCanonicalEnvelopeBounded(normalized)
    ? normalized
    : INVALID_TOOL_RESULT;
}

export function isToolResult(value: unknown): value is ToolResult {
  return isDeepStrictEqual(normalizeToolResult(value), value);
}

function nonNegativeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("Output budget limits must be non-negative integers.");
  }
  return value;
}

export function boundToolResult<T extends JsonObject>(
  options: BoundToolResultOptions<T>,
): ToolResult<T & JsonObject> {
  const normalizedResult = normalizeJsonObject(options.result);
  if (normalizedResult === undefined) {
    throw new TypeError("Tool result base fields must be a JSON-safe object.");
  }
  const fieldNames = options.fields.map((field) => field.name);
  if (
    new Set(fieldNames).size !== fieldNames.length ||
    fieldNames.some(
      (name) => name.length === 0 || Object.hasOwn(normalizedResult, name),
    )
  ) {
    throw new TypeError("Output field names must be unique and separate from base fields.");
  }
  const fieldByName = new Map(options.fields.map((field) => [field.name, field]));
  const records = options.records.map((record, index) => {
    const field = fieldByName.get(record.field);
    const value = normalizeJsonValue(record.value);
    if (
      field === undefined ||
      value === undefined ||
      (field.kind === "text" && typeof value !== "string") ||
      !isNonNegativeInteger(record.lines ?? 0) ||
      !isNonNegativeInteger(record.items ?? 0) ||
      (record.truncatedBy !== undefined &&
        record.truncatedBy !== "line-length")
    ) {
      throw new TypeError(`Invalid output record at index ${index}.`);
    }
    return {
      field: record.field,
      value,
      lines: record.lines ?? 0,
      items: record.items ?? 0,
      truncatedBy: record.truncatedBy,
      index,
    };
  });

  const project = (selected: readonly typeof records[number][]): JsonObject => {
    const grouped = new Map<string, typeof records>();
    for (const record of selected) {
      const values = grouped.get(record.field) ?? [];
      values.push(record);
      grouped.set(record.field, values);
    }
    const output: Record<string, JsonValue> = { ...normalizedResult };
    for (const field of options.fields) {
      const values = grouped.get(field.name)?.map((record) => record.value) ?? [];
      output[field.name] =
        field.kind === "text"
          ? (values as string[]).join(field.separator ?? "")
          : values;
    }
    return output;
  };
  if (jsonByteLength(project([])) > TOOL_RESULT_FIXED_PAYLOAD_MAX_BYTES) {
    throw new TypeError("Tool result fixed fields exceed their size limit.");
  }
  const outputOnly = (selected: readonly typeof records[number][]): JsonObject => {
    const projected = project(selected);
    return Object.fromEntries(
      fieldNames.map((name) => [name, projected[name] as JsonValue]),
    );
  };
  const outputBytes = (selected: readonly typeof records[number][]): number =>
    fieldNames.reduce(
      (total, name) => total + jsonByteLength(outputOnly(selected)[name] as JsonValue),
      0,
    );
  const projectedValues = new Map<string, JsonValue>(
    options.fields.map((field) => [field.name, field.kind === "text" ? "" : []]),
  );
  const projectedCounts = new Map<string, number>(
    options.fields.map((field) => [field.name, 0]),
  );
  let retainedBytes = [...projectedValues.values()].reduce<number>(
    (total, value) => total + jsonByteLength(value),
    0,
  );
  const projectedRecord = (
    record: (typeof records)[number],
  ): { readonly value: JsonValue; readonly bytes: number } => {
    const field = fieldByName.get(record.field)!;
    const current = projectedValues.get(record.field)!;
    const hasExistingRecord = projectedCounts.get(record.field)! > 0;
    const separator =
      field.kind === "text" && hasExistingRecord ? (field.separator ?? "") : "";
    const value =
      field.kind === "text"
        ? options.strategy === "head"
          ? `${current as string}${separator}${record.value as string}`
          : `${record.value as string}${separator}${current as string}`
        : options.strategy === "head"
          ? [...(current as readonly JsonValue[]), record.value]
          : [record.value, ...(current as readonly JsonValue[])];
    return {
      value,
      bytes:
        retainedBytes - jsonByteLength(current) + jsonByteLength(value),
    };
  };
  const retainRecord = (
    record: (typeof records)[number],
    projection: { readonly value: JsonValue; readonly bytes: number },
  ) => {
    retained.push(record);
    projectedValues.set(record.field, projection.value);
    projectedCounts.set(record.field, projectedCounts.get(record.field)! + 1);
    retainedBytes = projection.bytes;
  };

  const byteLimit = Math.min(
    nonNegativeLimit(
      options.limits?.bytes,
      TOOL_RESULT_OUTPUT_BUDGET_BYTES,
    ),
    TOOL_RESULT_OUTPUT_BUDGET_BYTES,
  );
  const lineLimit = nonNegativeLimit(
    options.limits?.lines,
    Number.MAX_SAFE_INTEGER,
  );
  const itemLimit = nonNegativeLimit(
    options.limits?.items,
    Number.MAX_SAFE_INTEGER,
  );
  const traversal =
    options.strategy === "head" ? [...records] : [...records].reverse();
  const countSelected: typeof records = [];
  const omitted = new Map<number, Set<ToolTruncationReason>>();
  let lines = 0;
  let items = 0;
  let countStopped = false;
  for (const record of traversal) {
    const reasons = new Set<ToolTruncationReason>();
    if (countStopped || lines + record.lines > lineLimit) {
      if (record.lines > 0) reasons.add("lines");
    }
    if (countStopped || items + record.items > itemLimit) {
      if (record.items > 0) reasons.add("items");
    }
    if (reasons.size > 0 || countStopped) {
      countStopped = true;
      omitted.set(record.index, reasons);
      continue;
    }
    countSelected.push(record);
    lines += record.lines;
    items += record.items;
  }

  const retained: typeof records = [];
  let byteStopped = false;
  for (const record of countSelected) {
    if (byteStopped) {
      omitted.set(record.index, new Set(["bytes"]));
      continue;
    }
    const projection = projectedRecord(record);
    if (projection.bytes <= byteLimit) {
      retainRecord(record, projection);
      continue;
    }
    const field = fieldByName.get(record.field)!;
    if (
      field.kind === "text" &&
      field.truncateOversizedRecords &&
      outputBytes([record]) > byteLimit
    ) {
      const codePoints = Array.from(record.value as string);
      let low = 0;
      let high = codePoints.length;
      let clipped: typeof record | undefined;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const value =
          options.strategy === "head"
            ? codePoints.slice(0, middle).join("")
            : codePoints.slice(codePoints.length - middle).join("");
        const attempt = { ...record, value };
        const attemptProjection = projectedRecord(attempt);
        if (attemptProjection.bytes <= byteLimit) {
          clipped = attempt;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (clipped !== undefined && (clipped.value as string).length > 0) {
        retainRecord(clipped, projectedRecord(clipped));
      }
      omitted.set(record.index, new Set(["bytes", "line-length"]));
    } else {
      omitted.set(record.index, new Set(["bytes"]));
    }
    byteStopped = true;
  }

  retained.sort((a, b) => a.index - b.index);
  const clippedRecords = retained.filter(
    (record) => record.truncatedBy === "line-length",
  );
  if (omitted.size === 0 && clippedRecords.length === 0) {
    const candidate = {
      ok: true,
      result: project(retained) as T & JsonObject,
    } as const;
    const normalized = normalizeToolResult(candidate);
    if (
      !isDeepStrictEqual(candidate, normalized) ||
      fixedEnvelopeBytes(candidate, options.fields) >
        TOOL_RESULT_FIXED_BUDGET_BYTES
    ) {
      throw new TypeError("Canonical Tool Result exceeds its fixed size limit.");
    }
    return candidate;
  }

  const reasonSet = new Set<ToolTruncationReason>();
  const affectedFields = new Set<string>();
  for (const [index, reasons] of omitted) {
    for (const reason of reasons) reasonSet.add(reason);
    affectedFields.add(records[index]!.field);
  }
  for (const record of clippedRecords) {
    reasonSet.add("line-length");
    affectedFields.add(record.field);
  }
  const reasons = TRUNCATION_REASON_ORDER.filter((reason) => reasonSet.has(reason));
  const retainedLines = retained.reduce((total, record) => total + record.lines, 0);
  const retainedItems = retained.reduce((total, record) => total + record.items, 0);
  const includeTotal = new Set(options.includeTotal ?? []);
  const total = {
    ...(includeTotal.has("bytes") ? { bytes: outputBytes(records) } : {}),
    ...(includeTotal.has("lines")
      ? { lines: records.reduce((sum, record) => sum + record.lines, 0) }
      : {}),
    ...(includeTotal.has("items")
      ? { items: records.reduce((sum, record) => sum + record.items, 0) }
      : {}),
  };
  const firstOmittedRecordIndex = [...omitted.keys()].sort((a, b) => a - b)[0];
  const nextArguments =
    firstOmittedRecordIndex === undefined || reasonSet.has("line-length")
      ? undefined
      : options.continuation?.({
          firstOmittedRecordIndex,
          retainedRecordIndices: retained.map((record) => record.index),
        });
  const normalizedNextArguments =
    nextArguments === undefined ? undefined : normalizeJsonObject(nextArguments);
  if (nextArguments !== undefined && normalizedNextArguments === undefined) {
    throw new TypeError("Continuation arguments must be a JSON-safe object.");
  }
  if (
    normalizedNextArguments !== undefined &&
    jsonByteLength(normalizedNextArguments) > TOOL_RESULT_FIXED_PAYLOAD_MAX_BYTES
  ) {
    throw new TypeError("Continuation arguments exceed their size limit.");
  }
  const hasLines = records.some((record) => record.lines > 0);
  const hasItems = records.some((record) => record.items > 0);

  const candidate = {
    ok: true,
    result: project(retained) as T & JsonObject,
    meta: {
      truncation: {
        reasons,
        strategy: options.strategy,
        fields: fieldNames.filter((field) => affectedFields.has(field)),
        retained: {
          bytes: retainedBytes,
          ...(hasLines ? { lines: retainedLines } : {}),
          ...(hasItems ? { items: retainedItems } : {}),
        },
        ...(Object.keys(total).length === 0 ? {} : { total }),
        ...(normalizedNextArguments === undefined
          ? {}
          : { nextArguments: normalizedNextArguments }),
      },
    },
  } as const;
  const normalized = normalizeToolResult(candidate);
  if (
    !isDeepStrictEqual(candidate, normalized) ||
    fixedEnvelopeBytes(candidate, options.fields) >
      TOOL_RESULT_FIXED_BUDGET_BYTES
  ) {
    throw new TypeError("Canonical Tool Result exceeds its fixed size limit.");
  }
  return candidate;
}

export function boundToolFailure<Code extends string>(
  options: BoundToolFailureOptions<Code>,
): ToolResult {
  const bounded = boundToolResult({
    result: options.error.details ?? {},
    fields: options.fields,
    records: options.records,
    strategy: options.strategy,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.includeTotal === undefined
      ? {}
      : { includeTotal: options.includeTotal }),
    ...(options.continuation === undefined
      ? {}
      : { continuation: options.continuation }),
  });
  if (!bounded.ok) {
    return bounded;
  }
  const candidate = {
    ok: false,
    error: {
      code: options.error.code,
      message: options.error.message,
      details: bounded.result,
    },
    ...(bounded.meta === undefined ? {} : { meta: bounded.meta }),
  } as const;
  const normalized = normalizeToolResult(candidate);
  if (
    !isDeepStrictEqual(candidate, normalized) ||
    fixedEnvelopeBytes(candidate, options.fields) >
      TOOL_RESULT_FIXED_BUDGET_BYTES
  ) {
    throw new TypeError("Canonical Tool Result failure is unsafe or unbounded.");
  }
  return candidate;
}
