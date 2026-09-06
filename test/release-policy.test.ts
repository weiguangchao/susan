import { describe, expect, it } from "vitest";

import {
  evaluateReleasePolicy,
  REQUIRED_RELEASE_GATE_JOBS,
} from "../scripts/release-policy.js";

describe("Release Gate policy", () => {
  it("accepts only the package version at the current main commit", () => {
    const facts = {
      requestedVersion: "0.0.2",
      packageVersion: "0.0.1",
      requestedCommit: "b".repeat(40),
      mainCommit: "a".repeat(40),
      workingTreeClean: true,
      ciJobs: [],
      smokeRecord: "",
      smokeAuthorAssociation: "OWNER",
      packageIntegrity: "sha512-local",
      publishedIntegrity: undefined,
      tagCommit: undefined,
      releaseExists: false,
    };

    expect(() => evaluateReleasePolicy(facts)).toThrow(
      "release version 0.0.2 does not match package.json 0.0.1",
    );

    expect(() =>
      evaluateReleasePolicy({
        ...facts,
        requestedVersion: "0.0.1",
      }),
    ).toThrow(`release commit ${"b".repeat(40)} is not main ${"a".repeat(40)}`);
  });

  it("rejects a dirty checkout", () => {
    expect(() =>
      evaluateReleasePolicy({
        requestedVersion: "0.0.1",
        packageVersion: "0.0.1",
        requestedCommit: "a".repeat(40),
        mainCommit: "a".repeat(40),
        workingTreeClean: false,
        ciJobs: [],
        smokeRecord: "",
        smokeAuthorAssociation: "OWNER",
        packageIntegrity: "sha512-local",
        publishedIntegrity: undefined,
        tagCommit: undefined,
        releaseExists: false,
      }),
    ).toThrow("release checkout is not clean");
  });

  it("requires every release-blocking CI job to succeed", () => {
    expect(() =>
      evaluateReleasePolicy({
        requestedVersion: "0.0.1",
        packageVersion: "0.0.1",
        requestedCommit: "a".repeat(40),
        mainCommit: "a".repeat(40),
        workingTreeClean: true,
        ciJobs: [
          {
            name: "Typecheck and unit tests (Ubuntu, Node 22)",
            conclusion: "success",
          },
        ],
        smokeRecord: "",
        smokeAuthorAssociation: "OWNER",
        packageIntegrity: "sha512-local",
        publishedIntegrity: undefined,
        tagCommit: undefined,
        releaseExists: false,
      }),
    ).toThrow(
      "Release Gate CI job did not succeed: Integration (ubuntu-latest, Node 22)",
    );
  });

  it("requires a trusted manual smoke record for the version and commit", () => {
    expect(() =>
      evaluateReleasePolicy({
        requestedVersion: "0.0.1",
        packageVersion: "0.0.1",
        requestedCommit: "a".repeat(40),
        mainCommit: "a".repeat(40),
        workingTreeClean: true,
        ciJobs: REQUIRED_RELEASE_GATE_JOBS.map((name) => ({
          name,
          conclusion: "success",
        })),
        smokeRecord: [
          "<!-- susan-release-smoke:v1 -->",
          "Package-Version: 0.0.1",
          `Commit: ${"a".repeat(40)}`,
          "macOS: PASS",
          "Linux: PASS",
          "Windows: PASS",
        ].join("\n"),
        smokeAuthorAssociation: "OWNER",
        packageIntegrity: "sha512-local",
        publishedIntegrity: undefined,
        tagCommit: undefined,
        releaseExists: false,
      }),
    ).toThrow("manual smoke record is missing: Checklist: PASS");
  });

  it("repairs missing tag and release without republishing an immutable version", () => {
    const commit = "a".repeat(40);
    expect(
      evaluateReleasePolicy({
        requestedVersion: "0.0.1",
        packageVersion: "0.0.1",
        requestedCommit: commit,
        mainCommit: commit,
        workingTreeClean: true,
        ciJobs: REQUIRED_RELEASE_GATE_JOBS.map((name) => ({
          name,
          conclusion: "success",
        })),
        smokeRecord: [
          "<!-- susan-release-smoke:v1 -->",
          "Package-Version: 0.0.1",
          `Commit: ${commit}`,
          "macOS: PASS",
          "Linux: PASS",
          "Windows: PASS",
          "Checklist: PASS",
        ].join("\n"),
        smokeAuthorAssociation: "OWNER",
        packageIntegrity: "sha512-same",
        publishedIntegrity: "sha512-same",
        tagCommit: undefined,
        releaseExists: false,
      }),
    ).toEqual({
      publish: false,
      createTag: true,
      createRelease: true,
    });
  });

  it("rejects an existing npm version with different package contents", () => {
    const commit = "a".repeat(40);
    expect(() =>
      evaluateReleasePolicy({
        requestedVersion: "0.0.1",
        packageVersion: "0.0.1",
        requestedCommit: commit,
        mainCommit: commit,
        workingTreeClean: true,
        ciJobs: REQUIRED_RELEASE_GATE_JOBS.map((name) => ({
          name,
          conclusion: "success",
        })),
        smokeRecord: [
          "<!-- susan-release-smoke:v1 -->",
          "Package-Version: 0.0.1",
          `Commit: ${commit}`,
          "macOS: PASS",
          "Linux: PASS",
          "Windows: PASS",
          "Checklist: PASS",
        ].join("\n"),
        smokeAuthorAssociation: "OWNER",
        packageIntegrity: "sha512-local",
        publishedIntegrity: "sha512-other",
        tagCommit: undefined,
        releaseExists: false,
      }),
    ).toThrow("npm 0.0.1 already exists with different package contents");
  });

  it("rejects a version tag that points at another commit", () => {
    const commit = "a".repeat(40);
    expect(() =>
      evaluateReleasePolicy({
        requestedVersion: "0.0.1",
        packageVersion: "0.0.1",
        requestedCommit: commit,
        mainCommit: commit,
        workingTreeClean: true,
        ciJobs: REQUIRED_RELEASE_GATE_JOBS.map((name) => ({
          name,
          conclusion: "success",
        })),
        smokeRecord: [
          "<!-- susan-release-smoke:v1 -->",
          "Package-Version: 0.0.1",
          `Commit: ${commit}`,
          "macOS: PASS",
          "Linux: PASS",
          "Windows: PASS",
          "Checklist: PASS",
        ].join("\n"),
        smokeAuthorAssociation: "OWNER",
        packageIntegrity: "sha512-local",
        publishedIntegrity: undefined,
        tagCommit: "b".repeat(40),
        releaseExists: false,
      }),
    ).toThrow(`v0.0.1 points at ${"b".repeat(40)}, not ${commit}`);
  });
});
