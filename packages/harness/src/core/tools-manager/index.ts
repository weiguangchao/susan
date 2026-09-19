import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { DEFAULT_SUSAN_HOME } from "../susan-home";
import { downloadTool } from "./download";

export { getLatestVersion } from "./download";

export function getBinDir(): string {
  return process.env.SUSAN_BIN_DIR ?? join(DEFAULT_SUSAN_HOME, "bin");
}

function isOfflineModeEnabled(): boolean {
  const value = process.env.SUSAN_OFFLINE;
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

type ToolName = "fd" | "rg";

type ToolConfig = {
  name: string;
  repo: string;
  binaryName: string;
  systemBinaryNames?: string[];
  tagPrefix: string;
  getAssetName: (version: string, plat: string, architecture: string) => string | null;
};

const TOOLS: Record<ToolName, ToolConfig> = {
  fd: {
    name: "fd",
    repo: "sharkdp/fd",
    binaryName: "fd",
    systemBinaryNames: ["fd", "fdfind"],
    tagPrefix: "v",
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
      } else if (plat === "linux") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-unknown-linux-musl.tar.gz`;
      } else if (plat === "win32") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
      }
      return null;
    },
  },
  rg: {
    name: "ripgrep",
    repo: "BurntSushi/ripgrep",
    binaryName: "rg",
    tagPrefix: "",
    getAssetName: (version, plat, architecture) => {
      if (plat === "darwin") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
      } else if (plat === "linux") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-unknown-linux-musl.tar.gz`;
      } else if (plat === "win32") {
        const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
        return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
      }
      return null;
    },
  },
};

export function getToolAssetName(
  tool: ToolName,
  version: string,
  plat: string,
  architecture: string,
): string | null {
  return TOOLS[tool].getAssetName(version, plat, architecture);
}

function commandExists(cmd: string): boolean {
  try {
    const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
    return result.error === undefined || result.error === null;
  } catch {
    return false;
  }
}

export function getToolPath(tool: ToolName): string | null {
  const config = TOOLS[tool];
  if (!config) return null;

  const localPath = join(getBinDir(), config.binaryName + (platform() === "win32" ? ".exe" : ""));
  if (existsSync(localPath)) {
    return localPath;
  }

  const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
  for (const systemBinaryName of systemBinaryNames) {
    if (commandExists(systemBinaryName)) {
      return systemBinaryName;
    }
  }

  return null;
}

const TERMUX_PACKAGES: Record<string, string> = {
  fd: "fd",
  rg: "ripgrep",
};

export type ToolStatus = {
  type: "info" | "warning";
  message: string;
};

/**
 * Ensure a tool is available, downloading if necessary.
 * Reports progress through `onStatus`; status messages are otherwise silent.
 * Returns the tool path, or undefined if unavailable.
 */
export async function ensureTool(
  tool: ToolName,
  onStatus?: (status: ToolStatus) => void,
): Promise<string | undefined> {
  const existingPath = getToolPath(tool);
  if (existingPath) {
    return existingPath;
  }

  const config = TOOLS[tool];
  if (!config) return undefined;

  if (isOfflineModeEnabled()) {
    onStatus?.({
      type: "warning",
      message: `${config.name} not found. Offline mode enabled, skipping download.`,
    });
    return undefined;
  }

  if (platform() === "android") {
    const pkgName = TERMUX_PACKAGES[tool] ?? tool;
    onStatus?.({
      type: "warning",
      message: `${config.name} not found. Install with: pkg install ${pkgName}`,
    });
    return undefined;
  }

  onStatus?.({ type: "info", message: `${config.name} not found. Downloading...` });

  try {
    const path = await downloadTool(tool, config, getBinDir());
    onStatus?.({ type: "info", message: `${config.name} installed to ${path}` });
    return path;
  } catch (e) {
    const messages: string[] = [];
    for (
      let current: unknown = e, depth = 0;
      current instanceof Error && depth < 5;
      current = current.cause, depth++
    ) {
      if (!messages.includes(current.message)) messages.push(current.message);
    }
    onStatus?.({
      type: "warning",
      message: `Failed to download ${config.name}: ${messages.length > 0 ? messages.join(": ") : String(e)}`,
    });
    return undefined;
  }
}
