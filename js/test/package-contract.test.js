import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installExactJsrNative } from "../../scripts/install-jsr-native.mjs";
import { outputs as ciMatrixOutputs } from "../../scripts/ci-matrix.mjs";
import {
  INDEPENDENT_NATIVE_MATRIX_EVIDENCE,
  readOptionalEvidence,
} from "../../scripts/lib/native-build-evidence.mjs";
import { validateNativeArtifact } from "../../scripts/lib/native-artifact.mjs";
import {
  jsrPackageExists,
  waitForJsrPackage,
} from "../../scripts/semantic-release-watchbound.mjs";
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
  assert.equal(
    version,
    process.env.WATCHBOUND_CANDIDATE_VERSION ?? "0.0.0-development",
  );

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
  assert.match(root.scripts.check, /check:source-version/u);
  assert.equal(root.devDependencies["semantic-release"], "25.0.8");
  assert.equal(root.devDependencies["@parcel/watcher"], "2.5.6");
  const dependabot = fs.readFileSync(
    path.join(workspaceRoot, ".github/dependabot.yml"),
    "utf8",
  );
  assert.match(
    dependabot,
    /package-ecosystem: npm[\s\S]*?ignore:[\s\S]*?- dependency-name: "@parcel\/watcher"/u,
  );
  for (const crate of ["engine/Cargo.toml", "node/Cargo.toml"]) {
    const source = fs.readFileSync(path.join(workspaceRoot, crate), "utf8");
    assert.match(source, /^publish = false$/mu);
  }
});

test("public guides defer Watchbound release versioning to package and release records", () => {
  const allowedTechnicalVersions = new Set([
    "0.0.0",
    "2.5.6",
    "10.33.2",
    "24.15.0",
    "42.3.0",
  ]);
  for (const relativePath of [
    "README.md",
    "CONTRIBUTING.md",
    "benches/README.md",
    "docs/README.md",
    "skills/watchbound/SKILL.md",
  ]) {
    const source = fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:release|published|unpublished)\s+`?v?\d+\.\d+\.\d+/iu,
      `${relativePath} must not identify a Watchbound release version`,
    );
    assert.doesNotMatch(
      source,
      /\b(?:current|unpublished)\s+(?:(?:Watchbound|package)\s+)?(?:release|package|source-build candidate)\b/iu,
      `${relativePath} must not describe Watchbound release status`,
    );
    for (const match of source.matchAll(/\b\d+\.\d+\.\d+\b/gu)) {
      assert.ok(
        allowedTechnicalVersions.has(match[0]),
        `${relativePath} has nontechnical package/release version ${match[0]}`,
      );
    }
  }
});

test("qualification summaries limit container exclusions to recognized evidence", () => {
  const summaries = [
    ["README.md", "The supported native targets"],
    ["docs/api-lifecycle.md", "The candidate target matrix"],
    ["docs/architecture.md", "The current source matrix"],
    ["docs/support-matrix.md", "The full machine-readable contract"],
    ["skills/watchbound/SKILL.md", "An environment with recognized container evidence"],
  ];

  for (const [relativePath, marker] of summaries) {
    const source = fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
    const paragraph = source
      .split(/\n\s*\n/u)
      .find((candidate) => candidate.includes(marker));
    assert.ok(paragraph, `${relativePath} qualification summary is missing`);
    assert.match(
      paragraph,
      /(?:recognized\s+container\s+evidence|detected\s+container)[\s\S]{0,200}(?:cannot\s+qualify|never\s+return\s+`qualified`)/iu,
      `${relativePath} must limit container exclusion to recognized evidence`,
    );
    assert.doesNotMatch(
      paragraph,
      /\b(?:all|every|any)\s+(?:possible\s+)?container(?:s| runtime)?\b/iu,
      `${relativePath} must not imply exhaustive container detection`,
    );
  }
});

test("release evidence accepts only the canonical independent matrix schema", () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "watchbound-native-evidence-"),
  );
  const source = path.join(fixtureRoot, "independent-reproducibility.json");
  const evidence = {
    ...INDEPENDENT_NATIVE_MATRIX_EVIDENCE,
    sourceSha: "a".repeat(40),
    version: "9.8.7",
    targets: [],
  };

  try {
    fs.writeFileSync(source, `${JSON.stringify(evidence)}\n`);
    assert.deepEqual(
      readOptionalEvidence(source, INDEPENDENT_NATIVE_MATRIX_EVIDENCE),
      evidence,
    );

    fs.writeFileSync(source, `${JSON.stringify({ ...evidence, schemaVersion: 1 })}\n`);
    assert.throws(
      () => readOptionalEvidence(source, INDEPENDENT_NATIVE_MATRIX_EVIDENCE),
      /schema version/u,
    );

    fs.writeFileSync(source, `${JSON.stringify({ ...evidence, kind: "wrong" })}\n`);
    assert.throws(
      () => readOptionalEvidence(source, INDEPENDENT_NATIVE_MATRIX_EVIDENCE),
      /kind/u,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("native matrix is the single source for x64, ARM64, and ARMv7 hard-float delivery", () => {
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
  assert.deepEqual(matrix.kernelBaselineQualification.artifacts.arm, {
    qemuSystem: "qemu-system-arm",
    qemuPackage: "qemu-system-arm",
    machine: "virt",
    cpu: "cortex-a15",
    console: "ttyAMA0",
    kernelRelease: "5.15.0-185-generic-lpae",
    rootfs: {
      profile: "kernel",
      packages: [
        { name: "initramfs-tools", version: "0.140ubuntu13.5" },
        {
          name: "linux-image-5.15.0-185-generic-lpae",
          version: "5.15.0-185.195",
        },
        {
          name: "linux-modules-5.15.0-185-generic-lpae",
          version: "5.15.0-185.195",
        },
      ],
      kernelPath: "/boot/vmlinuz-5.15.0-185-generic-lpae",
      kernelSha256:
        "37c57a9d9e96945889315e2d2dc6f86068e4799e8fd5d6198bf50a4b61d8838d",
      initrdPath: "/boot/initrd.img-5.15.0-185-generic-lpae",
      requiredInitrdModules: ["virtio_blk"],
    },
  });
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
        qualification: "supported",
        runner: "ubuntu-22.04",
        overflowRunner: "ubuntu-24.04",
      },
      {
        id: "linux-arm64-gnu",
        architecture: "arm64",
        package: "@gadicc/watchbound-node-linux-arm64-gnu",
        qualification: "supported",
        runner: "ubuntu-22.04-arm",
        overflowRunner: "ubuntu-24.04-arm",
      },
      {
        id: "linux-arm-gnueabihf",
        architecture: "arm",
        package: "@gadicc/watchbound-node-linux-arm-gnueabihf",
        qualification: "supported",
        runner: "ubuntu-22.04",
        overflowRunner: null,
      },
    ],
  );
  const armv7 = matrix.targets.find(({ id }) => id === "linux-arm-gnueabihf");
  assert.deepEqual(armv7.armAbi, {
    version: 7,
    floatAbi: "hard",
    endianness: "little",
  });
  assert.equal(armv7.rustTarget, "armv7-unknown-linux-gnueabihf");
  assert.equal(armv7.binary, "watchbound.linux-arm-gnueabihf.node");
  assert.equal(armv7.runtimeEmulator, "/usr/bin/qemu-arm");
  assert.equal(armv7.runtimeCpu, "cortex-a15");
  assert.equal(armv7.runtimeRunner, "ubuntu-24.04");
  assert.deepEqual(armv7.runtimeRootfs, {
    platform: "linux/arm/v7",
    image:
      "docker.io/library/ubuntu:22.04@sha256:cc310f0f0ac7cebeef5ea6ea12e1262e291e4fd7eec74d407f5de7711062cd6e",
    binfmtImage:
      "docker.io/tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0",
    snapshot: "20260701T000000Z",
    packages: [
      "ca-certificates",
      "libasound2",
      "libatk-bridge2.0-0",
      "libatk1.0-0",
      "libatspi2.0-0",
      "libc6",
      "libcairo2",
      "libcups2",
      "libdbus-1-3",
      "libdrm2",
      "libexpat1",
      "libgbm1",
      "libgcc-s1",
      "libglib2.0-0",
      "libgtk-3-0",
      "libnspr4",
      "libnss3",
      "libpango-1.0-0",
      "libudev1",
      "libx11-6",
      "libxcb1",
      "libxcomposite1",
      "libxdamage1",
      "libxext6",
      "libxfixes3",
      "libxkbcommon0",
      "libxrandr2",
    ],
  });
  assert.deepEqual(armv7.elf, {
    class: 1,
    endianness: 1,
    machine: 40,
    flags: 83887104,
    flagsDescription: "Version5 EABI, hard-float ABI",
    machineName: "ARM",
    fileMachineName: "ARM",
    neededLibraries: ["ld-linux-armhf.so.3", "libc.so.6", "libgcc_s.so.1"],
  });
  assert.equal(matrix.qualificationLanes.length, 8);
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
    ["linux-arm-soft-float", "linux-musl", "non-linux"],
  );
});

test("ARMv7 user-mode emulation uses the modern runner without moving build or kernel evidence", () => {
  const runtime = ciMatrixOutputs.runtime.find(({ target }) => target === "linux-arm-gnueabihf");
  const cross = ciMatrixOutputs.cross.find(({ target }) => target === "linux-arm-gnueabihf");
  const kernel = ciMatrixOutputs.kernel.find(({ target }) => target === "linux-arm-gnueabihf");
  const registry = ciMatrixOutputs.registryEmulated.filter(
    ({ target }) => target === "linux-arm-gnueabihf",
  );

  assert.equal(runtime.runner, "ubuntu-24.04");
  assert.ok(registry.length > 0);
  assert.ok(registry.every(({ runner }) => runner === "ubuntu-24.04"));
  assert.equal(cross.runner, "ubuntu-22.04");
  assert.equal(kernel.runner, "ubuntu-22.04");
});

test("ARMv7 artifact validation fails closed on filename, ELF identity, triple, and version", () => {
  const target = readJson("config/native-matrix.json").targets.find(
    ({ id }) => id === "linux-arm-gnueabihf",
  );
  assert.ok(target);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-armv7-elf-"));
  const artifact = path.join(fixtureRoot, target.binary);
  const contents = Buffer.alloc(256);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(contents);
  contents[4] = target.elf.class;
  contents[5] = target.elf.endianness;
  contents.writeUInt16LE(target.elf.machine, 18);
  contents.writeUInt32LE(target.elf.flags, 36);
  Buffer.from(target.rustTarget).copy(contents, 64);
  Buffer.from("9.8.7").copy(contents, 160);
  try {
    fs.writeFileSync(artifact, contents);
    assert.equal(validateNativeArtifact(artifact, target, { version: "9.8.7" }).bytes, 256);
    assert.throws(
      () => validateNativeArtifact(path.join(fixtureRoot, "wrong.node"), target),
      /artifact filename/u,
    );

    const wrongFlags = Buffer.from(contents);
    wrongFlags.writeUInt32LE(0x05000200, 36);
    fs.writeFileSync(artifact, wrongFlags);
    assert.throws(() => validateNativeArtifact(artifact, target), /flags/u);

    fs.writeFileSync(artifact, Buffer.alloc(256));
    assert.throws(() => validateNativeArtifact(artifact, target), /ELF magic/u);

    const missingMetadata = Buffer.from(contents);
    missingMetadata.fill(0, 64);
    fs.writeFileSync(artifact, missingMetadata);
    assert.throws(() => validateNativeArtifact(artifact, target), /target triple/u);
    fs.writeFileSync(artifact, contents.subarray(0, 150));
    assert.throws(
      () => validateNativeArtifact(artifact, target, { version: "9.8.7" }),
      /package version/u,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
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
  const planRelease = fs.readFileSync(
    path.join(workspaceRoot, "scripts/plan-release.mjs"),
    "utf8",
  );
  const checkSourceVersion = fs.readFileSync(
    path.join(workspaceRoot, "scripts/check-source-version.mjs"),
    "utf8",
  );
  const materializeAction = fs.readFileSync(
    path.join(
      workspaceRoot,
      ".github/actions/materialize-release-candidate/action.yml",
    ),
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
  const generateReleaseEvidence = fs.readFileSync(
    path.join(workspaceRoot, "scripts/generate-release-evidence.mjs"),
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
  const installedPackageSmoke = fs.readFileSync(
    path.join(workspaceRoot, "scripts/check-installed-package.mjs"),
    "utf8",
  );
  const electronAsarCheck = fs.readFileSync(
    path.join(workspaceRoot, "scripts/check-electron-asar.mjs"),
    "utf8",
  );
  const electronAsarSmoke = fs.readFileSync(
    path.join(workspaceRoot, "scripts/fixtures/electron-asar-smoke.cjs"),
    "utf8",
  );
  const distroPackageSmoke = fs.readFileSync(
    path.join(workspaceRoot, "scripts/fixtures/distro-package-smoke.sh"),
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
  assert.match(release, /watchbound-qualification-plan/u);
  assert.match(release, /actions\/download-artifact@/u);
  assert.match(release, /select-release-plan\.mjs/u);
  assert.match(release, /candidate_version: \$\{\{ needs\.plan\.outputs\.version \}\}/u);
  assert.match(release, /\.github\/actions\/materialize-release-candidate/u);
  assert.match(release, /verify-release-candidate\.mjs/u);
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
    "release-armv7-runtime": ["plan", "aggregate"],
    "release-distro": ["plan", "aggregate"],
    "release-electron": ["plan", "aggregate"],
    "release-kernel-baseline": ["plan", "aggregate"],
    "release-overflow": ["plan", "aggregate"],
    "qualification-verified": [
      "plan",
      "tests",
      "aggregate",
      "release-armv7-runtime",
      "release-distro",
      "release-electron",
      "release-kernel-baseline",
      "release-overflow",
    ],
    release: [
      "plan",
      "tests",
      "aggregate",
      "release-armv7-runtime",
      "release-distro",
      "release-electron",
      "release-kernel-baseline",
      "release-overflow",
    ],
    "registry-smoke": ["plan", "release"],
    "registry-armv7-smoke": ["plan", "release"],
    verified: ["registry-smoke", "registry-armv7-smoke"],
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
  assert.match(release, /^  release-armv7-runtime:$/mu);
  assert.match(release, /^  release-electron:$/mu);
  assert.match(release, /^  release-kernel-baseline:$/mu);
  assert.match(release, /^  release-overflow:$/mu);
  assert.match(release, /^  qualification-verified:$/mu);
  assert.match(release, /^  registry-smoke:$/mu);
  assert.match(release, /^  registry-armv7-smoke:$/mu);
  assert.match(release, /compare-native-builds\.mjs/u);
  assert.match(release, /aggregate-native-builds\.mjs/u);
  assert.match(release, /check-registry-packages\.mjs/u);
  assert.match(release, /WATCHBOUND_CANONICAL_NATIVE_DIR/u);
  assert.match(release, /watchbound-approved-native-matrix/u);
  assert.match(release, /ubuntu-22\.04/u);
  assert.match(release, /glibc 2\.35/u);
  assert.match(release, /check-electron-asar\.mjs/u);
  assert.match(release, /run-kernel-baseline-qualification\.mjs/u);
  assert.match(
    release,
    /gcc-arm-linux-gnueabihf \\\n\s+libc6-dev-armhf-cross/u,
  );
  assert.match(release, /--profile kernel/u);
  assert.match(release, /--prepared-rootfs/u);
  assert.match(release, /cp -a "\$host_node_root\/lib\/node_modules\/npm"/u);
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
  assert.match(
    release,
    /- name: Configure isolated release homes[\s\S]*?cargo_home="\$RUNNER_TEMP\/release-cargo-home"[\s\S]*?echo "CARGO_HOME=\$cargo_home" >> "\$GITHUB_ENV"[\s\S]*?echo "RUSTUP_HOME=\$RUNNER_TEMP\/release-rustup" >> "\$GITHUB_ENV"/u,
  );
  assert.doesNotMatch(release, /\/opt\/hostedtoolcache\/cargo/u);
  assert.doesNotMatch(release, /NPM_BOOTSTRAP_TOKEN/u);
  assert.doesNotMatch(release, /^\s*- uses: [^\s]+@v\d+(?:\.\d+)*\s*$/mu);
  assert.doesNotMatch(ci, /workflow_dispatch/u);
  assert.match(ci, /^  workflow_call:\n    inputs:\n      candidate_sha:/mu);
  assert.match(ci, /inputs\.candidate_sha \|\| github\.sha/u);
  assert.match(ci, /^      candidate_version:/mu);
  assert.match(ci, /inputs\.candidate_version != ''/u);
  assert.match(ci, /\.github\/actions\/materialize-release-candidate/u);
  assert.match(ci, /^  push:\n    branches-ignore: \[main\]$/mu);
  assert.match(ci, /fromJSON\(needs\.matrix\.outputs\.source\)/u);
  assert.match(ci, /fromJSON\(needs\.matrix\.outputs\.qualification\)/u);
  assert.match(ci, /fromJSON\(needs\.matrix\.outputs\.kernel\)/u);
  assert.match(ci, /check-electron-asar\.mjs/u);
  assert.match(ci, /run-distro-qualification\.mjs/u);
  assert.match(ci, /run-kernel-baseline-qualification\.mjs/u);
  assert.match(
    ci,
    /gcc-arm-linux-gnueabihf \\\n\s+libc6-dev-armhf-cross/u,
  );
  assert.match(ci, /--profile kernel/u);
  assert.match(ci, /--prepared-rootfs/u);
  assert.match(ci, /cp -a "\$host_node_root\/lib\/node_modules\/npm"/u);
  assert.match(ci, /nix flake check --no-update-lock-file/u);
  assert.doesNotMatch(ci, /^\s*- uses: [^\s]+@v\d+(?:\.\d+)*\s*$/mu);

  assert.match(config, /branches: \["main"\]/u);
  assert.match(config, /@semantic-release\/commit-analyzer/u);
  assert.match(config, /@semantic-release\/release-notes-generator/u);
  assert.match(config, /semantic-release-watchbound\.mjs/u);
  assert.match(config, /@semantic-release\/github/u);
  assert.match(config, /dist\/evidence\/SHA256SUMS/u);

  assert.match(plugin, /scripts\/set-release-version\.mjs/u);
  assert.match(plugin, /assertWorkspaceVersion\(workspaceRoot, SOURCE_VERSION\)/u);
  assert.match(plugin, /verifyReleaseCandidate/u);
  assert.doesNotMatch(plugin, /committedVersion/u);
  assert.match(plugin, /pnpm", \["check:reproducible"\]/u);
  assert.match(plugin, /pnpm", \["test:packages"\]/u);
  assert.match(plugin, /installCanonicalNativeMatrix/u);
  assert.match(plugin, /assertReleaseTargetsQualified/u);
  assert.match(plugin, /registry integrity mismatch/u);
  assert.match(plugin, /publication-ledger\.json/u);
  assert.match(kernelBaseline, /readPreparedArmhfKernelRuntime/u);
  assert.match(kernelBaseline, /ELECTRON_RUN_AS_NODE/u);
  assert.match(kernelBaseline, /spawnSync\(artifactSet\.qemuSystem/u);
  assert.match(plugin, /async function npmPackageState/u);
  assert.match(plugin, /\["view", specifier, "--json"\]/u);
  assert.match(plugin, /preflightNpmNamespaces\(packages\)/u);
  assert.match(plugin, /0\.0\.0-bootstrap\.0/u);
  assert.match(plugin, /linux-arm-gnueabihf/u);
  assert.doesNotMatch(plugin, /deno", \["info"/u);
  assert.doesNotMatch(plugin, /minimum-dependency-age/u);
  assert.match(plugin, /https:\/\/jsr\.io\/@/u);
  assert.match(plugin, /meta\.json/u);
  assert.match(plugin, /installExactJsrNative/u);
  assert.match(
    plugin,
    /\["publish", "--dry-run", "--allow-dirty", "--no-check"\]/u,
  );
  assert.match(
    plugin,
    /\["publish", "--allow-dirty", "--no-check"\]/u,
  );
  assert.match(plugin, /"publish"/u);
  assert.match(plugin, /"--provenance"/u);
  assert.doesNotMatch(plugin, /NPM_TOKEN|NODE_AUTH_TOKEN/u);
  assert.match(
    recordNativeBuild,
    /rustFlags: requiredEnvironment\("RUSTFLAGS"\)/u,
  );
  assert.match(recordNativeBuild, /schemaVersion: 2/u);
  assert.match(recordNativeBuild, /materialization: candidate/u);
  assert.match(compareNativeBuilds, /schemaVersion: 2/u);
  assert.match(compareNativeBuilds, /manifest\.source\.materialization/u);
  assert.match(aggregateNativeBuilds, /INDEPENDENT_NATIVE_MATRIX_EVIDENCE/u);
  assert.match(aggregateNativeBuilds, /candidate,/u);
  assert.match(generateReleaseEvidence, /readOptionalEvidence/u);
  assert.match(generateReleaseEvidence, /INDEPENDENT_NATIVE_MATRIX_EVIDENCE/u);
  assert.match(
    compareNativeBuilds,
    /--remap-path-prefix=\$\{manifest\.isolation\.cargoHome\}=\/watchbound\/cargo-home/u,
  );
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
  assert.match(kernelBaseline, /installed-package-smoke-helpers\.mjs/u);
  assert.match(
    kernelBaseline,
    /const KERNEL_ARM64_GUEST_WAIT_TIMEOUT_MS = 30_000;/u,
  );
  assert.match(
    kernelBaseline,
    /target\.architecture === "arm64"[\s\S]*?KERNEL_ARM64_GUEST_WAIT_TIMEOUT_MS/u,
  );
  assert.match(
    kernelBaseline,
    /Math\.max\([\s\S]*?KERNEL_ARM64_GUEST_WAIT_TIMEOUT_MS,[\s\S]*?KERNEL_ARM_GUEST_WAIT_TIMEOUT_MS,[\s\S]*?\) <= MAX_INSTALLED_SMOKE_WAIT_TIMEOUT_MS/u,
  );
  assert.match(
    kernelBaseline,
    /variables\.WATCHBOUND_WAIT_TIMEOUT_MS = String\(waitTimeoutMs\)/u,
  );
  assert.match(kernelBaseline, /WATCHBOUND_KERNEL_BASELINE_STATUS=passed/u);
  assert.match(kernelBaseline, /exclusion-smoke-helpers\.cjs/u);
  assert.match(installedPackageSmoke, /options\["wait-timeout-ms"\]/u);
  assert.match(
    installedPackageSmoke,
    /hasInvalidatedPathAtOrBelow\(batches, initialExcluded, 0n\)/u,
  );
  assert.match(
    installedPackageSmoke,
    /hasInvalidatedPathAtOrBelow\(batches, dynamicExcluded, 1n\)/u,
  );
  assert.match(
    electronAsarSmoke,
    /hasInvalidatedPathAtOrBelow\(batches, excluded, 0n\)/u,
  );
  assert.match(electronAsarCheck, /exclusion-smoke-helpers\.cjs/u);
  assert.match(distroPackageSmoke, /--wait-timeout-ms/u);
  assert.match(selectReleasePlan, /watchbound-release-plan/u);
  assert.match(selectReleasePlan, /plan\.schemaVersion, 2/u);
  assert.match(selectReleasePlan, /plan\.sourceVersion, SOURCE_VERSION/u);
  assert.match(selectReleasePlan, /plan\.sourceSha/u);
  assert.match(selectReleasePlan, /git", \["rev-parse", "HEAD"\]/u);
  assert.match(selectReleasePlan, /will-release=/u);
  assert.match(planRelease, /sourceVersion: SOURCE_VERSION/u);
  assert.match(planRelease, /version: result\.nextRelease\.version/u);
  assert.doesNotMatch(planRelease, /committed candidate/u);
  assert.match(checkSourceVersion, /WATCHBOUND_CANDIDATE_VERSION/u);
  assert.match(checkSourceVersion, /assertCommittedSourceVersion/u);
  assert.match(checkSourceVersion, /verifyReleaseCandidate/u);
  assert.match(materializeAction, /WATCHBOUND_CANDIDATE_SHA=.*GITHUB_ENV/su);
  assert.match(materializeAction, /WATCHBOUND_CANDIDATE_VERSION=.*GITHUB_ENV/su);
  assert.match(flake, /eachSystem \[ "x86_64-linux" "aarch64-linux" \]/u);
  assert.match(flake, /electron-v\$\{matrix\.codexRuntime\.electron\}-linux-/u);
  assert.match(flake, /target\.codexElectron\.sha256SRI/u);
  assert.match(flake, /patchelf/u);
  assert.match(flake, /generate-nix-package\.mjs/u);
  assert.match(flake, /asar pack/u);
  assert.match(flake, /exclusion-smoke-helpers\.cjs/u);
  assert.doesNotMatch(flake, /npm (?:install|ci)/u);
});

test("workflow artifact handoffs survive partial reruns", () => {
  const release = fs.readFileSync(
    path.join(workspaceRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  const ci = fs.readFileSync(
    path.join(workspaceRoot, ".github/workflows/ci.yml"),
    "utf8",
  );

  assert.equal(
    ci.match(
      /^          name: watchbound-ci-native-\$\{\{ matrix\.target \}\}$/gmu,
    )?.length,
    6,
  );
  assert.equal(
    ci.match(/^          overwrite: true$/gmu)?.length,
    2,
  );
  assert.doesNotMatch(
    ci,
    /^          name: watchbound-ci-native-[^\n]*github\.run_attempt/mu,
  );

  assert.equal(
    release.match(/^          overwrite: true$/gmu)?.length,
    5,
  );
  assert.match(release, /^          name: watchbound-release-plan$/mu);
  assert.match(release, /^          name: watchbound-qualification-plan$/mu);
  assert.match(
    release,
    /^          name: watchbound-native-\$\{\{ matrix\.target \}\}-\$\{\{ matrix\.builder \}\}$/mu,
  );
  assert.match(
    release,
    /^          name: watchbound-approved-target-\$\{\{ matrix\.target \}\}$/mu,
  );
  assert.match(
    release,
    /^          pattern: watchbound-approved-target-\*$/mu,
  );
  assert.match(
    release,
    /^          name: watchbound-approved-native-matrix$/mu,
  );
  assert.doesNotMatch(
    release,
    /^          (?:name|pattern): (?:watchbound-release-plan|watchbound-qualification-plan|watchbound-native-|watchbound-approved-)[^\n]*github\.run_attempt/mu,
  );
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

test("JSR existence checks immutable exact-version metadata without Deno policy", async () => {
  const requests = [];
  const fetchMetadata = async (...args) => {
    requests.push(args);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          manifest: { "/index.js": { size: 1, checksum: "sha256-example" } },
          exports: { ".": "./index.js" },
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
      async (...args) => {
        requests.push(args);
        return { ok: false, status: 404 };
      },
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
  assert.deepEqual(
    requests.map(([url]) => url),
    [
      "https://jsr.io/@gadicc/watchbound/1.0.1_meta.json",
      "https://jsr.io/@gadicc/watchbound/1.0.2_meta.json",
      "https://jsr.io/@gadicc/watchbound/1.0.0_meta.json",
    ],
  );
  for (const [, options] of requests) {
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers.accept, "application/json");
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("JSR visibility polling is bounded and stops as soon as the version appears", async () => {
  const probes = [];
  const sleeps = [];
  const visible = await waitForJsrPackage("jsr:@gadicc/watchbound@1.0.1", {
    attempts: 5,
    pollIntervalMs: 7,
    packageExists: async (specifier) => {
      probes.push(specifier);
      return probes.length === 3;
    },
    sleep: async (duration) => sleeps.push(duration),
  });

  assert.equal(visible, true);
  assert.deepEqual(probes, Array(3).fill("jsr:@gadicc/watchbound@1.0.1"));
  assert.deepEqual(sleeps, [7, 7]);

  let missingProbes = 0;
  const missingSleeps = [];
  assert.equal(
    await waitForJsrPackage("jsr:@gadicc/watchbound@1.0.2", {
      packageExists: async () => {
        missingProbes += 1;
        return false;
      },
      sleep: async (duration) => missingSleeps.push(duration),
    }),
    false,
  );
  assert.equal(missingProbes, 60);
  assert.deepEqual(missingSleeps, Array(59).fill(5_000));
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
      "/tmp/gadicc-watchbound-node-9.8.7.tgz",
      "/tmp/gadicc-watchbound-node-linux-arm64-gnu-9.8.7.tgz",
    ],
  );
  assert.deepEqual(calls[0][1].slice(-2), [
    "/tmp/gadicc-watchbound-node-9.8.7.tgz",
    "/tmp/gadicc-watchbound-node-linux-arm64-gnu-9.8.7.tgz",
  ]);
  assert.ok(calls[0][1].includes("--offline"));
});

test("spent JSR recoveries cannot be dispatched or reused", () => {
  for (const relativePath of [
    ".github/workflows/recover-jsr-v1.yml",
    ".github/workflows/recover-jsr-v1-0-1.yml",
    ".github/workflows/recover-jsr-v1-1-0.yml",
    "scripts/recover-jsr-v1-0-1.mjs",
    "scripts/recover-jsr-v1-1-0.mjs",
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
