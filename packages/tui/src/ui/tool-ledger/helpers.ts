import { isRecord } from "@weiguangchao/susan-core";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function stringField(value: unknown, field: string): string | undefined {
  const fieldValue = asRecord(value)?.[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

export function numericField(value: unknown, field: string): number | undefined {
  const fieldValue = asRecord(value)?.[field];
  return typeof fieldValue === "number" ? fieldValue : undefined;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function noticeSuffix(content: string): string {
  const noticeAt = content.indexOf("\n\n[");
  return noticeAt === -1 ? "" : content.slice(noticeAt + 2);
}

export function stripToolNotices(content: string): string {
  const noticeAt = content.indexOf("\n\n[");
  return noticeAt === -1 ? content : content.slice(0, noticeAt);
}
