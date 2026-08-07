import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  armhfSnapshotSourceRewrite,
  assertArmhfSnapshotSources,
  readPreparedArmhfKernelRuntime,
  readPreparedArmhfRuntime,
} from "../../scripts/lib/armhf-runtime.mjs";
import { loadNativeMatrix, targetForId } from "../../scripts/lib/native-matrix.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../..");
const matrix = loadNativeMatrix(workspaceRoot);
const target = targetForId(matrix, "linux-arm-gnueabihf");

test("ARMHF snapshot source rewriting preserves the existing suite separator", () => {
  const snapshot = target.runtimeRootfs.snapshot;
  const rewrite = armhfSnapshotSourceRewrite(snapshot);
  const sourceList = "deb http://ports.ubuntu.com/ubuntu-ports/ jammy main restricted\n";
  const rewritten = sourceList.replaceAll(rewrite.source, rewrite.destination);

  assert.equal(
    rewritten,
    `deb http://snapshot.ubuntu.com/ubuntu/${snapshot} jammy main restricted\n`,
  );
  assertArmhfSnapshotSources(rewritten, snapshot);
});

test("prepared ARMHF runtime evidence is bound to its target and package manifest", () => {
  const rootfs = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-armhf-runtime-"));
  const packageDatabase = Buffer.from("Package: libc6\nArchitecture: armhf\n");
  fs.mkdirSync(path.join(rootfs, "var/lib/dpkg"), { recursive: true });
  fs.writeFileSync(path.join(rootfs, "var/lib/dpkg/status"), packageDatabase);
  const installedPackages = target.runtimeRootfs.packages
    .map((name) => `${name}:armhf\t1`)
    .sort();
  const evidence = {
    schemaVersion: 1,
    kind: "watchbound-armhf-runtime-rootfs",
    target: target.id,
    status: "prepared",
    profile: "runtime",
    platform: target.runtimeRootfs.platform,
    image: target.runtimeRootfs.image,
    binfmtImage: target.runtimeRootfs.binfmtImage,
    imageIdentity: `linux/arm/v7 sha256:${"0".repeat(64)}`,
    snapshot: target.runtimeRootfs.snapshot,
    operatingSystem: { id: "ubuntu", version: "22.04" },
    architecture: "armhf",
    requestedPackages: target.runtimeRootfs.packages,
    profilePackages: [],
    certificateBootstrap: "signed-snapshot-metadata-before-tls-peer-verification",
    installedPackages,
    installedPackageManifestSha256: crypto
      .createHash("sha256")
      .update(`${installedPackages.join("\n")}\n`)
      .digest("hex"),
    packageDatabaseSha256: crypto
      .createHash("sha256")
      .update(packageDatabase)
      .digest("hex"),
  };
  fs.writeFileSync(
    path.join(rootfs, "watchbound-armhf-runtime.json"),
    `${JSON.stringify(evidence)}\n`,
  );

  assert.deepEqual(readPreparedArmhfRuntime(rootfs, target), evidence);

  evidence.installedPackages[0] = "libc6:armhf\t999";
  fs.writeFileSync(
    path.join(rootfs, "watchbound-armhf-runtime.json"),
    `${JSON.stringify(evidence)}\n`,
  );
  assert.throws(
    () => readPreparedArmhfRuntime(rootfs, target),
    /Expected values to be strictly/u,
  );
});

test("prepared ARMHF kernel evidence pins package versions, kernel, and initrd", () => {
  const rootfs = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-armhf-kernel-"));
  const artifact = structuredClone(matrix.kernelBaselineQualification.artifacts.arm);
  const kernel = Buffer.from("kernel");
  const initrd = Buffer.from("initrd");
  artifact.rootfs.kernelSha256 = crypto.createHash("sha256").update(kernel).digest("hex");
  const baseline = {
    artifacts: { arm: artifact },
  };
  const packageDatabase = Buffer.from("Package: linux-image\nArchitecture: armhf\n");
  const kernelPath = path.join(rootfs, artifact.rootfs.kernelPath.replace(/^\//u, ""));
  const initrdPath = path.join(rootfs, artifact.rootfs.initrdPath.replace(/^\//u, ""));
  fs.mkdirSync(path.dirname(kernelPath), { recursive: true });
  fs.mkdirSync(path.join(rootfs, "var/lib/dpkg"), { recursive: true });
  fs.writeFileSync(kernelPath, kernel);
  fs.writeFileSync(initrdPath, initrd);
  fs.writeFileSync(path.join(rootfs, "var/lib/dpkg/status"), packageDatabase);
  const installedPackages = [
    ...target.runtimeRootfs.packages.map((name) => `${name}:armhf\t1`),
    ...artifact.rootfs.packages.map(({ name, version }) => `${name}:armhf\t${version}`),
  ].sort();
  const evidence = {
    schemaVersion: 1,
    kind: "watchbound-armhf-runtime-rootfs",
    target: target.id,
    status: "prepared",
    profile: "kernel",
    platform: target.runtimeRootfs.platform,
    image: target.runtimeRootfs.image,
    binfmtImage: target.runtimeRootfs.binfmtImage,
    imageIdentity: `linux/arm/v7 sha256:${"0".repeat(64)}`,
    snapshot: target.runtimeRootfs.snapshot,
    operatingSystem: { id: "ubuntu", version: "22.04" },
    architecture: "armhf",
    requestedPackages: target.runtimeRootfs.packages,
    profilePackages: artifact.rootfs.packages,
    certificateBootstrap: "signed-snapshot-metadata-before-tls-peer-verification",
    installedPackages,
    installedPackageManifestSha256: crypto
      .createHash("sha256")
      .update(`${installedPackages.join("\n")}\n`)
      .digest("hex"),
    packageDatabaseSha256: crypto.createHash("sha256").update(packageDatabase).digest("hex"),
    kernel: {
      release: artifact.kernelRelease,
      path: artifact.rootfs.kernelPath,
      sha256: artifact.rootfs.kernelSha256,
      initrdPath: artifact.rootfs.initrdPath,
      initrdSha256: crypto.createHash("sha256").update(initrd).digest("hex"),
      requiredInitrdModules: artifact.rootfs.requiredInitrdModules,
    },
  };
  fs.writeFileSync(
    path.join(rootfs, "watchbound-armhf-runtime.json"),
    `${JSON.stringify(evidence)}\n`,
  );

  assert.deepEqual(readPreparedArmhfKernelRuntime(rootfs, target, baseline), evidence);
  fs.appendFileSync(initrdPath, "tampered");
  assert.throws(
    () => readPreparedArmhfKernelRuntime(rootfs, target, baseline),
    /Expected values to be strictly equal/u,
  );
});
