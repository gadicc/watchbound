import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SOURCE_VERSION = "0.0.0-development";
export const VERSION_FILES = Object.freeze([
  "package.json",
  "js/package.json",
  "node/package.json",
  "Cargo.toml",
  "Cargo.lock",
  "pnpm-lock.yaml",
]);

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export function assertWorkspaceVersion(workspaceRoot, expectedVersion) {
  assertVersion(expectedVersion);
  const sources = Object.fromEntries(
    VERSION_FILES.map((relativePath) => [
      relativePath,
      fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8"),
    ]),
  );
  assertVersionSources(sources, expectedVersion);
}

export function assertCommittedSourceVersion(workspaceRoot) {
  assertVersionSources(committedVersionSources(workspaceRoot), SOURCE_VERSION);
}

export function materializeReleaseCandidate(
  workspaceRoot,
  { sourceSha, version },
) {
  verifyReleaseCandidate(workspaceRoot, {
    sourceSha,
    version: SOURCE_VERSION,
  });
  const committedSources = committedVersionSources(workspaceRoot);
  for (const relativePath of VERSION_FILES) {
    fs.writeFileSync(
      path.join(workspaceRoot, relativePath),
      materializeVersion(relativePath, committedSources[relativePath], version),
    );
  }
  return verifyReleaseCandidate(workspaceRoot, { sourceSha, version });
}

export function verifyReleaseCandidate(
  workspaceRoot,
  { sourceSha, version },
) {
  assert.match(sourceSha ?? "", /^[0-9a-f]{40}$/u, "invalid candidate source SHA");
  assertVersion(version);
  assert.equal(
    captureGit(workspaceRoot, ["rev-parse", "HEAD"]).trim(),
    sourceSha,
    "materialized candidate source SHA differs",
  );

  const committedSources = committedVersionSources(workspaceRoot);
  assertVersionSources(committedSources, SOURCE_VERSION);
  const expectedChangedFiles = [];
  const files = [];
  for (const relativePath of VERSION_FILES) {
    const committed = committedSources[relativePath];
    const expected = materializeVersion(relativePath, committed, version);
    const actual = fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
    assert.equal(
      actual,
      expected,
      `materialized candidate differs at ${relativePath}`,
    );
    if (expected !== committed) expectedChangedFiles.push(relativePath);
    files.push({
      path: relativePath,
      sha256: crypto.createHash("sha256").update(actual).digest("hex"),
    });
  }

  const changedFiles = gitPathList(workspaceRoot, ["diff", "--name-only", "--"]);
  assert.deepEqual(
    changedFiles,
    [...expectedChangedFiles].sort(),
    "materialized candidate changed unexpected tracked files",
  );
  assert.deepEqual(
    gitPathList(workspaceRoot, ["diff", "--cached", "--name-only", "--"]),
    [],
    "materialized candidate has staged changes",
  );
  assert.deepEqual(
    gitPathList(workspaceRoot, ["ls-files", "--others", "--exclude-standard"]),
    [],
    "materialized candidate has untracked files",
  );

  return {
    schemaVersion: 1,
    kind: "watchbound-materialized-release-candidate",
    sourceSha,
    sourceVersion: SOURCE_VERSION,
    version,
    gitDirty: expectedChangedFiles.length > 0,
    files,
  };
}

function committedVersionSources(workspaceRoot) {
  return Object.fromEntries(
    VERSION_FILES.map((relativePath) => [
      relativePath,
      captureGit(workspaceRoot, ["show", `HEAD:${relativePath}`]),
    ]),
  );
}

function assertVersionSources(sources, expectedVersion) {
  const root = JSON.parse(sources["package.json"]);
  const wrapper = JSON.parse(sources["js/package.json"]);
  const native = JSON.parse(sources["node/package.json"]);
  for (const [label, actual, expected] of [
    ["root npm", root.version, expectedVersion],
    ["wrapper npm", wrapper.version, expectedVersion],
    ["native npm", native.version, expectedVersion],
    [
      "wrapper workspace dependency",
      wrapper.dependencies?.["@gadicc/watchbound-node"],
      `workspace:${expectedVersion}`,
    ],
    [
      "Cargo workspace",
      captureExactly(sources["Cargo.toml"], /^version = "([^"]+)"$/mu),
      expectedVersion,
    ],
    [
      "Cargo engine lock",
      lockedCargoVersion(sources["Cargo.lock"], "watchbound-engine"),
      expectedVersion,
    ],
    [
      "Cargo native lock",
      lockedCargoVersion(sources["Cargo.lock"], "watchbound-node"),
      expectedVersion,
    ],
    [
      "pnpm workspace dependency",
      captureExactly(sources["pnpm-lock.yaml"], /specifier: workspace:([^\s]+)$/mu),
      expectedVersion,
    ],
  ]) {
    assert.equal(actual, expected, `${label} version must be ${expectedVersion}`);
  }
}

function materializeVersion(relativePath, source, version) {
  assertVersion(version);
  if (relativePath.endsWith("package.json")) {
    const manifest = JSON.parse(source);
    manifest.version = version;
    if (relativePath === "js/package.json") {
      manifest.dependencies["@gadicc/watchbound-node"] = `workspace:${version}`;
    }
    return `${JSON.stringify(manifest, null, 2)}\n`;
  }
  if (relativePath === "Cargo.toml") {
    return replaceExactly(source, /^version = ".*"$/mu, `version = "${version}"`, relativePath);
  }
  if (relativePath === "Cargo.lock") {
    let materialized = source;
    for (const crate of ["watchbound-engine", "watchbound-node"]) {
      materialized = replaceExactly(
        materialized,
        new RegExp(`(name = "${crate}"\\nversion = ")[^"]+(")`, "u"),
        `$1${version}$2`,
        `${relativePath}:${crate}`,
      );
    }
    return materialized;
  }
  if (relativePath === "pnpm-lock.yaml") {
    return replaceExactly(
      source,
      /specifier: workspace:.*$/mu,
      `specifier: workspace:${version}`,
      relativePath,
    );
  }
  throw new Error(`unsupported release version file: ${relativePath}`);
}

function lockedCargoVersion(source, crate) {
  return captureExactly(
    source,
    new RegExp(`\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = "([^"]+)"`, "u"),
  );
}

function captureExactly(source, pattern) {
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  assert.equal(matches.length, 1, `expected exactly one match for ${pattern}`);
  return matches[0][1];
}

function replaceExactly(source, pattern, replacement, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  assert.equal(matches.length, 1, `expected exactly one version field in ${label}`);
  return source.replace(pattern, replacement);
}

function assertVersion(version) {
  assert.match(version ?? "", SEMVER_PATTERN, "invalid release version");
}

function gitPathList(workspaceRoot, args) {
  return captureGit(workspaceRoot, args)
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
}

function captureGit(workspaceRoot, args) {
  const result = spawnSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
