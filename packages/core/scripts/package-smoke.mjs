import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const temporaryRoot = await mkdtemp(join(tmpdir(), "susan-core-smoke-"));
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

try {
  const pack = join(temporaryRoot, "pack");
  const consumer = join(temporaryRoot, "consumer");
  await mkdir(pack);
  await mkdir(consumer);
  const [report] = JSON.parse(run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", pack], packageRoot));
  const archivePath = join(pack, report.filename);
  const tarballSha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  assert.deepEqual(report.files.map(({ path }) => path).sort(), [
    "CHANGELOG.md", "README.md", "dist/index.d.ts", "dist/index.js", "package.json",
  ]);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // Install the original archive. No manifest rewriting or workspace source links.
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", archivePath], consumer);
  const installed = join(consumer, "node_modules/@weiguangchao/susan-core");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  const sourceManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "@weiguangchao/susan-core");
  assert.equal(manifest.version, sourceManifest.version);
  assert.equal(manifest.type, "module");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.bin, undefined);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(Object.keys(manifest[field] ?? {}), []);
  }
  assert.deepEqual(manifest.files, ["dist", "CHANGELOG.md"]);
  assert.deepEqual(manifest.exports, { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } });
  assert.equal(manifest.types, "./dist/index.d.ts");
  for (const file of ["dist/index.js", "dist/index.d.ts"]) {
    const content = await readFile(join(installed, file), "utf8");
    assert.doesNotMatch(content, /workspace:|\.\.\/.*src\/|sourceMappingURL|photon|image-resize/);
  }
  await writeFile(join(consumer, "consumer.mjs"), `
import assert from "node:assert/strict";
import * as core from "@weiguangchao/susan-core";
assert.deepEqual(Object.keys(core).sort(), ["isJsonValue", "isRecord"]);
assert.equal(core.isRecord({ a: undefined }), true);
assert.equal(core.isRecord([]), false);
assert.equal(core.isRecord(null), false);
assert.equal(core.isJsonValue({ a: [null, "text", true, 42] }), true);
assert.equal(core.isJsonValue({ a: [Infinity] }), false);
assert.equal(core.isJsonValue({ a: undefined }), false);
for (const path of ["json", "dist/index.js", "src/index.ts", "package.json"]) {
  await assert.rejects(import("@weiguangchao/susan-core/" + path), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
}
`);
  run(process.execPath, ["consumer.mjs"], consumer);
  await writeFile(join(consumer, "consumer.ts"), `
import { isJsonValue, isRecord } from "@weiguangchao/susan-core";
import type { JsonPrimitive, JsonValue, JsonObject } from "@weiguangchao/susan-core";
const primitive: JsonPrimitive = null;
const value: JsonValue = [primitive, "text", 42, true];
const object: JsonObject = { nested: value };
const unknownValue: unknown = object;
if (isJsonValue(unknownValue)) { const narrowed: JsonValue = unknownValue; }
if (isRecord(unknownValue)) { const narrowed: Record<string, unknown> = unknownValue; }
// @ts-expect-error undefined is not JSON
const invalidPrimitive: JsonPrimitive = undefined;
// @ts-expect-error functions are not JSON
const invalidValue: JsonValue = () => {};
// @ts-expect-error arrays are not JSON objects
const invalidObject: JsonObject = [];
// @ts-expect-error no public subpath
import type { JsonValue as Internal } from "@weiguangchao/susan-core/dist/index.js";
`);
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: [] },
    include: ["consumer.ts"],
  }));
  const tsc = resolve(packageRoot, "../../node_modules/typescript/bin/tsc");
  run(process.execPath, [tsc, "-p", "tsconfig.json"], consumer);
  console.log(`core package smoke passed: version=${manifest.version} sha256=${tarballSha256} internalDependencies=none node=${process.version} platform=${process.platform}`);
} finally {
  if (process.env.SUSAN_SMOKE_KEEP_TEMP === "1") {
    console.log(`Smoke artifacts retained: ${temporaryRoot}`);
  } else {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
