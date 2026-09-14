import { describe, expect, it } from "vitest";

import {
  issueCommentId,
  npmPublishedIntegrity,
  releaseOutputs,
  requireCommandOutput,
} from "../scripts/release-preflight-support";

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
