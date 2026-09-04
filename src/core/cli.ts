import { parseApprovalFlags, type ApprovalPolicy } from "./config.js";

export type ResumeMode =
  | { readonly kind: "none" }
  | { readonly kind: "picker" }
  | { readonly kind: "last" }
  | { readonly kind: "id"; readonly id: string };

export type CliFlags = {
  readonly approval?: ApprovalPolicy;
  readonly resume: ResumeMode;
};

export type CliError = {
  readonly code: "SUSAN_CLI_USAGE";
  readonly message: string;
};

export type CliParseResult =
  | { readonly ok: true; readonly flags: CliFlags }
  | { readonly ok: false; readonly error: CliError };

export const CLI_USAGE = `Usage:
  susan [--approval ask|yolo | --yolo] [--resume | --resume <id> | --resume --last]`;

function usageError(message: string): CliParseResult {
  return {
    ok: false,
    error: {
      code: "SUSAN_CLI_USAGE",
      message,
    },
  };
}

function isFlag(value: string | undefined): boolean {
  return value !== undefined && value.startsWith("-");
}

export function formatCliError(error: CliError): string {
  return `susan: ${error.message}\n\n${CLI_USAGE}\n`;
}

export function parseCli(args: readonly string[]): CliParseResult {
  const approvalArgs: string[] = [];
  let resumeSeen = false;
  let resumeId: string | undefined;
  let resumeLast = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--yolo") {
      approvalArgs.push(arg);
      continue;
    }
    if (arg === "--approval") {
      approvalArgs.push(arg);
      const value = args[index + 1];
      if (value !== undefined) {
        approvalArgs.push(value);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--approval=")) {
      approvalArgs.push(arg);
      continue;
    }
    if (arg === "--resume") {
      resumeSeen = true;
      const value = args[index + 1];
      if (value !== undefined && !isFlag(value)) {
        resumeId = value;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--resume=")) {
      resumeSeen = true;
      resumeId = arg.slice("--resume=".length);
      continue;
    }
    if (arg === "--last") {
      resumeLast = true;
      continue;
    }

    return usageError(`Unknown argument: ${arg}`);
  }

  const approvalResult = parseApprovalFlags(approvalArgs);
  if (!approvalResult.ok) {
    return usageError(approvalResult.issue.message);
  }

  if (resumeLast && !resumeSeen) {
    return usageError("--last requires --resume");
  }
  if (resumeLast && resumeId !== undefined) {
    return usageError("--resume <id> and --last cannot be used together");
  }
  if (resumeId === "") {
    return usageError("--resume requires a Session id");
  }

  const resume: ResumeMode = resumeLast
    ? { kind: "last" }
    : resumeId !== undefined
      ? { kind: "id", id: resumeId }
      : resumeSeen
        ? { kind: "picker" }
        : { kind: "none" };

  return {
    ok: true,
    flags: {
      ...(approvalResult.approval === undefined
        ? {}
        : { approval: approvalResult.approval }),
      resume,
    },
  };
}
