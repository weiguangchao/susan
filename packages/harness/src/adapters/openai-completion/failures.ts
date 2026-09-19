import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  APIError,
} from "openai";
import { isRecord } from "@weiguangchao/susan-core";
import type { ProviderFailure } from "../../core/provider";
import { ProviderProtocolError } from "./protocol";

export function failureFromError(
  error: unknown,
  hadSemanticOutput: boolean,
): ProviderFailure {
  const base = {
    hadSemanticOutput,
    cause: error,
  };

  if (error instanceof APIConnectionTimeoutError) {
    return {
      ...base,
      code: "PROVIDER_TIMEOUT",
      message: "Provider request timed out.",
    };
  }

  if (error instanceof APIUserAbortError) {
    return {
      ...base,
      code: "PROVIDER_ABORT",
      message: "Provider request was aborted.",
    };
  }

  if (error instanceof APIConnectionError) {
    return {
      ...base,
      code: "PROVIDER_NETWORK",
      message: "Provider network request failed.",
    };
  }

  if (error instanceof APIError) {
    const httpStatus =
      typeof error.status === "number" && Number.isSafeInteger(error.status)
        ? error.status
        : undefined;
    const requestId =
      optionalErrorRequestId(error) ??
      headerValue(error.headers, "x-request-id");
    const retryAfterMs = parseRetryAfter(
      headerValue(error.headers, "retry-after"),
    );

    if (httpStatus === undefined) {
      return {
        ...base,
        code: "PROVIDER_NETWORK",
        message: "Provider request failed before an HTTP response.",
        requestId,
        retryAfterMs,
      };
    }

    return {
      ...base,
      code: "PROVIDER_HTTP",
      message: `Provider returned HTTP ${httpStatus}.`,
      httpStatus,
      requestId,
      retryAfterMs,
      ...(isContextOverflowError(error) ? { contextOverflow: true } : {}),
    };
  }

  if (error instanceof ProviderProtocolError) {
    return {
      ...base,
      code: "PROVIDER_PROTOCOL",
      message: error.message,
    };
  }

  if (error instanceof Error && error.name === "AbortError") {
    return {
      ...base,
      code: "PROVIDER_ABORT",
      message: "Provider request was aborted.",
    };
  }

  return {
    ...base,
    code: "PROVIDER_NETWORK",
    message: "Provider network request failed.",
  };
}

function headerValue(
  headers: unknown,
  name: string,
): string | undefined {
  if (!isRecord(headers) && !(headers instanceof Headers)) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const seconds = Number(value);
  if (/^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(seconds)) {
    return Math.round(seconds * 1_000);
  }

  const retryAt = Date.parse(value);
  if (Number.isFinite(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }

  return undefined;
}

function isContextOverflowError(error: APIError): boolean {
  const candidate = error as unknown;
  const values: unknown[] = [];
  if (isRecord(candidate)) {
    values.push(candidate.code, candidate.message);
    if (isRecord(candidate.error)) {
      values.push(candidate.error.code, candidate.error.message);
    }
  }
  return values.some(
    (value) =>
      typeof value === "string" &&
      /context(?:_| )?(?:length|window)|maximum context|too many tokens/i.test(
        value,
      ),
  );
}

function optionalErrorRequestId(error: APIError): string | undefined {
  if (
    typeof error.requestID === "string" &&
    error.requestID.length > 0
  ) {
    return error.requestID;
  }

  return undefined;
}
