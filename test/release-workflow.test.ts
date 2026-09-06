import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  issueCommentId,
  npmPublishedIntegrity,
  releaseOutputs,
  requireCommandOutput,
} from "../scripts/release-preflight-support.js";

const workflow = await readFile(".github/workflows/release.yml", "utf8");

function job(name: string, nextName?: string): string {
  const start = workflow.indexOf(`  ${name}:\n`);
  const end =
    nextName === undefined ? workflow.length : workflow.indexOf(`  ${nextName}:\n`);
  if (start === -1 || end === -1) {
    throw new Error(`workflow job not found: ${name}`);
  }
  return workflow.slice(start, end);
}

describe("release preflight adapter", () => {
  it("fails closed when an external command fails", () => {
    expect(() =>
      requireCommandOutput(
        { status: 1, stdout: "", stderr: "permission denied" },
        "read CI jobs",
      ),
    ).toThrow("read CI jobs failed (1): permission denied");
  });

  it("accepts only an issue comment URL from this repository", () => {
    expect(() =>
      issueCommentId(
        "weiguangchao/susan",
        "https://github.com/another/repo/issues/51#issuecomment-123",
      ),
    ).toThrow("manual smoke record must be an issue comment URL");
  });

  it("treats only npm E404 as an unpublished version", () => {
    expect(() =>
      npmPublishedIntegrity({
        status: 1,
        stdout: "",
        stderr: "network timeout",
      }),
    ).toThrow("npm registry lookup failed (1): network timeout");
  });

  it("emits the exact recovery plan for later jobs", () => {
    expect(
      releaseOutputs(
        { publish: false, createTag: true, createRelease: true },
        "v0.0.1",
        "/tmp/susan.tgz",
      ),
    ).toBe(
      "publish=false\ncreate_tag=true\ncreate_release=true\ntag=v0.0.1\ntarball=/tmp/susan.tgz\n",
    );
  });
});

describe("release workflow privilege boundaries", () => {
  it("keeps write and OIDC permissions out of Release Gate validation", () => {
    const validate = job("validate", "publish");
    expect(validate).toContain("actions: read");
    expect(validate).toContain("contents: read");
    expect(validate).not.toContain("contents: write");
    expect(validate).not.toContain("id-token: write");
  });

  it("gives the publish job OIDC without a token fallback or repository code", () => {
    const publish = job("publish", "metadata");
    expect(publish).toContain("id-token: write");
    expect(publish).toContain("npm publish npm-release-package/*.tgz");
    expect(publish).toContain("--provenance");
    expect(publish).not.toContain("NODE_AUTH_TOKEN");
    expect(publish).not.toContain("actions/checkout");
  });

  it("runs metadata repair only after publish succeeds or is unnecessary", () => {
    const metadata = job("metadata");
    expect(metadata).toContain("contents: write");
    expect(metadata).toContain("needs.publish.result == 'success'");
    expect(metadata).toContain("needs.publish.result == 'skipped'");
    expect(metadata).toContain("create_tag == 'true'");
    expect(metadata).toContain("create_release == 'true'");
  });
});
