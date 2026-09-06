import type { ReleaseRecoveryPlan } from "./release-gate.js";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function requireCommandOutput(
  result: CommandResult,
  description: string,
): string {
  if (result.status !== 0) {
    throw new Error(
      `${description} failed (${String(result.status)}): ${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

export function issueCommentId(repository: string, url: string): string {
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `^https://github\\.com/${escapedRepository}/issues/[1-9][0-9]*#issuecomment-([1-9][0-9]*)$`,
    "u",
  ).exec(url);
  if (match?.[1] === undefined) {
    throw new Error(
      "manual smoke record must be an issue comment URL in this repository",
    );
  }
  return match[1];
}

export function npmPublishedIntegrity(
  result: CommandResult,
  parseJson: (text: string) => unknown = JSON.parse,
): string | undefined {
  if (result.status === 0) {
    const integrity = parseJson(result.stdout);
    if (typeof integrity !== "string" || integrity === "") {
      throw new Error("npm view returned no dist.integrity");
    }
    return integrity;
  }
  if (`${result.stdout}${result.stderr}`.includes("E404")) {
    return undefined;
  }
  throw new Error(
    `npm registry lookup failed (${String(result.status)}): ${result.stdout}${result.stderr}`,
  );
}

export function releaseOutputs(
  plan: ReleaseRecoveryPlan,
  tag: string,
  tarball: string,
): string {
  return [
    `publish=${String(plan.publish)}`,
    `create_tag=${String(plan.createTag)}`,
    `create_release=${String(plan.createRelease)}`,
    `tag=${tag}`,
    `tarball=${tarball}`,
    "",
  ].join("\n");
}
