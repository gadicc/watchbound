import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  jsrPackageExists,
  prepare,
  publish,
} from "./semantic-release-watchbound.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const release = {
  version: "1.0.1",
  tag: "v1.0.1",
  sourceSha: "744cd8f8d5de4301e148f08e9f3adba230629fd5",
  originalRunId: "30116055532",
};
const planPath = requiredPath("WATCHBOUND_ORIGINAL_RELEASE_PLAN");
const nativePath = requiredPath("WATCHBOUND_CANONICAL_NATIVE_PATH");
const independentPath = requiredPath(
  "WATCHBOUND_INDEPENDENT_REPRODUCIBILITY",
);
const originalLedgerPath = requiredPath(
  "WATCHBOUND_ORIGINAL_PUBLICATION_LEDGER",
);
const expectedNativeSha256 = requiredEnvironment(
  "WATCHBOUND_EXPECTED_NATIVE_SHA256",
);
const nextRelease = {
  version: release.version,
  channel: null,
};

assert.equal(
  requiredEnvironment("WATCHBOUND_PLANNED_VERSION"),
  release.version,
);
assert.equal(capture("git", ["rev-parse", `${release.tag}^{commit}`]), release.sourceSha);

const plan = readJson(planPath);
assert.equal(plan.kind, "watchbound-release-plan");
assert.equal(plan.mode, "release");
assert.equal(plan.willRelease, true);
assert.equal(plan.version, release.version);
assert.equal(plan.tag, release.tag);
assert.equal(plan.sourceSha, release.sourceSha);

const independent = readJson(independentPath);
assert.equal(independent.kind, "watchbound-independent-native-comparison");
assert.equal(independent.sourceSha, release.sourceSha);
assert.equal(independent.version, release.version);
assert.equal(independent.sha256, expectedNativeSha256);
assert.equal(independent.byteIdentical, true);
assert.equal(independent.builders?.length, 2);
for (const builder of independent.builders) {
  assert.equal(builder.source?.gitHead, release.sourceSha);
  assert.equal(builder.artifact?.sha256, expectedNativeSha256);
}
assert.equal(sha256(nativePath), expectedNativeSha256);

const originalLedger = readJson(originalLedgerPath);
assert.equal(originalLedger.kind, "watchbound-publication-ledger");
assert.equal(originalLedger.version, release.version);
assert.equal(originalLedger.sourceSha, release.sourceSha);
assert.equal(originalLedger.status, "failed");
assert.deepEqual(
  originalLedger.operations.map(({ operation, status }) => ({
    operation,
    status,
  })),
  [
    {
      operation: "npm-native",
      status: "published-verification-pending",
    },
    {
      operation: "npm-native",
      status: "verified-published",
    },
    {
      operation: "npm-wrapper",
      status: "published-verification-pending",
    },
    {
      operation: "npm-wrapper",
      status: "verified-published",
    },
  ],
);

const jsrSpecifier = `jsr:@gadicc/watchbound@${release.version}`;
const jsrExistedBeforeRecovery = await jsrPackageExists(jsrSpecifier);

if (process.env.WATCHBOUND_RECOVERY_VALIDATE_ONLY === "1") {
  process.stdout.write(
    `Validated recovery evidence for ${jsrSpecifier} from ${release.tag}\n`,
  );
} else {
  await recover(jsrSpecifier, jsrExistedBeforeRecovery);
}

async function recover(specifier, existedBeforeRecovery) {
  prepare({}, { nextRelease });
  await publish({}, { nextRelease });

  const recoveredLedgerPath = path.join(
    workspaceRoot,
    "dist",
    "evidence",
    "publication-ledger.json",
  );
  const recoveredLedger = readJson(recoveredLedgerPath);
  assert.equal(recoveredLedger.status, "completed");
  assert.equal(recoveredLedger.version, release.version);
  assert.deepEqual(
    recoveredLedger.operations.map(({ operation, status }) => ({
      operation,
      status,
    })),
    [
      {
        operation: "npm-native",
        status: "verified-existing",
      },
      {
        operation: "npm-wrapper",
        status: "verified-existing",
      },
      {
        operation: "jsr-wrapper",
        status: existedBeforeRecovery
          ? "verified-existing"
          : "verified-published",
      },
    ],
  );
  assert.equal(await jsrPackageExists(specifier), true);

  recoveredLedger.recovery = {
    kind: "watchbound-jsr-v1.0.1-recovery",
    controllerSha: capture("git", ["rev-parse", "HEAD"]),
    releaseSourceSha: release.sourceSha,
    originalRunId: release.originalRunId,
    originalPublicationLedgerSha256: sha256(originalLedgerPath),
    originalReleasePlanSha256: sha256(planPath),
    recoveredAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    recoveredLedgerPath,
    `${JSON.stringify(recoveredLedger, null, 2)}\n`,
  );

  process.stdout.write(
    `Recovered and verified ${specifier} from ${release.tag}\n`,
  );
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
}

function requiredPath(name) {
  const value = path.resolve(requiredEnvironment(name));
  assert.ok(fs.statSync(value).isFile(), `${name} must name a file`);
  return value;
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function sha256(source) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(source))
    .digest("hex");
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}
