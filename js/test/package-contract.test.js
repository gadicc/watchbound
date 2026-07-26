import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installExactJsrNative } from "../../scripts/install-jsr-native.mjs";
import { jsrPackageExists } from "../../scripts/semantic-release-watchbound.mjs";
import { validateOverflowDispatch } from "../../scripts/validate-overflow-dispatch.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8"));
}

test("private manifests retain source-build development and architecture-neutral public generation", () => {
  const root = readJson("package.json");
  const wrapper = readJson("js/package.json");
  const native = readJson("node/package.json");
  const { version } = root;
  assert.equal(version, "1.2.0");

  assert.equal(wrapper.name, "watchbound");
  assert.equal(native.name, "@gadicc/watchbound-node");
  for (const manifest of [root, wrapper, native]) {
    assert.equal(manifest.private, true);
    assert.equal(manifest.version, version);
    assert.equal(manifest.license, "MIT");
    assert.equal(manifest.author, "Gadi Cohen <dragon@wastelands.net>");
    assert.match(manifest.repository.url, /github\.com\/gadicc\/watchbound/u);
    assert.deepEqual(manifest.engines, { node: ">=24.15.0 <25" });
    assert.equal(manifest.scripts?.preinstall, undefined);
    assert.equal(manifest.scripts?.install, undefined);
    assert.equal(manifest.scripts?.postinstall, undefined);
    assert.equal(manifest.optionalDependencies, undefined);
  }

  for (const manifest of [wrapper, native]) {
    assert.deepEqual(manifest.os, ["linux"]);
    assert.equal(manifest.cpu, undefined);
    assert.equal(manifest.libc, undefined);
    assert.deepEqual(manifest.watchbound, {
      delivery: "controlled-source-build",
    });
  }

  assert.deepEqual(native.exports, {
    ".": {
      types: "./index.d.ts",
      require: "./index.js",
      import: "./index.js",
      default: "./index.js",
    },
  });
  assert.deepEqual(native.files, [
    "index.js",
    "index.d.ts",
    "load-native.cjs",
    "native-matrix.json",
    "watchbound.*.node",
  ]);
  assert.equal(
    wrapper.dependencies["@gadicc/watchbound-node"],
    `workspace:${version}`,
  );
  assert.equal(root.scripts["build:node"], "node scripts/build-node.mjs");
  assert.deepEqual(root.workspaces, ["js", "node"]);
  assert.equal(
    root.scripts["test:packages"],
    "pnpm package:prepare && pnpm package:check",
  );
  assert.equal(
    root.scripts["test:baseline"],
    "node scripts/run-local-baseline.mjs",
  );
  assert.equal(
    root.scripts["check:registry-packages"],
    "node scripts/check-registry-packages.mjs",
  );
  assert.equal(root.scripts.release, "semantic-release");
  assert.equal(root.devDependencies["semantic-release"], "25.0.8");
  for (const crate of ["engine/Cargo.toml", "node/Cargo.toml"]) {
    const source = fs.readFileSync(path.join(workspaceRoot, crate), "utf8");
    assert.match(source, /^publish = false$/mu);
  }
});

test("native matrix is the single source for x64 and ARM64 delivery", () => {
  const matrix = readJson("config/native-matrix.json");
  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.nodeRange, ">=24.15.0 <25");
  assert.deepEqual(matrix.releaseBaseline, {
    distribution: "ubuntu",
    version: "22.04",
    kernelMinimum: "5.15",
    glibcMaximum: "2.35",
  });
  assert.equal(
    matrix.kernelBaselineQualification.classification,
    "qemu-kernel-floor-component",
  );
  assert.equal(matrix.kernelBaselineQualification.kernelSeries, "5.15");
  assert.equal(
    matrix.kernelBaselineQualification.kernelRelease,
    "5.15.0-185-generic",
  );
  assert.equal(
    matrix.kernelBaselineQualification.image,
    matrix.qualificationLanes[0].image,
  );
  for (const architecture of ["x64", "arm64"]) {
    const artifacts = matrix.kernelBaselineQualification.artifacts[architecture];
    assert.match(artifacts.qemuSystem, /^qemu-system-(?:x86_64|aarch64)$/u);
    for (const artifact of [artifacts.kernel, artifacts.initrd]) {
      assert.match(artifact.url, /release-20260705\/unpacked/u);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
    }
  }
  assert.deepEqual(
    matrix.targets.map((target) => ({
      id: target.id,
      architecture: target.architecture,
      package: target.package,
      qualification: target.qualification,
      runner: target.runner,
      overflowRunner: target.overflowRunner,
    })),
    [
      {
        id: "linux-x64-gnu",
        architecture: "x64",
        package: "@gadicc/watchbound-node-linux-x64-gnu",
        qualification: "target-pending-clean-ci",
        runner: "ubuntu-22.04",
        overflowRunner: "ubuntu-24.04",
      },
      {
        id: "linux-arm64-gnu",
        architecture: "arm64",
        package: "@gadicc/watchbound-node-linux-arm64-gnu",
        qualification: "target-pending-clean-ci",
        runner: "ubuntu-22.04-arm",
        overflowRunner: "ubuntu-24.04-arm",
      },
    ],
  );
  assert.equal(matrix.qualificationLanes.length, 7);
  assert.deepEqual(matrix.codexRuntime, {
    electron: "42.3.0",
    node: "24.15.0",
    nodeApi: 10,
    asar: { archive: "app.asar", nativeDirectory: "app.asar.unpacked" },
  });
  for (const lane of matrix.qualificationLanes) {
    assert.match(lane.image, /@sha256:[0-9a-f]{64}$/u);
  }
  assert.deepEqual(
    matrix.intentionallyUnsupported.map(({ target }) => target),
    ["linux-armv7-gnu", "linux-musl", "non-linux"],
  );
});

test("manual qualification is read-only while semantic release stays push-only", () => {
  const release = fs.readFileSync(
    path.join(workspaceRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  const ci = fs.readFileSync(
    path.join(workspaceRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  const config = fs.readFileSync(
    path.join(workspaceRoot, "release.config.mjs"),
    "utf8",
  );
  const plugin = fs.readFileSync(
    path.join(workspaceRoot, "scripts/semantic-release-watchbound.mjs"),
    "utf8",
  );
  const recordNativeBuild = fs.readFileSync(
    path.join(workspaceRoot, "scripts/record-native-build.mjs"),
    "utf8",
  );
  const compareNativeBuilds = fs.readFileSync(
    path.join(workspaceRoot, "scripts/compare-native-builds.mjs"),
    "utf8",
  );
  const aggregateNativeBuilds = fs.readFileSync(
    path.join(workspaceRoot, "scripts/aggregate-native-builds.mjs"),
    "utf8",
  );
  const ciMatrix = fs.readFileSync(
    path.join(workspaceRoot, "scripts/ci-matrix.mjs"),
    "utf8",
  );
  const overflowPreflight = fs.readFileSync(
    path.join(workspaceRoot, "scripts/record-overflow-preflight.mjs"),
    "utf8",
  );
  const kernelBaseline = fs.readFileSync(
    path.join(workspaceRoot, "scripts/run-kernel-baseline-qualification.mjs"),
    "utf8",
  );
  const selectReleasePlan = fs.readFileSync(
    path.join(workspaceRoot, "scripts/select-release-plan.mjs"),
    "utf8",
  );
  const flake = fs.readFileSync(path.join(workspaceRoot, "flake.nix"), "utf8");
  assert.match(release, /^  push:\n    branches: \[main\]$/mu);
  assert.match(
    release,
    /^  workflow_dispatch:\n    inputs:\n      candidate_sha:/mu,
  );
  assert.match(release, /^      scenario:\n[\s\S]*?type: choice\n[\s\S]*?- overflow-reconciliation\n[\s\S]*?- automatic-overflow-reconciliation/mu);
  assert.match(release, /^      attempt:/mu);
  assert.match(release, /^      acknowledgement:/mu);
  assert.match(release, /^  release-plan:/mu);
  assert.match(release, /^      contents: write$/mu);
  assert.match(release, /^  qualification-plan:/mu);
  assert.match(release, /^      contents: read$/mu);
  assert.match(release, /validate-overflow-dispatch\.mjs/u);
  assert.match(release, /qualification-dispatch\.json/u);
  assert.match(release, /--mode qualification/u);
  assert.match(release, /ref: \$\{\{ inputs\.candidate_sha \}\}/u);
  assert.match(release, /github\.run_attempt/u);
  assert.match(release, /^  plan:\n    name: Select exact candidate plan/mu);
  assert.match(release, /watchbound-qualification-plan-/u);
  assert.match(release, /actions\/download-artifact@/u);
  assert.match(release, /select-release-plan\.mjs/u);
  assert.match(
    release,
    /^      qualify: \$\{\{ steps\.select\.outputs\.qualify \}\}$/mu,
  );
  assert.match(
    release,
    /^      source: \$\{\{ steps\.matrix\.outputs\.source \}\}$/mu,
  );
  assert.doesNotMatch(
    release,
    /needs\.release-plan\.outputs\.qualify \|\|/u,
  );
  assert.match(
    release,
    /if: >-\n      always\(\) &&\n      needs\.plan\.result == 'success' &&\n      \(github\.event_name == 'push' \|\|\n      needs\.plan\.outputs\.qualify == 'true'\)/u,
  );
  const cascadeJobs = {
    "repro-build": ["plan"],
    "repro-compare": ["plan", "repro-build"],
    aggregate: ["plan", "repro-compare"],
    "release-distro": ["plan", "aggregate"],
    "release-electron": ["plan", "aggregate"],
    "release-kernel-baseline": ["plan", "aggregate"],
    "release-overflow": ["plan", "aggregate"],
    "qualification-verified": [
      "plan",
      "tests",
      "aggregate",
      "release-distro",
      "release-electron",
      "release-kernel-baseline",
      "release-overflow",
    ],
    release: [
      "plan",
      "tests",
      "aggregate",
      "release-distro",
      "release-electron",
      "release-kernel-baseline",
      "release-overflow",
    ],
    "registry-smoke": ["plan", "release"],
    verified: ["registry-smoke"],
  };
  for (const [job, requiredResults] of Object.entries(cascadeJobs)) {
    const start = release.indexOf(`  ${job}:\n`);
    assert.notEqual(start, -1, `${job} job exists`);
    const bodyStart = start + job.length + 4;
    const nextHeader = release.slice(bodyStart).match(/\n  [a-z0-9-]+:\n/u);
    const next = nextHeader?.index === undefined
      ? -1
      : bodyStart + nextHeader.index;
    const block = release.slice(start, next === -1 ? undefined : next);
    assert.match(block, /    if: >-\n      always\(\) &&/u, `${job} breaks the skipped-ancestor cascade`);
    for (const required of requiredResults) {
      assert.match(
        block,
        new RegExp(`needs\\.${required}\\.result == 'success'`, "u"),
        `${job} requires ${required} to succeed`,
      );
    }
  }
  assert.match(
    release,
    /needs\.tests\.result == 'success' &&[\s\S]*?needs\.release-overflow\.result == 'success' &&[\s\S]*?needs\.plan\.outputs\.will-release == 'true'/u,
  );
  assert.match(release, /github\.event_name == 'push'/u);
  assert.match(release, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(release, /needs\.plan\.outputs\.will-release == 'true'/u);
  assert.doesNotMatch(release, /^    environment:/mu);
  assert.match(release, /^      id-token: write$/mu);
  assert.match(release, /^          fetch-depth: 0$/mu);
  assert.match(release, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/u);
  assert.match(release, /run: pnpm release/u);
  assert.match(release, /^  repro-build:$/mu);
  assert.match(release, /^  repro-compare:$/mu);
  assert.match(release, /^  aggregate:$/mu);
  assert.match(release, /^  release-distro:$/mu);
  assert.match(release, /^  release-electron:$/mu);
  assert.match(release, /^  release-kernel-baseline:$/mu);
  assert.match(release, /^  release-overflow:$/mu);
  assert.match(release, /^  qualification-verified:$/mu);
  assert.match(release, /^  registry-smoke:$/mu);
  assert.match(release, /compare-native-builds\.mjs/u);
  assert.match(release, /aggregate-native-builds\.mjs/u);
  assert.match(release, /check-registry-packages\.mjs/u);
  assert.match(release, /WATCHBOUND_CANONICAL_NATIVE_DIR/u);
  assert.match(release, /watchbound-approved-native-matrix/u);
  assert.match(release, /ubuntu-22\.04/u);
  assert.match(release, /glibc 2\.35/u);
  assert.match(release, /check-electron-asar\.mjs/u);
  assert.match(release, /run-kernel-baseline-qualification\.mjs/u);
  assert.match(release, /needs\.release-kernel-baseline\.result == 'success'/u);
  assert.match(release, /overflow-reconciliation,automatic-overflow-reconciliation/u);
  assert.match(release, /^    runs-on: \$\{\{ matrix\.overflowRunner \}\}$/mu);
  assert.match(release, /inputs\.scenario/u);
  assert.match(release, /--runs 1/u);
  assert.match(release, /record-overflow-preflight\.mjs/u);
  assert.match(release, /if: always\(\)[\s\S]*?watchbound-release-overflow-/u);
  assert.doesNotMatch(release, /self-hosted/u);
  assert.equal(
    release.match(
      /echo "RUSTFLAGS=--remap-path-prefix=\$cargo_home=\/watchbound\/cargo-home" >> "\$GITHUB_ENV"/gu,
    )?.length,
    2,
  );
  assert.doesNotMatch(release, /NPM_BOOTSTRAP_TOKEN/u);
  assert.doesNotMatch(release, /^\s*- uses: [^\s]+@v\d+(?:\.\d+)*\s*$/mu);
  assert.doesNotMatch(ci, /workflow_dispatch/u);
  assert.match(ci, /^  workflow_call:\n    inputs:\n      candidate_sha:/mu);
  assert.match(ci, /inputs\.candidate_sha \|\| github\.sha/u);
  assert.match(ci, /^  push:\n    branches-ignore: \[main\]$/mu);
  assert.match(ci, /fromJSON\(needs\.matrix\.outputs\.source\)/u);
  assert.match(ci, /fromJSON\(needs\.matrix\.outputs\.qualification\)/u);
  assert.match(ci, /fromJSON\(needs\.matrix\.outputs\.kernel\)/u);
  assert.match(ci, /check-electron-asar\.mjs/u);
  assert.match(ci, /run-distro-qualification\.mjs/u);
  assert.match(ci, /run-kernel-baseline-qualification\.mjs/u);
  assert.match(ci, /nix flake check --no-update-lock-file/u);
  assert.doesNotMatch(ci, /^\s*- uses: [^\s]+@v\d+(?:\.\d+)*\s*$/mu);

  assert.match(config, /branches: \["main"\]/u);
  assert.match(config, /@semantic-release\/commit-analyzer/u);
  assert.match(config, /@semantic-release\/release-notes-generator/u);
  assert.match(config, /semantic-release-watchbound\.mjs/u);
  assert.match(config, /@semantic-release\/github/u);
  assert.match(config, /dist\/evidence\/SHA256SUMS/u);

  assert.match(plugin, /scripts\/set-release-version\.mjs/u);
  assert.match(plugin, /pnpm", \["check:reproducible"\]/u);
  assert.match(plugin, /pnpm", \["test:packages"\]/u);
  assert.match(plugin, /installCanonicalNativeMatrix/u);
  assert.match(plugin, /assertReleaseTargetsQualified/u);
  assert.match(plugin, /registry integrity mismatch/u);
  assert.match(plugin, /publication-ledger\.json/u);
  assert.match(plugin, /async function npmPackageState/u);
  assert.match(plugin, /\["view", specifier, "--json"\]/u);
  assert.doesNotMatch(plugin, /deno", \["info"/u);
  assert.doesNotMatch(plugin, /minimum-dependency-age/u);
  assert.match(plugin, /https:\/\/jsr\.io\/@/u);
  assert.match(plugin, /meta\.json/u);
  assert.match(plugin, /installExactJsrNative/u);
  assert.match(
    plugin,
    /\["publish", "--dry-run", "--allow-dirty", "--no-check"\]/u,
  );
  assert.match(plugin, /"publish"/u);
  assert.match(plugin, /"--provenance"/u);
  assert.doesNotMatch(plugin, /NPM_TOKEN|NODE_AUTH_TOKEN/u);
  assert.match(
    recordNativeBuild,
    /rustFlags: requiredEnvironment\("RUSTFLAGS"\)/u,
  );
  assert.match(
    compareNativeBuilds,
    /--remap-path-prefix=\$\{manifest\.isolation\.cargoHome\}=\/watchbound\/cargo-home/u,
  );
  assert.match(aggregateNativeBuilds, /watchbound-independent-native-matrix-comparison/u);
  assert.match(ciMatrix, /matrix\.qualificationLanes/u);
  assert.match(ciMatrix, /matrix\.kernelBaselineQualification/u);
  assert.match(ciMatrix, /\["builder-a", "builder-b"\]/u);
  assert.match(ciMatrix, /runner: target\.runner/u);
  assert.match(overflowPreflight, /watchbound-overflow-qualification-preflight/u);
  assert.match(overflowPreflight, /independent-reproducibility\.json/u);
  assert.match(overflowPreflight, /max_queued_events/u);
  assert.match(overflowPreflight, /\/proc\/pressure/u);
  assert.match(overflowPreflight, /correctness/u);
  assert.match(overflowPreflight, /non-authoritative/u);
  assert.match(kernelBaseline, /watchbound-kernel-baseline-qualification/u);
  assert.match(kernelBaseline, /architectureEvidence/u);
  assert.match(kernelBaseline, /not provided by this QEMU lane/u);
  assert.match(kernelBaseline, /WATCHBOUND_KERNEL_BASELINE_STATUS=passed/u);
  assert.match(selectReleasePlan, /watchbound-release-plan/u);
  assert.match(selectReleasePlan, /plan\.sourceSha/u);
  assert.match(selectReleasePlan, /git", \["rev-parse", "HEAD"\]/u);
  assert.match(selectReleasePlan, /will-release=/u);
  assert.match(flake, /eachSystem \[ "x86_64-linux" "aarch64-linux" \]/u);
  assert.match(flake, /electron-v\$\{matrix\.codexRuntime\.electron\}-linux-/u);
  assert.match(flake, /target\.codexElectron\.sha256SRI/u);
  assert.match(flake, /patchelf/u);
  assert.match(flake, /generate-nix-package\.mjs/u);
  assert.match(flake, /asar pack/u);
  assert.doesNotMatch(flake, /npm (?:install|ci)/u);
});

test("overflow dispatch validation rejects workflow reruns and ambiguous approval", () => {
  const candidateSha = "a".repeat(40);
  assert.deepEqual(
    validateOverflowDispatch({
      candidateSha,
      workflowSha: candidateSha,
      checkedOutSha: candidateSha,
      scenario: "overflow-reconciliation",
      attempt: "1",
      runAttempt: "1",
      acknowledgement: "I ACKNOWLEDGE FORCED OVERFLOW overflow-reconciliation ATTEMPT 1",
    }),
    {
      candidateSha,
      scenario: "overflow-reconciliation",
      attempt: 1,
    },
  );

  for (const overrides of [
    { runAttempt: "2" },
    { attempt: "0" },
    { scenario: "reconciliation" },
    { acknowledgement: "yes" },
    { workflowSha: "b".repeat(40) },
    { checkedOutSha: "b".repeat(40) },
  ]) {
    assert.throws(
      () => validateOverflowDispatch({
        candidateSha,
        workflowSha: candidateSha,
        checkedOutSha: candidateSha,
        scenario: "overflow-reconciliation",
        attempt: "1",
        runAttempt: "1",
        acknowledgement: "I ACKNOWLEDGE FORCED OVERFLOW overflow-reconciliation ATTEMPT 1",
        ...overrides,
      }),
      /qualification|candidate|scenario|attempt|acknowledgement/iu,
    );
  }

  assert.equal(
    validateOverflowDispatch({
      candidateSha,
      workflowSha: candidateSha,
      checkedOutSha: candidateSha,
      scenario: "automatic-overflow-reconciliation",
      attempt: "2",
      runAttempt: "1",
      acknowledgement:
        "I ACKNOWLEDGE FORCED OVERFLOW automatic-overflow-reconciliation ATTEMPT 2",
    }).attempt,
    2,
  );
});

test("JSR existence checks exact registry metadata without Deno policy", async () => {
  const requests = [];
  const fetchMetadata = async (...args) => {
    requests.push(args);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          scope: "gadicc",
          name: "watchbound",
          versions: {
            "1.0.0": { yanked: true },
            "1.0.1": {},
          },
        };
      },
    };
  };

  assert.equal(
    await jsrPackageExists(
      "jsr:@gadicc/watchbound@1.0.1",
      fetchMetadata,
    ),
    true,
  );
  assert.equal(
    await jsrPackageExists(
      "jsr:@gadicc/watchbound@1.0.2",
      fetchMetadata,
    ),
    false,
  );
  assert.equal(
    await jsrPackageExists(
      "jsr:@gadicc/watchbound@1.0.0",
      fetchMetadata,
    ),
    true,
  );
  assert.equal(requests.length, 3);
  for (const [url, options] of requests) {
    assert.equal(url, "https://jsr.io/@gadicc/watchbound/meta.json");
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers.accept, "application/json");
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("JSR publication restores only the exact prepared native tarball", () => {
  const calls = [];
  installExactJsrNative(
    (...args) => calls.push(args),
    "/tmp/watchbound-jsr",
    "/tmp/gadicc-watchbound-node-1.0.1.tgz",
  );
  assert.deepEqual(calls, [[
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      "--offline",
      "/tmp/gadicc-watchbound-node-1.0.1.tgz",
    ],
    "/tmp/watchbound-jsr",
  ]]);
});

test("JSR publication can restore the loader and current target without networking", () => {
  const calls = [];
  installExactJsrNative(
    (...args) => calls.push(args),
    "/tmp/watchbound-jsr",
    [
      "/tmp/gadicc-watchbound-node-1.2.0.tgz",
      "/tmp/gadicc-watchbound-node-linux-arm64-gnu-1.2.0.tgz",
    ],
  );
  assert.deepEqual(calls[0][1].slice(-2), [
    "/tmp/gadicc-watchbound-node-1.2.0.tgz",
    "/tmp/gadicc-watchbound-node-linux-arm64-gnu-1.2.0.tgz",
  ]);
  assert.ok(calls[0][1].includes("--offline"));
});

test("spent JSR recoveries cannot be dispatched or reused", () => {
  for (const relativePath of [
    ".github/workflows/recover-jsr-v1.yml",
    ".github/workflows/recover-jsr-v1-0-1.yml",
    "scripts/recover-jsr-v1-0-1.mjs",
  ]) {
    assert.equal(
      fs.existsSync(path.join(workspaceRoot, relativePath)),
      false,
      `${relativePath} must be retired`,
    );
  }
});

test("the wrapper resolves the native package boundary and asserts lockstep versions", () => {
  const source = fs.readFileSync(path.join(workspaceRoot, "js/index.js"), "utf8");
  assert.match(source, /from "@gadicc\/watchbound-node"/u);
  assert.doesNotMatch(source, /from "\.\.\/node\/index\.js"/u);
  assert.match(
    source,
    /nativeBinding\.assertWrapperVersion\(WRAPPER_VERSION, WRAPPER_DELIVERY\)/u,
  );
});
