import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateReleaseGate } from "./release-gate";
import {
  issueCommentId,
  npmPublishedIntegrity,
  releaseOutputs,
  requireCommandOutput,
  type CommandResult,
} from "./release-preflight-support";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing environment variable: ${name}`);
  }
  return value;
}

function run(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error !== undefined) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function requireSuccess(
  command: string,
  args: string[],
  description: string,
): string {
  return requireCommandOutput(run(command, args), description);
}

function parseJson<T>(text: string, description: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${description} did not return valid JSON`);
  }
}

function publishedIntegrity(
  packageName: string,
  version: string,
): string | undefined {
  const result = run("npm", [
    "view",
    `${packageName}@${version}`,
    "dist.integrity",
    "--json",
  ]);
  return npmPublishedIntegrity(result, (text) =>
    parseJson<unknown>(text, "npm view"),
  );
}

async function main(): Promise<void> {
  const requestedVersion = requiredEnvironment("RELEASE_VERSION");
  const requestedCommit = requiredEnvironment("RELEASE_COMMIT").toLowerCase();
  const smokeRecordUrl = requiredEnvironment("SMOKE_RECORD_URL");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const githubOutput = requiredEnvironment("GITHUB_OUTPUT");

  if (!/^[0-9a-f]{40}$/u.test(requestedCommit)) {
    throw new Error("release commit must be a full 40-character Git SHA");
  }

  const manifest = parseJson<{ name?: unknown; version?: unknown }>(
    await readFile("package.json", "utf8"),
    "package.json",
  );
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error("package.json must contain string name and version fields");
  }

  const headCommit = requireSuccess("git", ["rev-parse", "HEAD"], "read HEAD");
  if (headCommit !== requestedCommit) {
    throw new Error(`checked out HEAD ${headCommit} is not ${requestedCommit}`);
  }
  const workingTreeClean =
    requireSuccess("git", ["status", "--porcelain"], "inspect checkout") === "";

  const mainCommit = requireSuccess(
    "gh",
    ["api", `repos/${repository}/git/ref/heads/main`, "--jq", ".object.sha"],
    "read main ref",
  ).toLowerCase();

  const runs = parseJson<
    Array<{
      conclusion: string;
      databaseId: number;
      event: string;
      headSha: string;
      status: string;
    }>
  >(
    requireSuccess(
      "gh",
      [
        "run",
        "list",
        "--workflow",
        "ci.yml",
        "--branch",
        "main",
        "--commit",
        requestedCommit,
        "--event",
        "push",
        "--status",
        "completed",
        "--limit",
        "20",
        "--json",
        "databaseId,conclusion,event,headSha,status",
      ],
      "list CI runs",
    ),
    "gh run list",
  );
  const passingRun = runs.find(
    (run) =>
      run.conclusion === "success" &&
      run.status === "completed" &&
      run.event === "push" &&
      run.headSha.toLowerCase() === requestedCommit,
  );
  if (passingRun === undefined) {
    throw new Error(`no successful main CI push run found for ${requestedCommit}`);
  }
  const jobsResponse = parseJson<{
    jobs: Array<{ name: string; conclusion: string }>;
  }>(
    requireSuccess(
      "gh",
      ["run", "view", String(passingRun.databaseId), "--json", "jobs"],
      "read CI jobs",
    ),
    "gh run view",
  );

  const commentId = issueCommentId(repository, smokeRecordUrl);
  const smokeComment = parseJson<{
    author_association: string;
    body: string;
    html_url: string;
  }>(
    requireSuccess(
      "gh",
      ["api", `repos/${repository}/issues/comments/${commentId}`],
      "read manual smoke record",
    ),
    "manual smoke comment",
  );
  if (smokeComment.html_url !== smokeRecordUrl) {
    throw new Error("manual smoke record URL did not match the fetched comment");
  }

  const packDirectory = await mkdtemp(join(tmpdir(), "susan-release-"));
  const packReport = parseJson<
    Array<{
      filename: string;
      integrity: string;
      files: Array<{ path: string }>;
    }>
  >(
    requireSuccess(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packDirectory,
      ],
      "npm pack",
    ),
    "npm pack",
  );
  if (packReport.length !== 1 || packReport[0] === undefined) {
    throw new Error("npm pack must produce exactly one tarball");
  }
  const report = packReport[0];
  const files = report.files
    .map(({ path }) => path)
    .sort((left, right) => left.localeCompare(right, "en"));
  const expectedFiles = ["dist/cli.js", "package.json"];
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      `unexpected npm pack files: ${JSON.stringify(files)}; expected ${JSON.stringify(expectedFiles)}`,
    );
  }

  requireSuccess("git", ["fetch", "--force", "--tags", "origin"], "fetch tags");
  const tag = `v${requestedVersion}`;
  const tagResult = run("git", [
    "rev-parse",
    "--verify",
    `refs/tags/${tag}^{commit}`,
  ]);
  const tagCommit = tagResult.status === 0 ? tagResult.stdout.trim() : undefined;
  const releaseResult = run("gh", ["release", "view", tag, "--json", "tagName"]);
  if (
    releaseResult.status !== 0 &&
    !releaseResult.stderr.includes("release not found")
  ) {
    throw new Error(
      `GitHub Release lookup failed (${String(releaseResult.status)}): ${releaseResult.stdout}${releaseResult.stderr}`,
    );
  }

  const plan = evaluateReleaseGate({
    requestedVersion,
    packageVersion: manifest.version,
    requestedCommit,
    mainCommit,
    workingTreeClean,
    ciJobs: jobsResponse.jobs,
    smokeRecord: smokeComment.body,
    smokeAuthorAssociation: smokeComment.author_association,
    packageIntegrity: report.integrity,
    publishedIntegrity: publishedIntegrity(manifest.name, requestedVersion),
    tagCommit,
    releaseExists: releaseResult.status === 0,
  });

  const tarball = join(packDirectory, report.filename);
  await appendFile(githubOutput, releaseOutputs(plan, tag, tarball));
  process.stdout.write(
    `${JSON.stringify({ version: requestedVersion, commit: requestedCommit, files, ...plan }, null, 2)}\n`,
  );
}

await main();
