import { describe, expect, it } from "vitest";

import {
  evaluateReleaseGate,
  RELEASE_SMOKE_CHECKS,
  RELEASE_SMOKE_PLATFORMS,
  REQUIRED_RELEASE_GATE_JOBS,
  type ReleaseGateFacts,
} from "../scripts/release-gate";

const COMMIT = "a".repeat(40);

function smokeRecord(): string {
  const lines = [
    "<!-- susan-release-smoke:v1 -->",
    "Package-Version: 0.0.1",
    `Commit: ${COMMIT}`,
    "Checklist: PASS",
  ];
  for (const platform of RELEASE_SMOKE_PLATFORMS) {
    lines.push(
      `${platform}-Terminal: test terminal`,
      `${platform}-Node: 24.1.0`,
      `${platform}-Executor: @tester`,
      `${platform}-Date: 2026-09-06`,
      `${platform}-Package-Smoke: PASS`,
      ...RELEASE_SMOKE_CHECKS.map((check) => `${platform}-${check}: PASS`),
    );
  }
  return lines.join("\n");
}

function releaseGateFacts(
  overrides: Partial<ReleaseGateFacts> = {},
): ReleaseGateFacts {
  return {
    requestedVersion: "0.0.1",
    packageVersion: "0.0.1",
    requestedCommit: COMMIT,
    mainCommit: COMMIT,
    workingTreeClean: true,
    ciJobs: REQUIRED_RELEASE_GATE_JOBS.map((name) => ({
      name,
      conclusion: "success",
    })),
    smokeRecord: smokeRecord(),
    smokeAuthorAssociation: "OWNER",
    packageIntegrity: "sha512-local",
    publishedIntegrity: undefined,
    tagCommit: undefined,
    releaseExists: false,
    ...overrides,
  };
}

describe("Release Gate policy", () => {
  it("requires the input version to equal the Package Version", () => {
    expect(() =>
      evaluateReleaseGate(releaseGateFacts({ requestedVersion: "0.0.2" })),
    ).toThrow("release version 0.0.2 does not match package.json 0.0.1");
  });

  it("requires the input commit to equal the current main commit", () => {
    const requestedCommit = "b".repeat(40);
    expect(() =>
      evaluateReleaseGate(releaseGateFacts({ requestedCommit })),
    ).toThrow(`release commit ${requestedCommit} is not main ${COMMIT}`);
  });

  it("rejects a dirty checkout", () => {
    expect(() =>
      evaluateReleaseGate(releaseGateFacts({ workingTreeClean: false })),
    ).toThrow("release checkout is not clean");
  });

  it("requires every release-blocking CI job to succeed", () => {
    expect(() =>
      evaluateReleaseGate(
        releaseGateFacts({
          ciJobs: [
            {
              name: "Typecheck and unit tests (Ubuntu, Node 22)",
              conclusion: "success",
            },
          ],
        }),
      ),
    ).toThrow(
      "Release Gate CI job did not succeed: Integration (ubuntu-latest, Node 22)",
    );
  });

  it("requires every checklist item on every smoke platform", () => {
    expect(() =>
      evaluateReleaseGate(
        releaseGateFacts({
          smokeRecord: smokeRecord().replace("Windows-Truncation: PASS", ""),
        }),
      ),
    ).toThrow("manual smoke record did not pass: Windows-Truncation");
  });

  it("requires traceable details for every smoke platform", () => {
    expect(() =>
      evaluateReleaseGate(
        releaseGateFacts({
          smokeRecord: smokeRecord().replace("Linux-Executor: @tester", ""),
        }),
      ),
    ).toThrow("manual smoke record is missing field: Linux-Executor");
  });

  it("repairs metadata without republishing an immutable version", () => {
    expect(
      evaluateReleaseGate(
        releaseGateFacts({ publishedIntegrity: "sha512-local" }),
      ),
    ).toEqual({
      publish: false,
      createTag: true,
      createRelease: true,
    });
  });

  it("rejects an existing npm version with different package contents", () => {
    expect(() =>
      evaluateReleaseGate(
        releaseGateFacts({ publishedIntegrity: "sha512-other" }),
      ),
    ).toThrow("npm 0.0.1 already exists with different package contents");
  });

  it("rejects a version tag that points at another commit", () => {
    const tagCommit = "b".repeat(40);
    expect(() =>
      evaluateReleaseGate(releaseGateFacts({ tagCommit })),
    ).toThrow(`v0.0.1 points at ${tagCommit}, not ${COMMIT}`);
  });
});
