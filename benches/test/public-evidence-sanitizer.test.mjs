import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_INPUT_BYTES,
  SANITIZER_VERSION,
  createSanitizedDerivative,
  parseSanitizerCliArguments,
  reviewSanitizedDerivative,
} from "../../scripts/sanitize-conformance-report.mjs";

const fixturePath = fileURLToPath(
  new URL("../../scripts/test/fixtures/conformance-schema-2-private.synthetic.json", import.meta.url),
);
const fixtureBytes = fs.readFileSync(fixturePath);
const fixtureReport = JSON.parse(fixtureBytes);
const logicalFilename = "conformance-schema-2-private.synthetic.json";
const publicSchemaPath = fileURLToPath(
  new URL("../../docs/schemas/public-conformance-evidence-v1.schema.json", import.meta.url),
);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function manifest(overrides = {}) {
  const entry = {
    logicalFilename,
    sha256: sha256(fixtureBytes),
    byteSize: fixtureBytes.length,
    reportSchemaVersion: 2,
    scenario: "overflow-reconciliation",
    reportStatus: "completed",
    outcome: "fail",
    sourceCommit: fixtureReport.sourceIdentity.gitHead,
    sourceDirty: fixtureReport.sourceIdentity.gitDirty,
    sourceStatusEntryCount: fixtureReport.sourceIdentity.gitStatusEntryCount,
    sourceDigest: fixtureReport.sourceIdentity.sourceSha256,
    nativeArtifactSha256:
      fixtureReport.adapterProbes.watchbound.adapter.metadata.nativeArtifact.sha256,
    classification: "correctness-evidence",
    ...overrides,
  };
  return {
    schemaVersion: 1,
    collection: "synthetic-sanitizer-tests",
    classification: "correctness-evidence",
    artifacts: [entry],
  };
}

test("sanitization is deterministic and records private, source, native, and derivative identity", () => {
  const first = createSanitizedDerivative({
    inputBytes: fixtureBytes,
    manifest: manifest(),
    logicalFilename,
  });
  const second = createSanitizedDerivative({
    inputBytes: fixtureBytes,
    manifest: manifest(),
    logicalFilename,
  });

  assert.equal(first.bytes.equals(second.bytes), true);
  assert.equal(first.publicSha256, second.publicSha256);
  assert.equal(first.publicSha256, sha256(first.bytes));
  assert.equal(first.document.sanitizer.version, SANITIZER_VERSION);
  assert.deepEqual(first.document.privateOriginal, {
    manifestCollection: "synthetic-sanitizer-tests",
    logicalFilename,
    sha256: sha256(fixtureBytes),
    byteSize: fixtureBytes.length,
  });
  assert.deepEqual(first.document.provenance, {
    source: {
      commit: fixtureReport.sourceIdentity.gitHead,
      dirty: true,
      statusEntryCount: 2,
      sha256: fixtureReport.sourceIdentity.sourceSha256,
    },
    nativeArtifact: {
      sha256:
        fixtureReport.adapterProbes.watchbound.adapter.metadata.nativeArtifact.sha256,
    },
  });
});

test("private paths, trial nonces, path-like keys, errors, stacks, timestamps, and host fingerprints are sanitized", () => {
  const { bytes, document } = createSanitizedDerivative({
    inputBytes: fixtureBytes,
    manifest: manifest(),
    logicalFilename,
  });
  const text = bytes.toString("utf8");

  for (const forbidden of [
    "casey-example",
    "/home/casey-example",
    "/var/tmp",
    "nonce-7QZ",
    "Synthetic Confidential CPU",
    "68719476736",
    "2026-01-02T03:04:05.000Z",
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  assert.match(text, /\$WORKSPACE/u);
  assert.match(text, /\$TRIAL_ROOT\/root\/missed\.txt/u);
  assert.match(text, /\$HOME\/\.cache\/watchbound/u);
  assert.equal(
    document.report.results[0].result.observation.pathCounts["$TRIAL_ROOT/root/seen.txt"],
    1,
  );
  assert.equal(
    document.report.results[0].result.observation.pathCounts[
      "$TRIAL_ROOT/root/key-only.txt"
    ],
    1,
  );
  assert.deepEqual(document.report.system, {
    platform: "linux",
    architecture: "x64",
    node: "v24.18.0",
    kernelMajorMinor: "6.8",
    cpuGovernor: "powersave",
    tempFilesystem: {
      path: "$TEMP_ROOT",
      filesystemType: 16914836,
    },
    inotifyLimits: fixtureReport.system.inotifyLimits,
  });
  assert.equal(text.includes('"fd"'), false);
  assert.equal(text.includes('"dirtyPaths"'), false);
  assert.equal(text.includes('"modifiedAt"'), false);
});

test("review proves semantic failure, checks, counters, ordering, coverage, generations, and cleanup remain visible", () => {
  const derivative = createSanitizedDerivative({
    inputBytes: fixtureBytes,
    manifest: manifest(),
    logicalFilename,
  });
  const review = reviewSanitizedDerivative({
    inputBytes: fixtureBytes,
    manifest: manifest(),
    logicalFilename,
    document: derivative.document,
    bytes: derivative.bytes,
    publicSha256: derivative.publicSha256,
  });

  assert.equal(review.approved, true);
  assert.equal(review.checks.every((check) => check.passed), true);
  assert.deepEqual(
    derivative.document.report.results[0].result.checks.map(({ name, passed }) => ({
      name,
      passed,
    })),
    fixtureReport.results[0].result.checks.map(({ name, passed }) => ({ name, passed })),
  );
  assert.equal(derivative.document.resultClassification.outcome, "fail");
  assert.equal(derivative.document.report.results[0].outcome, "fail");
  assert.equal(derivative.document.report.aggregates[0].failed, 1);
  assert.equal(derivative.document.report.aggregates[0].performanceRuns, 0);
  assert.equal(
    derivative.document.report.aggregates[0].performanceSamplePolicy,
    "pass-only",
  );
  assert.deepEqual(
    derivative.document.report.results[0].result.observation.sequences,
    ["41", "42", "43"],
  );
  assert.deepEqual(
    derivative.document.report.results[0].result.observation.coverageStates,
    ["complete", "uncertain", "complete"],
  );
  assert.equal(
    derivative.document.report.results[0].result.reconciliation.exclusionGeneration,
    "1",
  );
  assert.deepEqual(
    derivative.document.report.results[0].result.cleanup.inotifyAfter,
    { instances: 0, supported: true, watches: 0 },
  );
});

test("sanitizer fails closed for unsupported schemas, unknown path fields, identity mismatches, and bounds", () => {
  const unsupported = structuredClone(fixtureReport);
  unsupported.schemaVersion = 3;
  assert.throws(
    () => createSanitizedDerivative({
      inputBytes: Buffer.from(JSON.stringify(unsupported)),
      manifest: manifest({ reportSchemaVersion: 3 }),
      logicalFilename,
    }),
    /unsupported report schema/iu,
  );

  const unknownPath = structuredClone(fixtureReport);
  unknownPath.results[0].result.observation.unreviewedArtifactPath =
    "/home/casey-example/private/new-field.txt";
  const unknownBytes = Buffer.from(JSON.stringify(unknownPath));
  assert.throws(
    () => createSanitizedDerivative({
      inputBytes: unknownBytes,
      manifest: manifest({ sha256: sha256(unknownBytes), byteSize: unknownBytes.length }),
      logicalFilename,
    }),
    /unknown path-bearing field/iu,
  );

  const unapprovedAbsolute = structuredClone(fixtureReport);
  unapprovedAbsolute.results[0].result.diagnostics.stderr =
    "synthetic foreign location /srv/unapproved/private.txt";
  const unapprovedBytes = Buffer.from(JSON.stringify(unapprovedAbsolute));
  assert.throws(
    () => createSanitizedDerivative({
      inputBytes: unapprovedBytes,
      manifest: manifest({
        sha256: sha256(unapprovedBytes),
        byteSize: unapprovedBytes.length,
      }),
      logicalFilename,
    }),
    /unapproved absolute path/iu,
  );

  const hostIdentity = structuredClone(fixtureReport);
  hostIdentity.results[0].result.diagnostics.hostName = "private-builder-7";
  const hostIdentityBytes = Buffer.from(JSON.stringify(hostIdentity));
  assert.throws(
    () => createSanitizedDerivative({
      inputBytes: hostIdentityBytes,
      manifest: manifest({
        sha256: sha256(hostIdentityBytes),
        byteSize: hostIdentityBytes.length,
      }),
      logicalFilename,
    }),
    /host-identifying field/iu,
  );

  const hostAddress = structuredClone(fixtureReport);
  hostAddress.results[0].result.diagnostics.stderr = "builder address 192.0.2.44";
  const hostAddressBytes = Buffer.from(JSON.stringify(hostAddress));
  assert.throws(
    () => createSanitizedDerivative({
      inputBytes: hostAddressBytes,
      manifest: manifest({
        sha256: sha256(hostAddressBytes),
        byteSize: hostAddressBytes.length,
      }),
      logicalFilename,
    }),
    /host-identifying address/iu,
  );

  const tooDeep = structuredClone(fixtureReport);
  let cursor = tooDeep.results[0].result;
  for (let depth = 0; depth < 40; depth += 1) {
    cursor.nested = {};
    cursor = cursor.nested;
  }
  const tooDeepBytes = Buffer.from(JSON.stringify(tooDeep));
  assert.throws(
    () => createSanitizedDerivative({
      inputBytes: tooDeepBytes,
      manifest: manifest({ sha256: sha256(tooDeepBytes), byteSize: tooDeepBytes.length }),
      logicalFilename,
    }),
    /depth bound/iu,
  );

  assert.throws(
    () => createSanitizedDerivative({
      inputBytes: fixtureBytes,
      manifest: manifest({ nativeArtifactSha256: "f".repeat(64) }),
      logicalFilename,
    }),
    /native artifact identity/iu,
  );
  assert.throws(
    () => createSanitizedDerivative({
      inputBytes: Buffer.alloc(MAX_INPUT_BYTES + 1, 0x20),
      manifest: manifest(),
      logicalFilename,
    }),
    /input exceeds/iu,
  );
});

test("review rejects tampering and failed trials admitted to pass-only performance samples", () => {
  const derivative = createSanitizedDerivative({
    inputBytes: fixtureBytes,
    manifest: manifest(),
    logicalFilename,
  });
  const tampered = structuredClone(derivative.document);
  tampered.report.aggregates[0].performanceRuns = 1;
  const tamperedBytes = Buffer.from(`${JSON.stringify(tampered)}\n`);
  const review = reviewSanitizedDerivative({
    inputBytes: fixtureBytes,
    manifest: manifest(),
    logicalFilename,
    document: tampered,
    bytes: tamperedBytes,
    publicSha256: sha256(tamperedBytes),
  });

  assert.equal(review.approved, false);
  assert.equal(
    review.checks.some(
      ({ name, passed }) => name === "retained-report-byte-equivalence" && !passed,
    ),
    true,
  );
  assert.equal(
    review.checks.some(
      ({ name, passed }) => name === "failed-trials-excluded-from-performance" && !passed,
    ),
    true,
  );
});

test("the public schema identity matches the implementation and the CLI requires explicit approval", () => {
  const publicSchema = JSON.parse(fs.readFileSync(publicSchemaPath, "utf8"));
  assert.equal(
    publicSchema.$id,
    "urn:watchbound:schema:public-conformance-evidence:1",
  );
  assert.equal(publicSchema.properties.sanitizer.properties.version.const, SANITIZER_VERSION);

  assert.throws(
    () => parseSanitizerCliArguments([
      "--input",
      "does-not-exist.json",
      "--manifest",
      "does-not-exist.json",
      "--logical-filename",
      logicalFilename,
      "--output",
      "benches/evidence/should-not-exist.json",
      "--reviewed-by",
      "Synthetic Reviewer",
    ]),
    /Missing required option --approved-private-sha256/u,
  );
});
