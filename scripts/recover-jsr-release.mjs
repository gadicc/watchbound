import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { installExactJsrNative } from "./install-jsr-native.mjs";

const allowedOptions = new Set([
  "approved-native",
  "controller-sha",
  "native-sha256",
  "native-tarball-sha256",
  "original-evidence",
  "publish",
  "recovery-output",
  "release-plan",
  "run-attempt",
  "run-id",
  "source-sha",
  "version",
  "workspace",
  "wrapper-tarball-sha256",
]);
const options = parseArguments(process.argv.slice(2));
const workspace = path.resolve(requiredOption("workspace"));
const approvedNativeRoot = path.resolve(requiredOption("approved-native"));
const originalEvidenceRoot = path.resolve(requiredOption("original-evidence"));
const releasePlanPath = path.resolve(requiredOption("release-plan"));
const recoveryOutput = path.resolve(requiredOption("recovery-output"));
const version = requiredOption("version");
const sourceSha = requiredOption("source-sha");
const controllerSha = requiredOption("controller-sha");
const originalRunId = requiredOption("run-id");
const originalRunAttempt = requiredOption("run-attempt");
const expectedNativeSha256 = requiredDigest("native-sha256");
const expectedNativeTarballSha256 = requiredDigest("native-tarball-sha256");
const expectedWrapperTarballSha256 = requiredDigest("wrapper-tarball-sha256");
const shouldPublish = options.has("publish");
const tag = `v${version}`;
const nativeFilename = "watchbound.linux-x64-gnu.node";
const approvedNative = path.join(approvedNativeRoot, nativeFilename);
const independentEvidence = path.join(
  approvedNativeRoot,
  "independent-reproducibility.json",
);
const sameRunnerEvidence = path.join(
  originalEvidenceRoot,
  "same-runner-reproducibility.json",
);
const originalPublicationLedger = path.join(
  originalEvidenceRoot,
  "publication-ledger.json",
);
const jsrRoot = path.join(workspace, "dist/jsr");
const nativeTarball = path.join(
  workspace,
  "dist/tarballs",
  `gadicc-watchbound-node-${version}.tgz`,
);
const wrapperTarball = path.join(
  workspace,
  "dist/tarballs",
  `watchbound-${version}.tgz`,
);
const recoveryEvidenceRoot = path.join(workspace, "dist/evidence");
const jsrSpecifier = `jsr:@gadicc/watchbound@${version}`;
const recoveryLedger = {
  schemaVersion: 1,
  kind: "watchbound-jsr-recovery-ledger",
  version,
  sourceSha,
  tag,
  recoveryControllerSha: controllerSha,
  originalWorkflow: {
    runId: originalRunId,
    runAttempt: originalRunAttempt,
  },
  mode: shouldPublish ? "publish" : "dry-run",
  startedAt: new Date().toISOString(),
  operations: [],
};

try {
  validateIdentity();
  recordOperation("release-identity", "verified");
  validateOriginalEvidence();
  recordOperation("original-release-evidence", "verified");

  fs.copyFileSync(
    approvedNative,
    path.join(workspace, "node", nativeFilename),
  );
  run(
    "pnpm",
    ["test:packages"],
    workspace,
    {
      WATCHBOUND_INDEPENDENT_REPRODUCIBILITY: independentEvidence,
      WATCHBOUND_REPRODUCIBLE_OUTPUT: sameRunnerEvidence,
    },
  );
  validatePreparedArtifacts();
  recordOperation("exact-package-reconstruction", "verified");

  verifyExistingNpmPackage(
    "@gadicc/watchbound-node",
    path.join(workspace, "dist/npm/node/package.json"),
    nativeTarball,
  );
  recordOperation("npm-native", "verified-existing");
  verifyExistingNpmPackage(
    "watchbound",
    path.join(workspace, "dist/npm/wrapper/package.json"),
    wrapperTarball,
  );
  recordOperation("npm-wrapper", "verified-existing");

  installExactJsrNative(run, jsrRoot, nativeTarball);
  run(
    "deno",
    ["publish", "--dry-run", "--allow-dirty", "--no-check"],
    jsrRoot,
  );
  recordOperation("jsr-publish-dry-run", "verified");

  const jsrAlreadyExists = packageExistsOnJsr();
  if (jsrAlreadyExists) {
    recordOperation("jsr-wrapper", "verified-existing");
  } else if (shouldPublish) {
    run("deno", ["publish", "--no-check"], jsrRoot);
    recordOperation("jsr-wrapper", "published-verification-pending");
    if (!await waitForJsrPackage()) {
      throw new Error(`${jsrSpecifier} was not visible after publication`);
    }
    recordOperation("jsr-wrapper", "verified-published");
  } else {
    recordOperation("jsr-wrapper", "ready-to-publish");
  }

  if (shouldPublish || jsrAlreadyExists) {
    const smokeEvidence = path.join(
      recoveryEvidenceRoot,
      "jsr-registry-smoke.json",
    );
    run(
      process.execPath,
      [
        "scripts/check-registry-packages.mjs",
        "--route",
        "jsr-node",
        "--version",
        version,
        "--native-sha256",
        expectedNativeSha256,
        "--evidence",
        smokeEvidence,
      ],
      workspace,
    );
    recordOperation("jsr-registry-smoke", "verified");
  }

  recoveryLedger.finishedAt = new Date().toISOString();
  recoveryLedger.status = shouldPublish || jsrAlreadyExists
    ? "completed"
    : "ready";
  writeRecoveryLedger();
  process.stdout.write(
    shouldPublish || jsrAlreadyExists
      ? `Verified recovered ${jsrSpecifier}\n`
      : `Recovery dry run is ready for ${jsrSpecifier}\n`,
  );
} catch (error) {
  recoveryLedger.finishedAt = new Date().toISOString();
  recoveryLedger.status = "failed";
  recoveryLedger.error = {
    name: error?.name ?? null,
    message: error?.message ?? String(error),
  };
  writeJson(recoveryOutput, recoveryLedger);
  if (fs.existsSync(recoveryEvidenceRoot)) {
    preserveOriginalPublicationLedger();
    writeJson(
      path.join(recoveryEvidenceRoot, "jsr-recovery-ledger.json"),
      recoveryLedger,
    );
  }
  throw error;
}

function validateIdentity() {
  assert.match(sourceSha, /^[0-9a-f]{40}$/u);
  assert.match(controllerSha, /^[0-9a-f]{40}$/u);
  assert.equal(capture("git", ["rev-parse", "HEAD"], workspace), sourceSha);
  assert.equal(
    capture("git", ["rev-parse", `refs/tags/${tag}^{}`], workspace),
    sourceSha,
  );
  assert.equal(
    capture(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      workspace,
    ),
    "",
  );

  for (const manifestPath of [
    "package.json",
    "js/package.json",
    "node/package.json",
  ]) {
    assert.equal(readJson(path.join(workspace, manifestPath)).version, version);
  }
  assert.equal(
    readJson(path.join(workspace, "js/package.json"))
      .dependencies?.["@gadicc/watchbound-node"],
    `workspace:${version}`,
  );

  const plan = readJson(releasePlanPath);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.kind, "watchbound-release-plan");
  assert.equal(plan.mode, "release");
  assert.equal(plan.qualify, true);
  assert.equal(plan.willRelease, true);
  assert.equal(plan.version, version);
  assert.equal(plan.sourceSha, sourceSha);
  assert.equal(plan.tag, tag);
}

function validateOriginalEvidence() {
  assert.equal(sha256(approvedNative), expectedNativeSha256);

  const independent = readJson(independentEvidence);
  assert.equal(independent.schemaVersion, 1);
  assert.equal(
    independent.kind,
    "watchbound-independent-native-comparison",
  );
  assert.equal(independent.sourceSha, sourceSha);
  assert.equal(independent.version, version);
  assert.equal(independent.byteIdentical, true);
  assert.equal(independent.sha256, expectedNativeSha256);
  assert.equal(independent.builders?.length, 2);
  for (const builder of independent.builders) {
    assert.equal(builder.runner?.runId, originalRunId);
    assert.equal(builder.runner?.runAttempt, originalRunAttempt);
  }

  const sameRunner = readJson(sameRunnerEvidence);
  assert.equal(sameRunner.schemaVersion, 1);
  assert.equal(sameRunner.kind, "watchbound-same-runner-reproducibility");
  assert.equal(sameRunner.sourceSha, sourceSha);
  assert.equal(sameRunner.version, version);
  assert.equal(sameRunner.expectedSha256, expectedNativeSha256);
  assert.equal(sameRunner.byteIdentical, true);
  assert.deepEqual(
    sameRunner.builds?.map(({ sha256: digest }) => digest),
    [expectedNativeSha256, expectedNativeSha256],
  );

  const metadata = readJson(
    path.join(originalEvidenceRoot, "release-metadata.json"),
  );
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.package, "watchbound");
  assert.equal(metadata.version, version);
  assert.equal(metadata.commit, sourceSha);
  assert.equal(
    metadata.reproducibility?.independent?.sha256,
    expectedNativeSha256,
  );
  assertArtifactDigest(
    metadata,
    nativeFilename,
    expectedNativeSha256,
  );
  assertArtifactDigest(
    metadata,
    path.basename(nativeTarball),
    expectedNativeTarballSha256,
  );
  assertArtifactDigest(
    metadata,
    path.basename(wrapperTarball),
    expectedWrapperTarballSha256,
  );

  const sums = fs.readFileSync(
    path.join(originalEvidenceRoot, "SHA256SUMS"),
    "utf8",
  );
  for (const [filename, digest] of [
    [nativeFilename, expectedNativeSha256],
    [path.basename(nativeTarball), expectedNativeTarballSha256],
    [path.basename(wrapperTarball), expectedWrapperTarballSha256],
  ]) {
    assert.match(
      sums,
      new RegExp(`^${digest}  ${escapeRegExp(filename)}$`, "mu"),
    );
  }

  const originalLedger = readJson(originalPublicationLedger);
  assert.equal(originalLedger.schemaVersion, 1);
  assert.equal(originalLedger.kind, "watchbound-publication-ledger");
  assert.equal(originalLedger.version, version);
  assert.equal(originalLedger.sourceSha, sourceSha);
  assert.equal(originalLedger.status, "failed");
  assert.equal(
    latestOperationStatus(originalLedger, "npm-native"),
    "verified-published",
  );
  assert.equal(
    latestOperationStatus(originalLedger, "npm-wrapper"),
    "verified-published",
  );
  assert.equal(
    originalLedger.operations.some(
      ({ operation }) => operation === "jsr-wrapper",
    ),
    false,
  );
  assert.match(originalLedger.error?.message ?? "", /\bdeno\b/iu);
}

function validatePreparedArtifacts() {
  assert.equal(sha256(nativeTarball), expectedNativeTarballSha256);
  assert.equal(sha256(wrapperTarball), expectedWrapperTarballSha256);
  assert.equal(
    sha256(path.join(workspace, "dist/npm/node", nativeFilename)),
    expectedNativeSha256,
  );
}

function verifyExistingNpmPackage(name, manifestPath, tarball) {
  const manifest = readJson(manifestPath);
  const state = JSON.parse(
    capture("npm", ["view", `${name}@${version}`, "--json"], workspace),
  );
  assert.equal(state.name, manifest.name);
  assert.equal(state.version, version);
  assert.equal(state.dist?.integrity, sha512Integrity(tarball));
  assert.deepEqual(state.dependencies ?? {}, manifest.dependencies ?? {});
}

function packageExistsOnJsr() {
  const result = spawnSync("deno", ["info", jsrSpecifier], {
    cwd: workspace,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  const output = `${result.stdout}\n${result.stderr}`;
  if (/\b404\b|not found|could not find|does not exist/iu.test(output)) {
    return false;
  }
  throw new Error(
    `could not determine whether ${jsrSpecifier} exists:\n${output.trim()}`,
  );
}

async function waitForJsrPackage() {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    if (packageExistsOnJsr()) return true;
    await delay(3_000);
  }
  return false;
}

function assertArtifactDigest(metadata, filename, expected) {
  const artifact = metadata.artifacts?.find(
    ({ path: artifactPath }) => path.basename(artifactPath) === filename,
  );
  assert.ok(artifact, `release metadata is missing ${filename}`);
  assert.equal(artifact.sha256, expected);
}

function latestOperationStatus(ledger, operation) {
  return ledger.operations
    .filter((entry) => entry.operation === operation)
    .at(-1)?.status;
}

function recordOperation(operation, status) {
  recoveryLedger.operations.push({
    operation,
    status,
    at: new Date().toISOString(),
  });
  writeJson(recoveryOutput, recoveryLedger);
}

function writeRecoveryLedger() {
  fs.mkdirSync(recoveryEvidenceRoot, { recursive: true });
  preserveOriginalPublicationLedger();
  writeJson(
    path.join(recoveryEvidenceRoot, "jsr-recovery-ledger.json"),
    recoveryLedger,
  );
  writeJson(recoveryOutput, recoveryLedger);
}

function preserveOriginalPublicationLedger() {
  if (!fs.existsSync(originalPublicationLedger)) return;
  fs.copyFileSync(
    originalPublicationLedger,
    path.join(recoveryEvidenceRoot, "original-publication-ledger.json"),
  );
}

function parseArguments(args) {
  const parsed = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    assert.match(argument, /^--[a-z][a-z0-9-]*$/u);
    const name = argument.slice(2);
    assert.equal(
      allowedOptions.has(name),
      true,
      `unknown option ${argument}`,
    );
    if (name === "publish") {
      parsed.set(name, true);
      continue;
    }
    const value = args[index + 1];
    assert.ok(value && !value.startsWith("--"), `missing value for ${argument}`);
    assert.equal(parsed.has(name), false, `duplicate option ${argument}`);
    parsed.set(name, value);
    index += 1;
  }
  return parsed;
}

function requiredOption(name) {
  const value = options.get(name);
  assert.equal(typeof value, "string", `missing --${name}`);
  return value;
}

function requiredDigest(name) {
  const value = requiredOption(name);
  assert.match(value, /^[0-9a-f]{64}$/u, `invalid --${name}`);
  return value;
}

function run(command, args, cwd, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnvironment,
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with status ${result.status}:\n` +
        `${result.stdout}\n${result.stderr}`.trim(),
    );
  }
  return result.stdout.trim();
}

function sha256(source) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(source))
    .digest("hex");
}

function sha512Integrity(source) {
  return `sha512-${crypto
    .createHash("sha512")
    .update(fs.readFileSync(source))
    .digest("base64")}`;
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function writeJson(destination, value) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
