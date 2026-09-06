export interface ReleaseFacts {
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

export interface ReleasePlan {
  publish: boolean;
  createTag: boolean;
  createRelease: boolean;
}

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

export function evaluateReleasePolicy(facts: ReleaseFacts): ReleasePlan {
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

  const smokeLines = new Set(facts.smokeRecord.split(/\r?\n/u));
  const requiredSmokeLines = [
    "<!-- susan-release-smoke:v1 -->",
    `Package-Version: ${facts.requestedVersion}`,
    `Commit: ${facts.requestedCommit}`,
    "macOS: PASS",
    "Linux: PASS",
    "Windows: PASS",
    "Checklist: PASS",
  ];
  for (const requiredLine of requiredSmokeLines) {
    if (!smokeLines.has(requiredLine)) {
      throw new Error(`manual smoke record is missing: ${requiredLine}`);
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
