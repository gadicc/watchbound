import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectElfIdentity } from "./lib/native-artifact.mjs";
import { loadNativeMatrix, targetForId } from "./lib/native-matrix.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetId = parseTarget(process.argv.slice(2));
const matrix = loadNativeMatrix(workspaceRoot);
const target = targetForId(matrix, targetId);
const packageManifest = readJson("dist/native-package-manifest.json");
const descriptor = packageManifest.targets.find(({ id }) => id === target.id);
assert.ok(descriptor, `prepared package tree omits ${target.id}`);
const targetRoot = path.join(workspaceRoot, "dist", descriptor.root);
const manifest = readJson(path.join("dist", descriptor.root, "package.json"));

assert.equal(manifest.name, target.package);
assert.deepEqual(manifest.os, [target.platform]);
assert.deepEqual(manifest.cpu, [target.architecture]);
assert.deepEqual(manifest.libc, [target.libc]);
assert.equal(manifest.main, `./${target.binary}`);
assert.deepEqual(manifest.exports, {
  ".": `./${target.binary}`,
  "./package.json": "./package.json",
});
assert.deepEqual(manifest.files, [target.binary, "README.md", "LICENSE.txt"]);
assert.deepEqual(manifest.watchbound, {
  delivery: "target-native-package",
  target: target.id,
  targetTriple: target.rustTarget,
  architecture: target.architecture,
  armAbi: target.armAbi ?? null,
  libc: target.libc,
  binary: target.binary,
  nativeSha256: descriptor.sha256,
});
assert.deepEqual(
  inspectElfIdentity(fs.readFileSync(path.join(targetRoot, target.binary))),
  {
    class: target.elf.class,
    endianness: target.elf.endianness,
    machine: target.elf.machine,
    flags: target.elf.flags,
  },
);

const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: targetRoot,
  encoding: "utf8",
  stdio: "pipe",
});
if (packed.error) throw packed.error;
assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
const report = JSON.parse(packed.stdout);
assert.equal(report.length, 1);
assert.deepEqual(
  report[0].files.map(({ path: filename }) => filename).sort(),
  ["LICENSE.txt", "README.md", "package.json", target.binary],
);

const loaderManifest = readJson("dist/npm/node/package.json");
assert.deepEqual(
  loaderManifest.optionalDependencies,
  Object.fromEntries(matrix.targets.map((configured) => [configured.package, manifest.version])),
);
process.stdout.write(`Validated exact prepared package ${target.package}\n`);

function parseTarget(args) {
  assert.deepEqual(args.slice(0, 1), ["--target"]);
  assert.equal(args.length, 2);
  assert.ok(args[1]);
  return args[1];
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(path.join(workspaceRoot, source), "utf8"));
}
