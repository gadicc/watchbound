import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installExactJsrNative } from "./install-jsr-native.mjs";
import { jsrPackageExists } from "./semantic-release-watchbound.mjs";

const controllerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const RECOVERY = Object.freeze({
  version: "1.1.0",
  tag: "v1.1.0",
  sourceSha: "9f207599f828ba8a4d5a3f7c1033745cea7e47ff",
  originalRunId: "30248771665",
  originalRunAttempt: 1,
  confirmation: "RECOVER_JSR_1_1_0_FROM_RUN_30248771665",
});

const ALLOWED_CONTROLLER_DELTA = Object.freeze([
  ".github/workflows/recover-jsr-v1-1-0.yml",
  "docs/release-incident-response.md",
  "js/test/package-contract.test.js",
  "scripts/recover-jsr-v1-1-0.mjs",
  "scripts/semantic-release-watchbound.mjs",
]);

const EXPECTED_NATIVE = Object.freeze({
  "linux-x64-gnu": Object.freeze({
    binary: "watchbound.linux-x64-gnu.node",
    sha256: "a58f01eb09ae8f5c7a2c2a06bf97ea88fd7c5a9371611cc3dff461b7680648d9",
    bytes: 1_406_728,
  }),
  "linux-arm64-gnu": Object.freeze({
    binary: "watchbound.linux-arm64-gnu.node",
    sha256: "fc89bb178304c20315b5a74a0e531fbe066c55791288ddcdf4d418e2e6bbd33b",
    bytes: 1_214_176,
  }),
});

const EXPECTED_PACKAGES = Object.freeze({
  "@gadicc/watchbound-node-linux-x64-gnu": Object.freeze({
    filename: "gadicc-watchbound-node-linux-x64-gnu-1.1.0.tgz",
    sha256: "ab322b0118ef9b3937f3a30c4556e608ddbf75dd8c74334c1cc74f651d50d2d9",
    integrity:
      "sha512-57RbiAXwt9JkjceHUm07bveSd+U8COpQyof9+dwrgGjUjTNkZqPacK3Z80BQEXdvWFv6ilbpgU1cu4yvkDLpPw==",
  }),
  "@gadicc/watchbound-node-linux-arm64-gnu": Object.freeze({
    filename: "gadicc-watchbound-node-linux-arm64-gnu-1.1.0.tgz",
    sha256: "7f3f2b9e4cb7138a1565f7bb301b98ec911172a6d0a7c655ac9e6436789866eb",
    integrity:
      "sha512-f9rvGOjbSO33jiBN8yQHSOJuBuuySH9J7aWCIAFwirEWeS301Skl2pDIFAR2FmO79gUVkLKmjhSChPRgy4ek7w==",
  }),
  "@gadicc/watchbound-node": Object.freeze({
    filename: "gadicc-watchbound-node-1.1.0.tgz",
    sha256: "2dcbba9c3492a405cfaf5adc80c89faea53b18a10323a9ea9a2393854732c3e9",
    integrity:
      "sha512-2fpaPB0RkD8TTmdaqrpFPxgTuydoMchTFmG8m/fFW8khxX9FAA4qNLVXyScXb72O/91zuQIvtw4d8BQ9Fw98dg==",
  }),
  watchbound: Object.freeze({
    filename: "watchbound-1.1.0.tgz",
    sha256: "4b2c187947323ba6a5d77ef463528f4ab48891cdbe2b92193e825b94cb909b71",
    integrity:
      "sha512-PnsFQ/nxZdQtwCy5mdCG8URk8sorOSE6XE2+RjVNPrqAi/UZF3orrgFVlBUuXY1VGGQhYuBWKVOymw3a6ymqcA==",
  }),
});

const EXPECTED_ORIGINAL_OPERATIONS = Object.freeze([
  ["npm:@gadicc/watchbound-node-linux-x64-gnu", "published-verification-pending"],
  ["npm:@gadicc/watchbound-node-linux-x64-gnu", "verified-published"],
  ["npm:@gadicc/watchbound-node-linux-arm64-gnu", "published-verification-pending"],
  ["npm:@gadicc/watchbound-node-linux-arm64-gnu", "verified-published"],
  ["npm:@gadicc/watchbound-node", "published-verification-pending"],
  ["npm:@gadicc/watchbound-node", "verified-published"],
  ["npm:watchbound", "published-verification-pending"],
  ["npm:watchbound", "verified-published"],
]);

export async function main() {
  const validateOnly = process.env.WATCHBOUND_RECOVERY_VALIDATE_ONLY === "1";
  const prepareOnly = process.env.WATCHBOUND_RECOVERY_PREPARE_ONLY === "1";
  const registryOnly =
    process.env.WATCHBOUND_RECOVERY_VERIFY_REGISTRY_ONLY === "1";
  assert.ok(
    [validateOnly, prepareOnly, registryOnly].filter(Boolean).length <= 1,
    "choose at most one recovery validation mode",
  );

  const releaseRoot = requiredDirectory("WATCHBOUND_RELEASE_SOURCE_ROOT");
  const planPath = requiredFile("WATCHBOUND_ORIGINAL_RELEASE_PLAN");
  const approvedRoot = requiredDirectory("WATCHBOUND_APPROVED_NATIVE_DIR");
  const originalEvidenceRoot = requiredDirectory(
    "WATCHBOUND_ORIGINAL_RELEASE_EVIDENCE_DIR",
  );

  const controllerSha = validateOnly
    ? process.env.WATCHBOUND_RECOVERY_CONTROLLER_SHA ??
      capture(controllerRoot, "git", ["rev-parse", "HEAD"])
    : requiredEnvironment("WATCHBOUND_RECOVERY_CONTROLLER_SHA");

  validateController(controllerSha, validateOnly || prepareOnly || registryOnly);
  validateReleaseSource(releaseRoot);
  const plan = validateReleasePlan(planPath);
  const comparison = validateApprovedNativeMatrix(approvedRoot, plan);
  const originalLedgerPath = path.join(
    originalEvidenceRoot,
    "publication-ledger.json",
  );
  const originalLedger = validateOriginalEvidence(
    originalEvidenceRoot,
    originalLedgerPath,
  );

  if (validateOnly) {
    process.stdout.write(
      `Validated immutable recovery inputs for ${RECOVERY.tag} from run ${RECOVERY.originalRunId}\n`,
    );
    return;
  }

  process.env.WATCHBOUND_PLANNED_VERSION = RECOVERY.version;
  run(releaseRoot, "pnpm", ["install", "--frozen-lockfile"]);
  run(releaseRoot, process.execPath, [
    "scripts/set-release-version.mjs",
    RECOVERY.version,
  ]);
  const releasePlugin = await import(
    pathToFileURL(
      path.join(releaseRoot, "scripts/semantic-release-watchbound.mjs"),
    ).href
  );
  const candidate = releasePlugin.verifyPublishPreconditions(
    RECOVERY.version,
    releaseRoot,
  );
  assert.deepEqual(candidate, comparison.candidate);

  const currentNative = EXPECTED_NATIVE["linux-x64-gnu"];
  const currentNativeSource = path.join(approvedRoot, currentNative.binary);
  const currentNativeDestination = path.join(
    releaseRoot,
    "node",
    currentNative.binary,
  );
  fs.copyFileSync(currentNativeSource, currentNativeDestination);
  assert.equal(sha256(currentNativeDestination), currentNative.sha256);
  process.env.WATCHBOUND_NATIVE_ARTIFACTS_DIR = approvedRoot;
  process.env.WATCHBOUND_REQUIRE_ALL_TARGETS = "1";
  process.env.WATCHBOUND_INDEPENDENT_REPRODUCIBILITY = path.join(
    approvedRoot,
    "independent-reproducibility.json",
  );
  process.env.WATCHBOUND_EXPECTED_NATIVE_SHA256 = currentNative.sha256;
  delete process.env.WATCHBOUND_REPRODUCIBLE_OUTPUT;
  run(releaseRoot, "pnpm", ["test:packages"]);

  const packages = releasePackages(releaseRoot);
  validatePreparedPackages(packages);
  if (prepareOnly) {
    process.stdout.write(
      `Prepared exact ${RECOVERY.tag} package artifacts without registry mutation\n`,
    );
    return;
  }

  if (registryOnly) {
    await verifyExistingNpmPackages(packages, releaseRoot);
    const jsrExists = await jsrPackageExists(
      `jsr:@gadicc/watchbound@${RECOVERY.version}`,
    );
    process.stdout.write(
      `Verified exact npm registry state; JSR ${RECOVERY.version} is ${jsrExists ? "already present" : "still missing"}\n`,
    );
    return;
  }

  const ledger = {
    schemaVersion: 2,
    kind: "watchbound-publication-ledger",
    version: RECOVERY.version,
    sourceSha: RECOVERY.sourceSha,
    startedAt: new Date().toISOString(),
    operations: [],
    recovery: {
      schemaVersion: 1,
      kind: "watchbound-exact-jsr-recovery",
      controllerSha,
      originalRunId: RECOVERY.originalRunId,
      originalRunAttempt: RECOVERY.originalRunAttempt,
      originalReleasePlanSha256: sha256(planPath),
      originalPublicationLedgerSha256: sha256(originalLedgerPath),
      approvedNativeMatrixSha256: sha256(
        path.join(approvedRoot, "independent-reproducibility.json"),
      ),
      originalLedgerStatus: originalLedger.status,
    },
  };
  const ledgerPath = path.join(
    releaseRoot,
    "dist/evidence/publication-ledger.json",
  );
  writeJson(ledgerPath, ledger);

  try {
    await verifyExistingNpmPackages(packages, releaseRoot, (descriptor) => {
      recordOperation(ledger, ledgerPath, `npm:${descriptor.name}`, "verified-existing");
    });

    const jsrSpecifier = `jsr:@gadicc/watchbound@${RECOVERY.version}`;
    if (await jsrPackageExists(jsrSpecifier)) {
      recordOperation(ledger, ledgerPath, "jsr-wrapper", "verified-existing");
    } else {
      const loader = packages.find(({ kind }) => kind === "loader");
      const currentTarget = packages.find(({ targetId }) => targetId === "linux-x64-gnu");
      assert.ok(loader && currentTarget, "recovery requires the x64 target and loader");
      const jsrRoot = path.join(releaseRoot, "dist/jsr");
      installExactJsrNative(
        (command, args, cwd) => run(cwd, command, args),
        jsrRoot,
        [loader.tarball, currentTarget.tarball],
      );
      run(jsrRoot, "deno", [
        "publish",
        "--dry-run",
        "--allow-dirty",
        "--no-check",
      ]);
      recordOperation(ledger, ledgerPath, "jsr-wrapper", "publication-attempt-started");
      run(jsrRoot, "deno", ["publish", "--allow-dirty", "--no-check"]);
      recordOperation(
        ledger,
        ledgerPath,
        "jsr-wrapper",
        "published-verification-pending",
      );
      if (!await waitForJsrPackage(jsrSpecifier)) {
        throw new Error(`${jsrSpecifier} was not visible after recovery publication`);
      }
      recordOperation(ledger, ledgerPath, "jsr-wrapper", "verified-published");
    }

    ledger.finishedAt = new Date().toISOString();
    ledger.status = "completed";
    writeJson(ledgerPath, ledger);
  } catch (error) {
    ledger.finishedAt = new Date().toISOString();
    ledger.status = "failed";
    ledger.error = {
      name: error?.name ?? null,
      message: error?.message ?? String(error),
    };
    writeJson(ledgerPath, ledger);
    throw error;
  }

  process.stdout.write(
    `Recovered and verified jsr:@gadicc/watchbound@${RECOVERY.version} without npm mutation\n`,
  );
}

function validateController(controllerSha, allowWorkingTreeDelta) {
  assert.match(controllerSha, /^[0-9a-f]{40}$/u);
  assert.equal(capture(controllerRoot, "git", ["rev-parse", "HEAD"]), controllerSha);
  assert.equal(
    capture(controllerRoot, "git", ["rev-parse", `${RECOVERY.tag}^{commit}`]),
    RECOVERY.sourceSha,
  );
  const committedDelta = pathList(
    capture(controllerRoot, "git", [
      "diff",
      "--name-only",
      `${RECOVERY.sourceSha}..HEAD`,
    ]),
  );
  const workingTreeDelta = statusPathList(
    captureRaw(controllerRoot, "git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
  );
  if (!allowWorkingTreeDelta) {
    assert.deepEqual(workingTreeDelta, [], "recovery controller must be clean");
  }
  assert.deepEqual(
    [...new Set([...committedDelta, ...workingTreeDelta])].sort(),
    [...ALLOWED_CONTROLLER_DELTA],
    "recovery controller delta differs from the reviewed allowlist",
  );
}

function validateReleaseSource(releaseRoot) {
  assert.equal(capture(releaseRoot, "git", ["rev-parse", "HEAD"]), RECOVERY.sourceSha);
  assert.equal(
    captureRaw(releaseRoot, "git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    "",
    "release source worktree must start clean",
  );
}

function validateReleasePlan(planPath) {
  const plan = readJson(planPath);
  assert.deepEqual(
    {
      schemaVersion: plan.schemaVersion,
      kind: plan.kind,
      mode: plan.mode,
      qualify: plan.qualify,
      willRelease: plan.willRelease,
      sourceVersion: plan.sourceVersion,
      version: plan.version,
      sourceSha: plan.sourceSha,
      tag: plan.tag,
    },
    {
      schemaVersion: 2,
      kind: "watchbound-release-plan",
      mode: "release",
      qualify: true,
      willRelease: true,
      sourceVersion: "0.0.0-development",
      version: RECOVERY.version,
      sourceSha: RECOVERY.sourceSha,
      tag: RECOVERY.tag,
    },
  );
  return plan;
}

function validateApprovedNativeMatrix(approvedRoot, plan) {
  const comparisonPath = path.join(
    approvedRoot,
    "independent-reproducibility.json",
  );
  const comparison = readJson(comparisonPath);
  assert.equal(comparison.schemaVersion, 2);
  assert.equal(comparison.kind, "watchbound-independent-native-matrix-comparison");
  assert.equal(comparison.sourceSha, plan.sourceSha);
  assert.equal(comparison.version, plan.version);
  assert.equal(comparison.candidate?.sourceSha, RECOVERY.sourceSha);
  assert.equal(comparison.candidate?.version, RECOVERY.version);
  assert.equal(comparison.candidate?.sourceVersion, "0.0.0-development");
  assert.equal(comparison.targets?.length, Object.keys(EXPECTED_NATIVE).length);
  for (const [targetId, expected] of Object.entries(EXPECTED_NATIVE)) {
    const target = comparison.targets.find(({ target }) => target === targetId);
    assert.ok(target, `approved matrix omits ${targetId}`);
    assert.equal(target.filename, expected.binary);
    assert.equal(target.sha256, expected.sha256);
    assert.equal(target.bytes, expected.bytes);
    assert.equal(target.byteIdentical, true);
    assert.equal(target.builders?.length, 2);
    const binaryPath = path.join(approvedRoot, expected.binary);
    assert.equal(fs.statSync(binaryPath).size, expected.bytes);
    assert.equal(sha256(binaryPath), expected.sha256);
    for (const builder of target.builders) {
      assert.equal(builder.source?.gitHead, RECOVERY.sourceSha);
      assert.equal(builder.release?.version, RECOVERY.version);
      assert.equal(builder.artifact?.sha256, expected.sha256);
    }
  }
  return comparison;
}

function validateOriginalEvidence(evidenceRoot, ledgerPath) {
  const ledger = readJson(ledgerPath);
  assert.equal(ledger.schemaVersion, 2);
  assert.equal(ledger.kind, "watchbound-publication-ledger");
  assert.equal(ledger.version, RECOVERY.version);
  assert.equal(ledger.sourceSha, RECOVERY.sourceSha);
  assert.equal(ledger.status, "failed");
  assert.equal(ledger.error?.name, "Error");
  assert.equal(ledger.error?.message, "deno exited with status 1");
  assert.deepEqual(
    ledger.operations.map(({ operation, status }) => [operation, status]),
    [...EXPECTED_ORIGINAL_OPERATIONS],
  );

  const metadata = readJson(path.join(evidenceRoot, "release-metadata.json"));
  assert.equal(metadata.schemaVersion, 2);
  assert.equal(metadata.package, "watchbound");
  assert.equal(metadata.version, RECOVERY.version);
  assert.equal(metadata.commit, RECOVERY.sourceSha);
  assert.equal(metadata.delivery, "target-native-packages");

  const sbom = readJson(
    path.join(evidenceRoot, `watchbound-${RECOVERY.version}.cdx.json`),
  );
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.6");
  assert.equal(sbom.metadata?.component?.name, "watchbound");
  assert.equal(sbom.metadata?.component?.version, RECOVERY.version);

  const sums = parseChecksums(path.join(evidenceRoot, "SHA256SUMS"));
  for (const expected of Object.values(EXPECTED_NATIVE)) {
    assert.equal(sums.get(expected.binary), expected.sha256);
  }
  for (const expected of Object.values(EXPECTED_PACKAGES)) {
    assert.equal(sums.get(expected.filename), expected.sha256);
  }
  assert.equal(
    sums.size,
    Object.keys(EXPECTED_NATIVE).length + Object.keys(EXPECTED_PACKAGES).length,
  );
  return ledger;
}

function releasePackages(releaseRoot) {
  const manifest = readJson(
    path.join(releaseRoot, "dist/native-package-manifest.json"),
  );
  const targets = manifest.targets.map((target) => ({
    kind: "target",
    targetId: target.id,
    name: target.name,
    root: target.root,
    tarball: tarballPath(releaseRoot, target.name),
  }));
  return [
    ...targets,
    {
      kind: "loader",
      name: manifest.loader.name,
      root: manifest.loader.root,
      tarball: tarballPath(releaseRoot, manifest.loader.name),
    },
    {
      kind: "wrapper",
      name: manifest.wrapper.name,
      root: manifest.wrapper.root,
      tarball: tarballPath(releaseRoot, manifest.wrapper.name),
    },
  ];
}

function validatePreparedPackages(packages) {
  assert.deepEqual(
    packages.map(({ name }) => name),
    Object.keys(EXPECTED_PACKAGES),
  );
  for (const descriptor of packages) {
    const expected = EXPECTED_PACKAGES[descriptor.name];
    assert.equal(path.basename(descriptor.tarball), expected.filename);
    assert.equal(sha256(descriptor.tarball), expected.sha256);
    assert.equal(sha512Integrity(descriptor.tarball), expected.integrity);
  }
}

async function verifyExistingNpmPackages(
  packages,
  releaseRoot,
  onVerified = () => {},
) {
  for (const descriptor of packages) {
    const state = await npmPackageState(
      `${descriptor.name}@${RECOVERY.version}`,
      releaseRoot,
    );
    assert.ok(state, `${descriptor.name}@${RECOVERY.version} must already exist`);
    verifyExistingNpmPackage(state, descriptor);
    onVerified(descriptor);
  }
}

async function npmPackageState(specifier, cwd) {
  const result = spawnSync("npm", ["view", specifier, "--json"], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/\bE404\b|is not in this registry|no match found/iu.test(
    `${result.stdout}\n${result.stderr}`,
  )) {
    return null;
  }
  throw new Error(
    `could not inspect ${specifier}:\n${result.stdout}\n${result.stderr}`.trim(),
  );
}

function verifyExistingNpmPackage(state, descriptor) {
  const expected = EXPECTED_PACKAGES[descriptor.name];
  const expectedManifest = readJson(
    path.join(path.dirname(path.dirname(descriptor.tarball)), descriptor.root, "package.json"),
  );
  assert.equal(state.name, descriptor.name);
  assert.equal(state.version, RECOVERY.version);
  assert.equal(state.dist?.integrity, expected.integrity);
  for (const field of ["dependencies", "optionalDependencies", "os", "cpu", "libc"]) {
    assert.deepEqual(
      state[field] ?? null,
      expectedManifest[field] ?? null,
      `registry ${field} mismatch for ${descriptor.name}@${RECOVERY.version}`,
    );
  }
}

async function waitForJsrPackage(specifier) {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    if (await jsrPackageExists(specifier)) return true;
    await delay(3_000);
  }
  return false;
}

function recordOperation(ledger, ledgerPath, operation, status) {
  ledger.operations.push({ operation, status, at: new Date().toISOString() });
  writeJson(ledgerPath, ledger);
}

function tarballPath(releaseRoot, name) {
  const filename = `${name.replace(/^@/u, "").replaceAll("/", "-")}-${RECOVERY.version}.tgz`;
  return path.join(releaseRoot, "dist/tarballs", filename);
}

function parseChecksums(source) {
  const entries = fs.readFileSync(source, "utf8")
    .trim()
    .split("\n")
    .map((line) => line.match(/^(?<digest>[0-9a-f]{64})  (?<filename>[^/]+)$/u)?.groups);
  assert.ok(entries.every(Boolean), "invalid original SHA256SUMS");
  return new Map(entries.map(({ filename, digest }) => [filename, digest]));
}

function pathList(output) {
  return output.split("\n").map((entry) => entry.trim()).filter(Boolean).sort();
}

function statusPathList(output) {
  return output.split("\n")
    .map((entry) => entry.slice(3).trim())
    .filter(Boolean)
    .map((entry) => entry.includes(" -> ") ? entry.split(" -> ").at(-1) : entry)
    .sort();
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
}

function requiredDirectory(name) {
  const value = path.resolve(requiredEnvironment(name));
  assert.ok(fs.statSync(value).isDirectory(), `${name} must name a directory`);
  return value;
}

function requiredFile(name) {
  const value = path.resolve(requiredEnvironment(name));
  assert.ok(fs.statSync(value).isFile(), `${name} must name a file`);
  return value;
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function writeJson(destination, value) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}

function sha512Integrity(source) {
  return `sha512-${crypto.createHash("sha512").update(fs.readFileSync(source)).digest("base64")}`;
}

function capture(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function captureRaw(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.replace(/\n$/u, "");
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} exited with status ${result.status}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
