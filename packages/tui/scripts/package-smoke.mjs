import assert from "node:assert/strict";
import ts from "typescript";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), "susan tui smoke-"));
const pnpmEntry = process.env.npm_execpath;
assert.ok(pnpmEntry && /pnpm\.(?:c?js)$/.test(pnpmEntry), "Run through pnpm package:smoke");
async function findNpmEntry() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = process.platform === "win32"
      ? join(directory, "node_modules/npm/bin/npm-cli.js")
      : join(directory, "npm");
    try {
      const entry = await realpath(candidate);
      if ((await stat(entry)).isFile() && entry.endsWith("npm-cli.js")) return entry;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  throw new Error("Cannot locate npm's JavaScript entrypoint on PATH");
}
async function run(command, args, cwd, expectedCode = 0) {
  const child = spawn(command, args, { cwd });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === expectedCode ? resolve() : reject(new Error(`${command} ${args.join(" ")}\n${stdout}${stderr}`)));
  });
  return expectedCode === 0 ? stdout : stdout + stderr;
}

let registry;
try {
  const pack = join(temporaryRoot, "pack");
  const consumer = join(temporaryRoot, "consumer");
  await mkdir(pack);
  await mkdir(consumer);
  const npmEntry = await findNpmEntry();
  const archives = new Map();
  const manifests = new Map();
  for (const directory of ["../core", "../harness", "."]) {
    const cwd = resolve(packageRoot, directory);
    await run(process.execPath, [pnpmEntry, "pack", "--pack-destination", pack], cwd);
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    const filename = `${manifest.name.slice(1).replace("/", "-")}-${manifest.version}.tgz`;
    manifests.set(manifest.name, manifest);
    archives.set(manifest.name, { filename, bytes: await readFile(join(pack, filename)) });
  }
  const tui = manifests.get("@weiguangchao/susan");
  const archive = archives.get(tui.name);
  const archivePath = join(pack, archive.filename);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const originalDigest = digest(archive.bytes);
  // Inspect the packed archive itself, not a fresh projection of the source tree.
  const [report] = JSON.parse(await run(process.execPath,
    [npmEntry, "pack", archivePath, "--dry-run", "--json", "--ignore-scripts"], consumer));
  const packedFiles = report.files.map(({ path }) => path).sort();
  for (const required of ["package.json", "dist/cli.js", "THIRD_PARTY_NOTICES", "CHANGELOG.md"]) {
    assert.ok(packedFiles.includes(required), `tarball missing ${required}`);
  }
  assert.ok(packedFiles.every((path) =>
    path === "package.json" || path === "THIRD_PARTY_NOTICES" || path === "CHANGELOG.md" || /^dist\/(?:cli|(?:devtools|rolldown-runtime)-[A-Za-z0-9_-]+)\.js$/.test(path)),
  `tarball leaked files: ${packedFiles.join(", ")}`);

  // Only the consumer points at this registry. pnpm's original tarballs are never rewritten.
  registry = createServer((request, response) => {
    const path = decodeURIComponent(request.url).toLowerCase();
    for (const [name, archive] of archives) {
      if (path === `/${archive.filename}`) return response.end(archive.bytes);
      if (path !== `/${name}`) continue;
      const manifest = manifests.get(name);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name, "dist-tags": { latest: manifest.version }, versions: {
        [manifest.version]: { ...manifest,
          dependencies: Object.fromEntries(Object.entries(manifest.dependencies ?? {}).map(([dependency, range]) =>
            [dependency, range === "workspace:~" ? `~${manifests.get(dependency).version}` : range])),
          dist: { tarball: `http://127.0.0.1:${registry.address().port}/${archive.filename}` } },
      } }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  await writeFile(join(consumer, ".npmrc"), `@weiguangchao:registry=http://127.0.0.1:${registry.address().port}/\n`);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run(process.execPath, [npmEntry, "install", "--ignore-scripts", "--no-audit", "--no-fund",
    archivePath], consumer);
  assert.equal(digest(await readFile(archivePath)), originalDigest);
  const installed = join(consumer, "node_modules/@weiguangchao/susan");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.name, "@weiguangchao/susan");
  assert.equal(manifest.version, "0.0.1");
  assert.deepEqual(manifest.files, ["dist", "THIRD_PARTY_NOTICES", "CHANGELOG.md"]);
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.bin, { susan: "./dist/cli.js" });
  assert.deepEqual(manifest.exports, {});
  assert.equal(manifest.main, undefined);
  assert.equal(manifest.types, undefined);
  assert.deepEqual(Object.keys(manifest.dependencies).sort(),
    ["@weiguangchao/susan-core", "@weiguangchao/susan-harness", "ink", "react", "string-width"].sort());
  for (const name of ["@weiguangchao/susan-core", "@weiguangchao/susan-harness"]) {
    assert.equal(manifest.dependencies[name], `~${manifests.get(name).version}`);
  }
  const installedInternalVersions = {};
  for (const name of ["@weiguangchao/susan-core", "@weiguangchao/susan-harness"]) {
    const dependency = JSON.parse(await readFile(join(consumer, "node_modules", name, "package.json"), "utf8"));
    assert.equal(dependency.version, manifests.get(name).version);
    installedInternalVersions[name] = dependency.version;
  }
  const contents = await Promise.all(packedFiles.filter((path) => path.endsWith(".js"))
    .map((path) => readFile(join(installed, path), "utf8")));
  const bundle = contents.join("\n");
  assert.doesNotMatch(bundle, /workspace:|sourceMappingURL|photon|image-resize-worker|image-process|exif-orientation/i);
  const imports = new Set();
  for (const content of contents) {
    const source = ts.createSourceFile("bundle.js", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.add(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && /^(?:require|__require)$/.test(node.expression.text)))) {
        if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const name of imports) {
    assert.ok(name !== "ink" && !name.startsWith("ink/"), `Ink was not bundled: ${name}`);
    assert.doesNotMatch(name, /@weiguangchao\/susan-(?:core|harness)\/|(?:^|\/)src\//);
  }
  assert.ok(imports.has("@weiguangchao/susan-harness"));
  assert.ok(imports.has("@weiguangchao/susan-core"));
  assert.ok(!/function createHarnessAssembly|function createHarness\(/.test(bundle), "Harness must stay external");
  assert.match(bundle, /needsResizeReplay/, "bundle must include patched Ink");
  assert.ok((await readFile(join(installed, "dist/cli.js"), "utf8")).startsWith("#!/usr/bin/env node"));
  await stat(join(consumer, "node_modules/.bin", process.platform === "win32" ? "susan.cmd" : "susan"));
  await writeFile(join(consumer, "no-library.mjs"), `
import assert from "node:assert/strict";
for (const name of ["@weiguangchao/susan", "@weiguangchao/susan/dist/cli.js"]) {
  await assert.rejects(import(name), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
}
`);
  await run(process.execPath, ["no-library.mjs"], consumer);
  const cli = (args, code = 1) => run(process.execPath, [join(installed, "dist/cli.js"), ...args], consumer, code);
  assert.equal(await cli(["--version"], 0), "0.0.1\n");
  assert.match(await cli(["--unknown"]), /Unknown argument: --unknown[\s\S]*Usage:/);
  assert.match(await cli(["--config"]), /--config requires/);
  assert.match(await cli(["--last"]), /--last requires --resume/);
  assert.match(await cli(["--config", join(temporaryRoot, "missing-parent")]), /Susan Home parent does not exist/);
  const parent = join(consumer, "home with spaces");
  await mkdir(parent, { mode: 0o700 });
  assert.match(await cli(["--config", "home with spaces"]), /SUSAN_CONFIG_MISSING/);
  const config = join(parent, ".susan/config.json");
  await writeFile(config, "{", { mode: 0o600 });
  assert.match(await cli(["--config", parent]), /SUSAN_CONFIG_PARSE/);
  await writeFile(config, JSON.stringify({ approval: "ask", providers: {} }), { mode: 0o600 });
  assert.match(await cli(["--config", parent]), /SUSAN_CONFIG_SCHEMA/);
  await writeFile(config, JSON.stringify({ providers: {} }), { mode: 0o600 });
  assert.match(await cli(["--config", parent]), /TUI requires an interactive terminal/);
  assert.match(await cli(["--config", parent, "--resume", "--last"]), /TUI requires an interactive terminal/);
  assert.match(await cli(["--config", parent, "--resume", "11111111-1111-1111-1111-111111111111"]), /susan:.*(?:Session|session)/);
  assert.equal((await readdir(join(parent, ".susan/sessions"))).length, 1, "startup creates one reusable Session");
  console.log(`TUI package smoke passed: version=${manifest.version} sha256=${originalDigest} @weiguangchao/susan-harness=${installedInternalVersions["@weiguangchao/susan-harness"]} @weiguangchao/susan-core=${installedInternalVersions["@weiguangchao/susan-core"]} node=${process.version} platform=${process.platform}`);
} finally {
  if (registry) await new Promise((resolve) => registry.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
