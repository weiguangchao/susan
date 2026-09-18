import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import ts from "typescript";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), "susan harness smoke-"));
// Resolve JS entrypoints so Windows cmd.exe never interprets paths or arguments.
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
async function run(command, args, cwd) {
  const child = spawn(command, args, { cwd });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")}\n${output}`)));
  });
  return output;
}
let registry;
try {
  const pack = join(temporaryRoot, "pack");
  const consumer = join(temporaryRoot, "consumer");
  await mkdir(pack);
  await mkdir(consumer);
  for (const directory of ["../core", "."]) {
    await run(process.execPath, [pnpmEntry, "pack", "--pack-destination", pack], resolve(packageRoot, directory));
  }
  const core = JSON.parse(await readFile(resolve(packageRoot, "../core/package.json"), "utf8"));
  const harness = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const coreArchive = await readFile(join(pack, `weiguangchao-susan-core-${core.version}.tgz`));
  const harnessArchivePath = join(pack, `weiguangchao-susan-harness-${harness.version}.tgz`);
  const tarballSha256 = createHash("sha256").update(await readFile(harnessArchivePath)).digest("hex");
  // Only this temporary consumer uses the local registry. Archives remain untouched.
  registry = createServer((request, response) => {
    if (request.url === "/core.tgz") return response.end(coreArchive);
    if (decodeURIComponent(request.url).toLowerCase() !== "/@weiguangchao/susan-core") {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ name: core.name, "dist-tags": { latest: core.version }, versions: {
      [core.version]: { ...core, dist: { tarball: `http://127.0.0.1:${registry.address().port}/core.tgz` } },
    } }));
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  await writeFile(join(consumer, ".npmrc"), `@weiguangchao:registry=http://127.0.0.1:${registry.address().port}/\n`);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run(process.execPath, [await findNpmEntry(), "install", "--ignore-scripts", "--no-audit", "--no-fund", harnessArchivePath, "@types/node@^24"], consumer);
  const installed = join(consumer, "node_modules/@weiguangchao/susan-harness");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.bin, undefined);
  assert.equal(manifest.version, "0.0.1");
  assert.deepEqual(manifest.files, ["dist", "CHANGELOG.md"]);
  assert.equal(manifest.dependencies[core.name], `~${core.version}`);
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [core.name, "diff", "openai", "zod"].sort());
  assert.deepEqual(manifest.exports, { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } });
  assert.deepEqual((await readdir(join(installed, "dist"))).sort(), ["index.d.ts", "index.js"]);
  assert.match(await readFile(join(installed, "CHANGELOG.md"), "utf8"), /^# Changelog\n\n## 0\.0\.1 - /);
  const installedCore = JSON.parse(await readFile(join(consumer, "node_modules/@weiguangchao/susan-core/package.json"), "utf8"));
  assert.equal(installedCore.version, core.version);
  for (const file of ["dist/index.js", "dist/index.d.ts"]) {
    const content = await readFile(join(installed, file), "utf8");
    assert.doesNotMatch(content, /workspace:|\.\.\/.*src\/|sourceMappingURL|photon|image-resize|image-process|exif-orientation|from ["'](?:react|ink)["']/);
  }
  const api = JSON.parse(await readFile(new URL("public-api.json", import.meta.url), "utf8"));
  const declarations = ts.createSourceFile("index.d.ts", await readFile(join(installed, "dist/index.d.ts"), "utf8"), ts.ScriptTarget.Latest);
  const exported = [];
  for (const statement of declarations.statements) {
    if (ts.isExportDeclaration(statement)) {
      assert.ok(statement.exportClause && ts.isNamedExports(statement.exportClause), "no wildcard exports");
      for (const element of statement.exportClause.elements) exported.push(element.name.text);
    } else if (ts.canHaveModifiers(statement)) {
      assert.ok(!ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword), "exports must use the explicit list");
    }
  }
  assert.deepEqual(exported.sort(), [...api.values, ...api.types].sort());
  await writeFile(join(consumer, "public-api.json"), JSON.stringify(api));
  await writeFile(join(consumer, "consumer.mjs"), await readFile(new URL("consumer.mjs", import.meta.url)));
  await run(process.execPath, ["consumer.mjs"], consumer);
  await writeFile(join(consumer, "consumer.ts"), `
import type { ${api.types.join(", ")} } from "@weiguangchao/susan-harness";
import { ${api.values.join(", ")} } from "@weiguangchao/susan-harness";
export type AllTypes = [${api.types.map((name) => name === "SessionStoreResult" ? "SessionStoreResult<SessionTranscript>" : name).join(", ")}];
export const allValues = [${api.values.join(", ")}];
// @ts-expect-error no public deep imports
import type { Harness as Internal } from "@weiguangchao/susan-harness/dist/index.js";
// @ts-expect-error core types belong to core
import type { JsonValue } from "@weiguangchao/susan-harness";
// @ts-expect-error registry is internal
import { createOpenAICompletionAdapter } from "@weiguangchao/susan-harness";
`);
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    noEmit: true, skipLibCheck: false, types: ["node"],
  }, include: ["consumer.ts"] }));
  await run(process.execPath, [resolve(packageRoot, "../../node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], consumer);
  console.log(`Harness package smoke passed: version=${manifest.version} sha256=${tarballSha256} @weiguangchao/susan-core=${installedCore.version} node=${process.version} platform=${process.platform}`);
} finally {
  if (registry) await new Promise((resolve) => registry.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
