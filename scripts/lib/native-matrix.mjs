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
  assert.match(matrix.nodeMinimum, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);
  assert.equal(
    matrix.nodeRange,
    `>=${matrix.nodeMinimum}`,
    "native matrix Node range must derive from its JavaScript floor without an upper bound",
  );
  assert.equal(matrix.nodeMinimum, "18.15.0", "native matrix JavaScript Node floor");
  assert.equal(matrix.nodeApiMinimum, 6, "native matrix Node-API floor");
  assert.equal(matrix.buildNode, "24.15.0", "native matrix build/qualification Node pin");
  validateTestedRuntimes(matrix.testedRuntimes, matrix);
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
  const armKernel = kernelBaseline.artifacts.arm;
  assert.equal(armKernel.qemuSystem, "qemu-system-arm");
  assert.equal(armKernel.qemuPackage, "qemu-system-arm");
  assert.equal(armKernel.machine, "virt");
  assert.equal(armKernel.cpu, "cortex-a15");
  assert.equal(armKernel.console, "ttyAMA0");
  assert.match(armKernel.kernelRelease, /^5\.15\.0-[1-9][0-9]*-generic-lpae$/u);
  assert.equal(armKernel.rootfs.profile, "kernel");
  assert.deepEqual(
    armKernel.rootfs.packages.map(({ name }) => name),
    [...armKernel.rootfs.packages.map(({ name }) => name)].sort(),
  );
  for (const artifactPackage of armKernel.rootfs.packages) {
    assert.match(artifactPackage.name, /^[a-z0-9][a-z0-9+.-]+$/u);
    assert.ok(artifactPackage.version.length > 0);
  }
  assert.equal(armKernel.rootfs.kernelPath, `/boot/vmlinuz-${armKernel.kernelRelease}`);
  assert.match(armKernel.rootfs.kernelSha256, /^[0-9a-f]{64}$/u);
  assert.equal(armKernel.rootfs.initrdPath, `/boot/initrd.img-${armKernel.kernelRelease}`);
  assert.deepEqual(armKernel.rootfs.requiredInitrdModules, ["virtio_blk"]);
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
    assert.equal(
      target.kernelRunner,
      target.architecture === "arm64" ? "ubuntu-24.04-arm" : "ubuntu-24.04",
      `${target.id} system-QEMU host runner`,
    );
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
      assert.equal(target.runtimeRunner, "ubuntu-24.04");
      assert.equal(target.runtimeEmulator, "/usr/bin/qemu-arm");
      assert.equal(target.runtimeCpu, "cortex-a15");
      assert.equal(target.runtimeRootfs.platform, "linux/arm/v7");
      assert.match(target.runtimeRootfs.image, /@sha256:[0-9a-f]{64}$/u);
      assert.match(target.runtimeRootfs.binfmtImage, /@sha256:[0-9a-f]{64}$/u);
      assert.match(target.runtimeRootfs.snapshot, /^20[0-9]{6}T[0-9]{6}Z$/u);
      assert.ok(
        Array.isArray(target.runtimeRootfs.packages) &&
          target.runtimeRootfs.packages.length > 0,
      );
      assert.deepEqual(
        [...target.runtimeRootfs.packages].sort(),
        target.runtimeRootfs.packages,
        "ARMHF runtime packages must be unique and sorted",
      );
      assert.equal(new Set(target.runtimeRootfs.packages).size, target.runtimeRootfs.packages.length);
      assert.equal(target.overflowRunner, null);
      assert.equal(target.nixSystem, null);
    } else {
      assert.equal(target.armAbi, undefined);
      assert.equal(target.buildMode, undefined);
      assert.equal(target.runtimeRunner, undefined);
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

function validateTestedRuntimes(tested, matrix) {
  assert.ok(tested && typeof tested === "object" && !Array.isArray(tested));
  assert.ok(Array.isArray(tested.node) && tested.node.length > 0);
  assert.ok(Array.isArray(tested.electron) && tested.electron.length > 0);
  assert.equal(new Set(tested.node.map(({ version }) => version)).size, tested.node.length);
  for (const runtime of tested.node) {
    assert.match(runtime.version, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);
    assert.ok(Array.isArray(runtime.architectures) && runtime.architectures.length > 0);
    assert.ok(runtime.architectures.every((architecture) => ["x64", "arm64"].includes(architecture)));
    assert.equal(new Set(runtime.architectures).size, runtime.architectures.length);
    assert.ok(["admission", "full-lifecycle"].includes(runtime.coverage));
    assert.match(runtime.role, /^[a-z0-9-]+$/u);
  }
  const minimum = tested.node.find(({ role }) => role === "javascript-minimum");
  assert.equal(minimum?.version, matrix.nodeMinimum);
  assert.equal(minimum?.coverage, "full-lifecycle");
  const regression = tested.node.find(({ role }) => role === "codex-electron-regression");
  assert.equal(regression?.version, "24.14.0");
  assert.equal(regression?.coverage, "full-lifecycle");
  const newest = tested.node.find(({ role }) => role === "newest-node");
  assert.equal(newest?.coverage, "full-lifecycle");
  assert.deepEqual(minimum.architectures, ["x64", "arm64"]);
  assert.deepEqual(newest.architectures, ["x64", "arm64"]);

  assert.equal(new Set(tested.electron.map(({ id }) => id)).size, tested.electron.length);
  for (const runtime of tested.electron) {
    assert.match(runtime.id, /^[a-z0-9-]+$/u);
    assert.match(runtime.electron, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);
    assert.match(runtime.node, /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);
    assert.ok(Number.isInteger(runtime.nodeApi) && runtime.nodeApi >= matrix.nodeApiMinimum);
    assert.equal(runtime.architecture, "x64");
    assert.equal(runtime.coverage, "full-lifecycle");
    assert.equal(runtime.archiveArchitecture, "x64");
    assert.match(runtime.archiveSha256, /^[0-9a-f]{64}$/u);
  }
  assert.equal(
    tested.electron.find(({ id }) => id === "oldest-supported")?.electron,
    "28.0.0",
  );
  assert.ok(tested.electron.some(({ id }) => id === "current"));
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
