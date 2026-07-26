import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultWorkspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function loadNativeMatrix(workspaceRoot = defaultWorkspaceRoot) {
  const source = path.join(workspaceRoot, "config", "native-matrix.json");
  const matrix = JSON.parse(fs.readFileSync(source, "utf8"));
  validateNativeMatrix(matrix);
  return matrix;
}

export function validateNativeMatrix(matrix) {
  assert.equal(matrix.schemaVersion, 1, "native matrix schema");
  assert.equal(matrix.nodeRange, ">=24.15.0 <25", "native matrix Node range");
  assert.equal(matrix.nodeMinimum, "24.15.0", "native matrix Node floor");
  assert.equal(matrix.nodeApiMinimum, 6, "native matrix Node-API floor");
  assert.equal(matrix.releaseBaseline.glibcMaximum, "2.35");
  assert.equal(matrix.releaseBaseline.kernelMinimum, "5.15");
  assert.ok(Array.isArray(matrix.targets) && matrix.targets.length > 0);
  assert.equal(
    new Set(matrix.targets.map(({ id }) => id)).size,
    matrix.targets.length,
    "native target ids must be unique",
  );
  assert.equal(
    new Set(matrix.targets.map(({ package: packageName }) => packageName)).size,
    matrix.targets.length,
    "native target packages must be unique",
  );
  assert.equal(
    new Set(matrix.targets.map(({ binary }) => binary)).size,
    matrix.targets.length,
    "native target binaries must be unique",
  );
  for (const target of matrix.targets) {
    assert.match(target.id, /^linux-(?:x64|arm64)-gnu$/u);
    assert.equal(target.platform, "linux");
    assert.ok(["x64", "arm64"].includes(target.architecture));
    assert.match(target.rustTarget, /^(?:x86_64|aarch64)-unknown-linux-gnu$/u);
    assert.equal(target.libc, "glibc");
    assert.deepEqual(target.overflowRunner, [
      "self-hosted",
      "linux",
      target.architecture,
      "watchbound-overflow",
    ]);
    assert.equal(target.binary, `watchbound.${target.id}.node`);
    assert.equal(
      target.package,
      `@gadicc/watchbound-node-${target.id}`,
    );
    assert.ok(["target-pending-clean-ci", "supported"].includes(target.qualification));
    assert.equal(target.elf.class, 2);
    assert.equal(target.elf.endianness, 1);
    assert.ok(Number.isInteger(target.elf.machine));
    assert.ok(Array.isArray(target.elf.neededLibraries));
  }
  for (const lane of matrix.qualificationLanes) {
    assert.match(lane.id, /^[a-z0-9.-]+$/u);
    assert.ok(Array.isArray(lane.architectures) && lane.architectures.length > 0);
    assert.match(lane.image, /@sha256:[0-9a-f]{64}$/u);
  }
  return matrix;
}

export function targetForRuntime(matrix, platform, architecture) {
  const matches = matrix.targets.filter((target) =>
    target.platform === platform && target.architecture === architecture);
  assert.equal(
    matches.length,
    1,
    `native matrix has no exact target for ${platform}/${architecture}`,
  );
  return matches[0];
}

export function targetForId(matrix, id) {
  const target = matrix.targets.find((candidate) => candidate.id === id);
  assert.ok(target, `native matrix has no target ${id}`);
  return target;
}

export function nativeArtifactEntries(workspaceRoot = defaultWorkspaceRoot) {
  const nodeRoot = path.join(workspaceRoot, "node");
  return fs.readdirSync(nodeRoot)
    .filter((filename) => /\.(?:node|so)$/u.test(filename))
    .sort();
}
