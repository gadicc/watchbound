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
  const kernelBaseline = matrix.kernelBaselineQualification;
  assert.equal(kernelBaseline.classification, "qemu-kernel-floor-component");
  assert.equal(kernelBaseline.distribution, matrix.releaseBaseline.distribution);
  assert.equal(kernelBaseline.version, matrix.releaseBaseline.version);
  assert.equal(kernelBaseline.kernelSeries, matrix.releaseBaseline.kernelMinimum);
  assert.match(kernelBaseline.kernelRelease, /^5\.15\.0-[1-9][0-9]*-generic$/u);
  assert.match(kernelBaseline.image, /@sha256:[0-9a-f]{64}$/u);
  for (const architecture of ["x64", "arm64"]) {
    const artifactSet = kernelBaseline.artifacts[architecture];
    assert.ok(artifactSet, `kernel baseline omits ${architecture}`);
    assert.match(artifactSet.qemuSystem, /^qemu-system-(?:x86_64|aarch64)$/u);
    assert.match(artifactSet.qemuPackage, /^qemu-system-(?:x86|arm)$/u);
    for (const artifact of [artifactSet.kernel, artifactSet.initrd]) {
      assert.match(artifact.url, /^https:\/\/cloud-images\.ubuntu\.com\/releases\/server\/jammy\/release-[0-9]{8}\/unpacked\//u);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
    }
  }
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
    assert.match(target.id, /^linux-(?:x64-gnu|arm64-gnu|arm-gnueabihf)$/u);
    assert.equal(target.platform, "linux");
    assert.ok(["x64", "arm64", "arm"].includes(target.architecture));
    assert.match(
      target.rustTarget,
      /^(?:x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu|armv7-unknown-linux-gnueabihf)$/u,
    );
    assert.equal(target.libc, "glibc");
    if (target.architecture === "arm") {
      assert.deepEqual(target.armAbi, {
        version: 7,
        floatAbi: "hard",
        endianness: "little",
      });
      assert.equal(target.buildMode, "cross");
      assert.equal(target.buildArchitecture, "x64");
      assert.equal(target.linker, "arm-linux-gnueabihf-gcc");
      assert.equal(target.linkerBinary, "arm-linux-gnueabihf-ld");
      assert.equal(target.runtimeQualification, "qemu-user-electron");
      assert.equal(target.runtimeEmulator, "/usr/bin/qemu-arm");
      assert.equal(target.runtimeCpu, "cortex-a15");
      assert.equal(target.runtimeSysroot, "/usr/arm-linux-gnueabihf");
      assert.equal(target.overflowRunner, null);
      assert.equal(target.nixSystem, null);
    } else {
      assert.equal(target.armAbi, undefined);
      assert.equal(target.buildMode, undefined);
      assert.equal(
        target.overflowRunner,
        target.architecture === "x64" ? "ubuntu-24.04" : "ubuntu-24.04-arm",
      );
    }
    assert.equal(target.binary, `watchbound.${target.id}.node`);
    assert.equal(
      target.package,
      `@gadicc/watchbound-node-${target.id}`,
    );
    assert.ok(["target-pending-clean-ci", "supported"].includes(target.qualification));
    assert.equal(target.elf.class, target.architecture === "arm" ? 1 : 2);
    assert.equal(target.elf.endianness, 1);
    assert.ok(Number.isInteger(target.elf.machine));
    assert.ok(Number.isInteger(target.elf.flags));
    if (target.architecture === "arm") {
      assert.equal(target.elf.flags, 0x05000400);
      assert.equal(target.elf.flagsDescription, "Version5 EABI, hard-float ABI");
    } else {
      assert.equal(target.elf.flags, 0);
      assert.equal(target.elf.flagsDescription, undefined);
    }
    assert.ok(Array.isArray(target.elf.neededLibraries));
  }
  for (const lane of matrix.qualificationLanes) {
    assert.match(lane.id, /^[a-z0-9.-]+$/u);
    assert.ok(Array.isArray(lane.architectures) && lane.architectures.length > 0);
    assert.match(lane.image, /@sha256:[0-9a-f]{64}$/u);
    assert.ok([
      "runtime-qualification-required",
      "qemu-user-runtime-required",
      "native-nix-closure-required",
    ].includes(lane.evidence));
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
