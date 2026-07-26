import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeMatrix, targetForId } from "./lib/native-matrix.mjs";
import { verifyReleaseCandidate } from "./lib/release-version.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseOptions(process.argv.slice(2));
const matrix = loadNativeMatrix(workspaceRoot);
const left = loadBuild(options.left);
const right = loadBuild(options.right);
const targetId = options.target ?? left.manifest.release?.targetId;
const target = targetForId(matrix, targetId);
const rootPackage = readJson(path.join(workspaceRoot, "package.json"));
const sourceSha = capture("git", ["rev-parse", "HEAD"]);
const candidate = verifyReleaseCandidate(workspaceRoot, {
  sourceSha,
  version: rootPackage.version,
});

validateBuild(left, "left", candidate, target);
validateBuild(right, "right", candidate, target);
assert.notEqual(left.manifest.builder, right.manifest.builder);

for (const field of [
  ["source", "gitHead"],
  ["source", "gitDirty"],
  ["source", "materialization"],
  ["source", "locks", "cargo"],
  ["source", "locks", "pnpm"],
  ["release", "version"],
  ["release", "target"],
  ["release", "profile"],
  ["release", "nodeApi"],
  ["buildEnvironment", "cargoIncremental"],
  ["buildEnvironment", "sourceDateEpoch"],
  ["buildEnvironment", "timezone"],
  ["host", "distribution"],
  ["host", "architecture"],
  ["host", "glibc"],
  ["tools", "node"],
  ["tools", "pnpm"],
  ["tools", "rustc"],
  ["tools", "cargo"],
  ["tools", "cc"],
  ["tools", "ld"],
]) {
  assert.deepEqual(
    valueAt(left.manifest, field),
    valueAt(right.manifest, field),
    `independent builders differ at ${field.join(".")}`,
  );
}

for (const field of [
  "cargoHome",
  "cargoTargetDirectory",
  "corepackHome",
  "pnpmStoreDirectory",
  "rustupHome",
]) {
  assert.notEqual(
    left.manifest.isolation[field],
    right.manifest.isolation[field],
    `independent builders unexpectedly share isolation.${field}`,
  );
}

assert.equal(
  left.observedSha256,
  right.observedSha256,
  `independent native binary digests differ: ${left.manifest.builder}=${left.observedSha256}, ${right.manifest.builder}=${right.observedSha256}`,
);
assert.equal(
  left.binary.equals(right.binary),
  true,
  "independent native binaries are not byte-identical",
);

const outputRoot = path.resolve(workspaceRoot, options.output);
fs.mkdirSync(outputRoot, { recursive: true });
const canonicalPath = path.join(
  outputRoot,
  target.binary,
);
fs.copyFileSync(left.binaryPath, canonicalPath);
const comparison = {
  schemaVersion: 2,
  kind: "watchbound-independent-native-comparison",
  sourceSha,
  version: rootPackage.version,
  candidate,
  targetId: target.id,
  target: left.manifest.release.target,
  profile: left.manifest.release.profile,
  sha256: left.observedSha256,
  bytes: left.binary.length,
  byteIdentical: true,
  builders: [left.manifest, right.manifest],
};
const comparisonPath = path.join(
  outputRoot,
  "independent-reproducibility.json",
);
fs.writeFileSync(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`);

if (options["github-output"]) {
  fs.appendFileSync(
    path.resolve(workspaceRoot, options["github-output"]),
    `native-sha256=${comparison.sha256}\n`,
  );
}
process.stdout.write(
  `Independent native builds are byte-identical: ${comparison.sha256}\n`,
);

function loadBuild(manifestSource) {
  const manifestPath = path.resolve(workspaceRoot, manifestSource);
  const manifest = readJson(manifestPath);
  const binaryPath = path.join(
    path.dirname(manifestPath),
    manifest.artifact?.filename ?? "",
  );
  const binary = fs.readFileSync(binaryPath);
  return {
    manifest,
    binaryPath,
    binary,
    observedSha256: crypto.createHash("sha256").update(binary).digest("hex"),
  };
}

function validateBuild(build, label, candidate, target) {
  const { manifest, binary, observedSha256 } = build;
  assert.equal(manifest.schemaVersion, 2, `${label} manifest schema`);
  assert.equal(
    manifest.kind,
    "watchbound-independent-native-build",
    `${label} manifest kind`,
  );
  assert.equal(manifest.source.gitHead, candidate.sourceSha, `${label} source SHA`);
  assert.equal(manifest.source.gitDirty, candidate.gitDirty, `${label} dirty state`);
  assert.deepEqual(
    manifest.source.materialization,
    candidate,
    `${label} candidate materialization`,
  );
  assert.equal(manifest.release.version, candidate.version, `${label} version`);
  assert.equal(manifest.release.targetId, target.id, `${label} target id`);
  assert.equal(
    manifest.release.target,
    target.rustTarget,
    `${label} target`,
  );
  assert.equal(manifest.release.profile, "release", `${label} profile`);
  assert.equal(manifest.buildEnvironment.cargoIncremental, "0");
  assert.equal(
    manifest.buildEnvironment.rustFlags,
    `--remap-path-prefix=${manifest.isolation.cargoHome}=/watchbound/cargo-home`,
    `${label} Cargo source path remapping`,
  );
  assert.equal(manifest.buildEnvironment.sourceDateEpoch, "0");
  assert.equal(manifest.buildEnvironment.timezone, "UTC");
  assert.equal(
    new Set(Object.values(manifest.isolation)).size,
    5,
    `${label} builder isolation paths`,
  );
  for (const isolationPath of Object.values(manifest.isolation)) {
    assert.ok(path.isAbsolute(isolationPath), `${label} isolation path`);
  }
  assert.equal(
    manifest.artifact.filename,
    target.binary,
    `${label} artifact filename`,
  );
  assert.equal(manifest.artifact.bytes, binary.length, `${label} byte count`);
  assert.equal(
    manifest.artifact.sha256,
    observedSha256,
    `${label} artifact digest`,
  );
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: compare-native-builds.mjs --left <manifest> --right <manifest> --output <directory> [--target <id>] [--github-output <path>]",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  for (const required of ["left", "right", "output"]) {
    assert.ok(parsed[required], `--${required} is required`);
  }
  return parsed;
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function valueAt(value, keys) {
  return keys.reduce((current, key) => current?.[key], value);
}
