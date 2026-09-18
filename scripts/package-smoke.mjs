import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function fail(message) {
  throw new Error(`package smoke: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    ...options,
  });
  if (result.error !== undefined) {
    fail(`${command} could not start: ${result.error.message}`);
  }
  return result;
}

function requireSuccess(result, description) {
  if (result.status !== 0) {
    fail(
      `${description} exited ${String(result.status)}\n${result.stdout}${result.stderr}`,
    );
  }
}

function requireExit(result, description, expectedStatus, fragments) {
  if (result.status !== expectedStatus) {
    fail(
      `${description} exited ${String(result.status)}; expected ${expectedStatus}\n${result.stdout}${result.stderr}`,
    );
  }
  const output = `${result.stdout}${result.stderr}`;
  for (const fragment of fragments) {
    if (!output.includes(fragment)) {
      fail(`${description} did not include ${JSON.stringify(fragment)}\n${output}`);
    }
  }
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "susan-package-smoke-"));

try {
  const packDirectory = join(temporaryRoot, "pack");
  const installDirectory = join(temporaryRoot, "install");
  const isolatedHome = join(temporaryRoot, "home");
  await mkdir(packDirectory);
  await mkdir(installDirectory);
  await mkdir(isolatedHome, { mode: 0o700 });

  const packed = run(
    npmCommand,
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory],
    { cwd: repositoryRoot },
  );
  requireSuccess(packed, "npm pack");

  let packReport;
  try {
    packReport = JSON.parse(packed.stdout);
  } catch {
    fail(`npm pack did not return JSON\n${packed.stdout}${packed.stderr}`);
  }
  if (!Array.isArray(packReport) || packReport.length !== 1) {
    fail("npm pack must produce exactly one tarball");
  }
  const report = packReport[0];
  const packedFiles = report.files
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right, "en"));
  const requiredFiles = ["dist/cli.js", "package.json", "THIRD_PARTY_NOTICES"];
  // Bundled Ink includes lazy DevTools/runtime chunks alongside the CLI.
  if (
    requiredFiles.some((file) => !packedFiles.includes(file)) ||
    packedFiles.some((file) => file !== "package.json" && file !== "THIRD_PARTY_NOTICES" && !/^dist\/[^/]+\.js$/.test(file))
  ) {
    fail(
      `unexpected npm pack files: ${JSON.stringify(packedFiles)}; expected package.json and built JavaScript including dist/cli.js`,
    );
  }

  const tarballPath = join(packDirectory, report.filename);
  await lstat(tarballPath);
  const installed = run(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installDirectory,
      tarballPath,
    ],
    { cwd: installDirectory },
  );
  requireSuccess(installed, "fresh tarball install");

  const packageDirectory = join(
    installDirectory,
    "node_modules",
    "@weiguangchao",
    "susan",
  );
  const installedManifest = JSON.parse(
    await readFile(join(packageDirectory, "package.json"), "utf8"),
  );
  if (installedManifest.bin?.susan !== "./dist/cli.js") {
    fail("installed package does not wire the susan bin to ./dist/cli.js");
  }
  try {
    await lstat(join(packageDirectory, "src"));
    fail("installed package leaked workspace source");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const binPath = join(
    installDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "susan.cmd" : "susan",
  );
  await lstat(binPath);
  const cliEnvironment = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
  };
  const runInstalledCli = (args) =>
    run(binPath, args, {
      cwd: installDirectory,
      env: cliEnvironment,
      shell: process.platform === "win32",
    });

  const usage = runInstalledCli(["--unknown"]);
  requireExit(usage, "installed susan bin usage", 1, [
    "Unknown argument: --unknown",
    "Usage:",
  ]);

  const missingParent = join(temporaryRoot, "missing-parent");
  const missingParentResult = runInstalledCli(["--config", missingParent]);
  requireExit(missingParentResult, "missing Susan Home parent", 1, [
    "Susan Home parent does not exist",
  ]);

  const missingConfigParent = join(temporaryRoot, "missing-config");
  await mkdir(missingConfigParent, { mode: 0o700 });
  const missingConfig = runInstalledCli(["--config", missingConfigParent]);
  requireExit(missingConfig, "missing Config", 1, [
    "SUSAN_CONFIG_MISSING",
    join(missingConfigParent, ".susan", "config.json"),
  ]);

  const invalidParent = join(temporaryRoot, "invalid");
  const invalidConfigPath = join(invalidParent, ".susan", "config.json");
  await mkdir(join(invalidParent, ".susan"), { recursive: true, mode: 0o700 });
  await writeFile(
    invalidConfigPath,
    JSON.stringify({ approval: "ask", providers: {} }),
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(join(invalidParent, ".susan"), 0o700);
  await chmod(invalidConfigPath, 0o600);
  const invalidConfig = runInstalledCli(["--config", invalidParent]);
  requireExit(invalidConfig, "invalid Config", 1, [
    "SUSAN_CONFIG_SCHEMA",
    "approval",
  ]);

  const validParent = join(temporaryRoot, "valid");
  const validConfigPath = join(validParent, ".susan", "config.json");
  await mkdir(join(validParent, ".susan"), { recursive: true, mode: 0o700 });
  await writeFile(validConfigPath, JSON.stringify({ providers: {} }), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(join(validParent, ".susan"), 0o700);
  await chmod(validConfigPath, 0o600);
  const nonInteractive = runInstalledCli(["--config", validParent]);
  requireExit(nonInteractive, "non-interactive startup", 1, [
    "TUI requires an interactive terminal",
  ]);

  process.stdout.write(
    `package smoke passed: ${report.filename} (${packedFiles.join(", ")})\n`,
  );
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
