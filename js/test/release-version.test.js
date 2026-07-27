import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SOURCE_VERSION,
  VERSION_FILES,
  assertCommittedSourceVersion,
  assertWorkspaceVersion,
  materializeReleaseCandidate,
  verifyReleaseCandidate,
} from "../../scripts/lib/release-version.mjs";
import { verifyPublishPreconditions } from "../../scripts/semantic-release-watchbound.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("committed workspace versions are permanent development placeholders", () => {
  assert.equal(SOURCE_VERSION, "0.0.0-development");
  if (process.env.WATCHBOUND_CANDIDATE_VERSION) {
    assertCommittedSourceVersion(workspaceRoot);
    assertWorkspaceVersion(workspaceRoot, process.env.WATCHBOUND_CANDIDATE_VERSION);
  } else {
    assertWorkspaceVersion(workspaceRoot, SOURCE_VERSION);
  }
});

test("semantic-release publish preflight validates the exact generated candidate", () => {
  const fixture = createFixture();
  const version = "9.8.7";
  const previousPlannedVersion = process.env.WATCHBOUND_PLANNED_VERSION;
  try {
    const sourceSha = capture(fixture, "git", ["rev-parse", "HEAD"]);
    materializeReleaseCandidate(fixture, { sourceSha, version });
    process.env.WATCHBOUND_PLANNED_VERSION = version;
    const candidate = verifyPublishPreconditions(version, fixture);
    assert.equal(candidate.kind, "watchbound-materialized-release-candidate");
    assert.equal(candidate.sourceVersion, SOURCE_VERSION);
    assert.equal(candidate.version, version);
  } finally {
    if (previousPlannedVersion === undefined) {
      delete process.env.WATCHBOUND_PLANNED_VERSION;
    } else {
      process.env.WATCHBOUND_PLANNED_VERSION = previousPlannedVersion;
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("release versions are deterministic generated candidates", () => {
  const fixture = createFixture();
  try {
    const sourceSha = capture(fixture, "git", ["rev-parse", "HEAD"]);
    const candidate = materializeReleaseCandidate(fixture, {
      sourceSha,
      version: "9.8.7",
    });

    assert.equal(candidate.schemaVersion, 1);
    assert.equal(candidate.kind, "watchbound-materialized-release-candidate");
    assert.equal(candidate.sourceSha, sourceSha);
    assert.equal(candidate.sourceVersion, SOURCE_VERSION);
    assert.equal(candidate.version, "9.8.7");
    assert.equal(candidate.gitDirty, true);
    assert.deepEqual(
      candidate.files.map(({ path: relativePath }) => relativePath),
      VERSION_FILES,
    );
    assertWorkspaceVersion(fixture, "9.8.7");
    assert.deepEqual(
      verifyReleaseCandidate(fixture, { sourceSha, version: "9.8.7" }),
      candidate,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("generated candidates reject any mutation outside the version transform", () => {
  const fixture = createFixture();
  try {
    const sourceSha = capture(fixture, "git", ["rev-parse", "HEAD"]);
    materializeReleaseCandidate(fixture, { sourceSha, version: "9.8.7" });
    fs.appendFileSync(path.join(fixture, "package.json"), "\n");
    assert.throws(
      () => verifyReleaseCandidate(fixture, { sourceSha, version: "9.8.7" }),
      /materialized candidate differs/iu,
    );

    fs.writeFileSync(
      path.join(fixture, "package.json"),
      `${JSON.stringify({
        ...JSON.parse(capture(fixture, "git", ["show", "HEAD:package.json"])),
        version: "9.8.7",
      }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(fixture, "unexpected.txt"), "unexpected\n");
    assert.throws(
      () => verifyReleaseCandidate(fixture, { sourceSha, version: "9.8.7" }),
      /untracked files/iu,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function createFixture() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-release-version-"));
  const fixtureFiles = [...VERSION_FILES, "config/native-matrix.json"];
  for (const relativePath of fixtureFiles) {
    const destination = path.join(fixture, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const source = process.env.WATCHBOUND_CANDIDATE_VERSION
      ? captureRaw(workspaceRoot, "git", ["show", `HEAD:${relativePath}`])
      : fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
    fs.writeFileSync(destination, source);
  }
  run(fixture, "git", ["init", "--quiet"]);
  run(fixture, "git", ["add", ...fixtureFiles]);
  run(fixture, "git", [
    "-c",
    "user.name=Watchbound Test",
    "-c",
    "user.email=watchbound@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "test: source placeholder",
  ]);
  return fixture;
}

function capture(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function captureRaw(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
}
