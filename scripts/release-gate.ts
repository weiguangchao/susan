export interface ReleaseGateFacts {
  requestedVersion: string;
  packageVersion: string;
  requestedCommit: string;
  mainCommit: string;
  workingTreeClean: boolean;
  ciJobs: Array<{ name: string; conclusion: string }>;
  smokeRecord: string;
  smokeAuthorAssociation: string;
  packageIntegrity: string;
  publishedIntegrity: string | undefined;
  tagCommit: string | undefined;
  releaseExists: boolean;
}

export interface ReleaseRecoveryPlan {
  publish: boolean;
  createTag: boolean;
  createRelease: boolean;
}

export const RELEASE_SMOKE_PLATFORMS = ["macOS", "Linux", "Windows"] as const;

export const RELEASE_SMOKE_CHECKS = [
  "Startup",
  "Input",
  "Cancel",
  "Resume",
  "Tool-Cards",
  "Outside-Cwd",
  "Failure",
  "Truncation",
  "Session",
  "Exit",
] as const;

export const REQUIRED_RELEASE_GATE_JOBS = [
  "Typecheck and unit tests (Ubuntu, Node 22)",
  "Integration (ubuntu-latest, Node 22)",
  "Integration (macos-latest, Node 22)",
  "Integration (windows-latest, Node 22)",
  "Integration (ubuntu-latest, Node 24)",
  "Package smoke (ubuntu-latest, Node 22)",
  "Package smoke (macos-latest, Node 22)",
  "Package smoke (windows-latest, Node 22)",
] as const;

export function evaluateReleaseGate(
  facts: ReleaseGateFacts,
): ReleaseRecoveryPlan {
  if (facts.requestedVersion !== facts.packageVersion) {
    throw new Error(
      `release version ${facts.requestedVersion} does not match package.json ${facts.packageVersion}`,
    );
  }

  if (facts.requestedCommit !== facts.mainCommit) {
    throw new Error(
      `release commit ${facts.requestedCommit} is not main ${facts.mainCommit}`,
    );
  }

  if (!facts.workingTreeClean) {
    throw new Error("release checkout is not clean");
  }

  for (const requiredJob of REQUIRED_RELEASE_GATE_JOBS) {
    const job = facts.ciJobs.find(({ name }) => name === requiredJob);
    if (job?.conclusion !== "success") {
      throw new Error(`Release Gate CI job did not succeed: ${requiredJob}`);
    }
  }

  const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
  if (!trustedAssociations.has(facts.smokeAuthorAssociation)) {
    throw new Error(
      `manual smoke record author is not trusted: ${facts.smokeAuthorAssociation}`,
    );
  }

  const smokeLines = facts.smokeRecord.split(/\r?\n/u);
  const smokeLineSet = new Set(smokeLines);
  const requiredSmokeLines = [
    "<!-- susan-release-smoke:v1 -->",
    `Package-Version: ${facts.requestedVersion}`,
    `Commit: ${facts.requestedCommit}`,
    "Checklist: PASS",
  ];
  for (const requiredLine of requiredSmokeLines) {
    if (!smokeLineSet.has(requiredLine)) {
      throw new Error(`manual smoke record is missing: ${requiredLine}`);
    }
  }

  const smokeFields = new Map<string, string>();
  for (const line of smokeLines) {
    const separator = line.indexOf(":");
    if (separator < 1) {
      continue;
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (smokeFields.has(key)) {
      throw new Error(`manual smoke record repeats field: ${key}`);
    }
    smokeFields.set(key, value);
  }
  for (const platform of RELEASE_SMOKE_PLATFORMS) {
    for (const field of ["Terminal", "Executor"] as const) {
      const key = `${platform}-${field}`;
      if (smokeFields.get(key) === undefined || smokeFields.get(key) === "") {
        throw new Error(`manual smoke record is missing field: ${key}`);
      }
    }
    const node = smokeFields.get(`${platform}-Node`);
    if (node === undefined || !/^(?:22|24)(?:\.[0-9]+){0,2}$/u.test(node)) {
      throw new Error(`manual smoke record has invalid Node version: ${platform}`);
    }
    const date = smokeFields.get(`${platform}-Date`);
    if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
      throw new Error(`manual smoke record has invalid date: ${platform}`);
    }
    const passFields = [
      `${platform}-Package-Smoke`,
      ...RELEASE_SMOKE_CHECKS.map((check) => `${platform}-${check}`),
    ];
    for (const field of passFields) {
      if (smokeFields.get(field) !== "PASS") {
        throw new Error(`manual smoke record did not pass: ${field}`);
      }
    }
  }

  if (
    facts.publishedIntegrity !== undefined &&
    facts.publishedIntegrity !== facts.packageIntegrity
  ) {
    throw new Error(
      `npm ${facts.requestedVersion} already exists with different package contents`,
    );
  }
  if (
    facts.tagCommit !== undefined &&
    facts.tagCommit !== facts.requestedCommit
  ) {
    throw new Error(
      `v${facts.requestedVersion} points at ${facts.tagCommit}, not ${facts.requestedCommit}`,
    );
  }

  return {
    publish: facts.publishedIntegrity === undefined,
    createTag: facts.tagCommit === undefined,
    createRelease: !facts.releaseExists,
  };
}
