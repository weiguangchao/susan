import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureTool,
  getBinDir,
  getLatestVersion,
  getToolAssetName,
  getToolPath,
  type ToolStatus,
} from "../src/index.js";

const originalOffline = process.env.SUSAN_OFFLINE;
const originalBinDir = process.env.SUSAN_BIN_DIR;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn((command: string, args?: readonly string[], options?: object) => {
      if (args?.[0] === "--version") {
        return {
          error: Object.assign(new Error("not found"), { code: "ENOENT" }),
          status: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          pid: 0,
          output: [null, Buffer.from(""), Buffer.from("")],
          signal: null,
        };
      }
      return actual.spawnSync(command, args as string[], options);
    }),
  };
});

let tempBinDir: string;

beforeEach(async () => {
  tempBinDir = await mkdtemp(join(tmpdir(), "susan-tools-manager-"));
  process.env.SUSAN_BIN_DIR = tempBinDir;
  delete process.env.SUSAN_OFFLINE;
});

afterEach(async () => {
  if (originalOffline === undefined) delete process.env.SUSAN_OFFLINE;
  else process.env.SUSAN_OFFLINE = originalOffline;
  if (originalBinDir === undefined) delete process.env.SUSAN_BIN_DIR;
  else process.env.SUSAN_BIN_DIR = originalBinDir;
  vi.unstubAllGlobals();
  await rm(tempBinDir, { recursive: true, force: true });
});

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function createRgArchive(version: string): { assetName: string; bytes: Buffer } {
  const plat = platform();
  const architecture = arch();
  const assetName = getToolAssetName("rg", version, plat, architecture);
  if (assetName === null) {
    throw new Error(`unsupported test platform ${plat}/${architecture}`);
  }

  const workspace = join(tempBinDir, "_fixture");
  const staging = join(workspace, "staging");
  mkdirSync(staging, { recursive: true });
  const binaryPath = join(staging, "rg");
  writeFileSync(binaryPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });
  chmodSync(binaryPath, 0o755);

  const archivePath = join(workspace, assetName);
  const result = spawnSync("tar", ["czf", archivePath, "-C", staging, "rg"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || "failed to create test archive");
  }
  return { assetName, bytes: readFileSync(archivePath) };
}

describe("getToolAssetName", () => {
  it("maps ripgrep and fd assets for darwin, linux, and windows", () => {
    expect(getToolAssetName("rg", "14.1.1", "darwin", "arm64")).toBe(
      "ripgrep-14.1.1-aarch64-apple-darwin.tar.gz",
    );
    expect(getToolAssetName("rg", "14.1.1", "darwin", "x64")).toBe(
      "ripgrep-14.1.1-x86_64-apple-darwin.tar.gz",
    );
    expect(getToolAssetName("rg", "14.1.1", "linux", "arm64")).toBe(
      "ripgrep-14.1.1-aarch64-unknown-linux-musl.tar.gz",
    );
    expect(getToolAssetName("rg", "14.1.1", "linux", "x64")).toBe(
      "ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(getToolAssetName("rg", "14.1.1", "win32", "arm64")).toBe(
      "ripgrep-14.1.1-aarch64-pc-windows-msvc.zip",
    );
    expect(getToolAssetName("rg", "14.1.1", "win32", "x64")).toBe(
      "ripgrep-14.1.1-x86_64-pc-windows-msvc.zip",
    );

    expect(getToolAssetName("fd", "10.2.0", "darwin", "arm64")).toBe(
      "fd-v10.2.0-aarch64-apple-darwin.tar.gz",
    );
    expect(getToolAssetName("fd", "10.2.0", "darwin", "x64")).toBe(
      "fd-v10.2.0-x86_64-apple-darwin.tar.gz",
    );
    expect(getToolAssetName("fd", "10.2.0", "linux", "arm64")).toBe(
      "fd-v10.2.0-aarch64-unknown-linux-musl.tar.gz",
    );
    expect(getToolAssetName("fd", "10.2.0", "linux", "x64")).toBe(
      "fd-v10.2.0-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(getToolAssetName("fd", "10.2.0", "win32", "arm64")).toBe(
      "fd-v10.2.0-aarch64-pc-windows-msvc.zip",
    );
    expect(getToolAssetName("fd", "10.2.0", "win32", "x64")).toBe(
      "fd-v10.2.0-x86_64-pc-windows-msvc.zip",
    );
  });

  it("returns null for unsupported platforms", () => {
    expect(getToolAssetName("rg", "14.1.1", "aix", "ppc64")).toBeNull();
    expect(getToolAssetName("fd", "10.2.0", "freebsd", "x64")).toBeNull();
  });
});

describe("getLatestVersion", () => {
  it("resolves the version from the release page redirect", async () => {
    const fetchMock = vi.fn(async () => redirectResponse("https://github.com/sharkdp/fd/releases/tag/v10.4.2"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/sharkdp/fd/releases/latest",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("keeps tags without a v prefix intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => redirectResponse("https://github.com/BurntSushi/ripgrep/releases/tag/15.2.0")),
    );

    await expect(getLatestVersion("BurntSushi/ripgrep")).resolves.toBe("15.2.0");
  });

  it("resolves relative redirect targets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => redirectResponse("/sharkdp/fd/releases/tag/v10.4.2")),
    );

    await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
  });

  it("discards the redirect response body", async () => {
    const response = new Response("<html></html>", {
      status: 302,
      headers: { location: "https://github.com/sharkdp/fd/releases/tag/v10.4.2" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    await expect(getLatestVersion("sharkdp/fd")).resolves.toBe("10.4.2");
    expect(response.bodyUsed).toBe(true);
  });

  it("fails clearly when the endpoint does not redirect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );

    await expect(getLatestVersion("sharkdp/fd")).rejects.toThrow(
      "Failed to resolve latest sharkdp/fd release: HTTP 404 without redirect",
    );
  });

  it("fails clearly when the redirect does not point at a release tag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => redirectResponse("https://github.com/login")),
    );

    await expect(getLatestVersion("sharkdp/fd")).rejects.toThrow(
      "Failed to resolve latest sharkdp/fd release: unexpected redirect to https://github.com/login",
    );
  });
});

describe("ensureTool", () => {
  it("reports status through a callback without writing to the console", async () => {
    process.env.SUSAN_OFFLINE = "1";
    const statuses: ToolStatus[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await ensureTool("fd", (status) => statuses.push(status));

    expect(result).toBeUndefined();
    expect(statuses).toEqual([
      {
        type: "warning",
        message: "fd not found. Offline mode enabled, skipping download.",
      },
    ]);
    expect(consoleLog).not.toHaveBeenCalled();
    consoleLog.mockRestore();
  });

  it("surfaces the error cause chain when a download fails", async () => {
    delete process.env.SUSAN_OFFLINE;
    const cause = new Error("connect ETIMEDOUT 140.82.113.3:443");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause });
      }),
    );
    const statuses: ToolStatus[] = [];

    const result = await ensureTool("fd", (status) => statuses.push(status));

    expect(result).toBeUndefined();
    expect(statuses).toEqual([
      { type: "info", message: "fd not found. Downloading..." },
      {
        type: "warning",
        message: "Failed to download fd: fetch failed: connect ETIMEDOUT 140.82.113.3:443",
      },
    ]);
  });

  it("downloads into the bin cache on first use and reuses it offline", async () => {
    const version = "14.1.1";
    const archive = createRgArchive(version);
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url === "https://github.com/BurntSushi/ripgrep/releases/latest") {
        return redirectResponse(`https://github.com/BurntSushi/ripgrep/releases/tag/${version}`);
      }
      if (url === `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${archive.assetName}`) {
        return new Response(archive.bytes, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await ensureTool("rg");
    const cachedPath = join(getBinDir(), "rg");
    expect(first).toBe(cachedPath);
    expect(existsSync(cachedPath)).toBe(true);
    expect(getToolPath("rg")).toBe(cachedPath);
    expect(readdirSync(getBinDir()).filter((name) => name.startsWith("extract_tmp_"))).toEqual([]);
    expect(existsSync(join(getBinDir(), archive.assetName))).toBe(false);

    const offlineFetch = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", offlineFetch);

    const second = await ensureTool("rg");
    expect(second).toBe(cachedPath);
    expect(offlineFetch).not.toHaveBeenCalled();
  });
});
