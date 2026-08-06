import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function readPreparedArmhfRuntime(rootfs, target) {
  const evidence = readBaseEvidence(rootfs, target, "runtime");
  assert.deepEqual(evidence.profilePackages, []);
  return evidence;
}

export function readPreparedArmhfKernelRuntime(rootfs, target, baseline) {
  const evidence = readBaseEvidence(rootfs, target, "kernel");
  const artifact = baseline.artifacts[target.architecture];
  assert.deepEqual(evidence.profilePackages, artifact.rootfs.packages);
  for (const artifactPackage of artifact.rootfs.packages) {
    assert.equal(installedVersion(evidence, artifactPackage.name), artifactPackage.version);
  }
  assert.equal(evidence.kernel.release, artifact.kernelRelease);
  assert.equal(evidence.kernel.path, artifact.rootfs.kernelPath);
  assert.equal(evidence.kernel.sha256, artifact.rootfs.kernelSha256);
  assert.equal(evidence.kernel.initrdPath, artifact.rootfs.initrdPath);
  assert.deepEqual(
    evidence.kernel.requiredInitrdModules,
    artifact.rootfs.requiredInitrdModules,
  );
  const kernelPath = path.join(path.resolve(rootfs), artifact.rootfs.kernelPath.replace(/^\//u, ""));
  const initrdPath = path.join(path.resolve(rootfs), artifact.rootfs.initrdPath.replace(/^\//u, ""));
  assert.equal(sha256File(kernelPath), evidence.kernel.sha256);
  assert.equal(sha256File(initrdPath), evidence.kernel.initrdSha256);
  return evidence;
}

function readBaseEvidence(rootfs, target, profile) {
  const resolvedRootfs = path.resolve(rootfs);
  const source = path.join(resolvedRootfs, "watchbound-armhf-runtime.json");
  const evidence = JSON.parse(fs.readFileSync(source, "utf8"));
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.kind, "watchbound-armhf-runtime-rootfs");
  assert.equal(evidence.status, "prepared");
  assert.equal(evidence.profile, profile);
  assert.equal(evidence.target, target.id);
  assert.equal(evidence.platform, target.runtimeRootfs.platform);
  assert.equal(evidence.image, target.runtimeRootfs.image);
  assert.equal(evidence.binfmtImage, target.runtimeRootfs.binfmtImage);
  assert.match(evidence.imageIdentity, /^linux\/arm\/v7 sha256:[0-9a-f]{64}$/u);
  assert.equal(evidence.snapshot, target.runtimeRootfs.snapshot);
  assert.deepEqual(evidence.operatingSystem, { id: "ubuntu", version: "22.04" });
  assert.equal(evidence.architecture, "armhf");
  assert.deepEqual(evidence.requestedPackages, target.runtimeRootfs.packages);
  assert.equal(
    evidence.certificateBootstrap,
    "signed-snapshot-metadata-before-tls-peer-verification",
  );
  assert.ok(Array.isArray(evidence.installedPackages) && evidence.installedPackages.length > 0);
  assert.deepEqual([...evidence.installedPackages].sort(), evidence.installedPackages);
  for (const packageName of target.runtimeRootfs.packages) {
    assert.ok(installedVersion(evidence, packageName), `rootfs omits ${packageName}`);
  }
  assert.equal(
    evidence.installedPackageManifestSha256,
    crypto.createHash("sha256")
      .update(`${evidence.installedPackages.join("\n")}\n`)
      .digest("hex"),
  );
  assert.equal(
    evidence.packageDatabaseSha256,
    sha256File(path.join(resolvedRootfs, "var/lib/dpkg/status")),
  );
  return evidence;
}

function installedVersion(evidence, packageName) {
  const line = evidence.installedPackages.find((entry) =>
    entry.split("\t", 1)[0].replace(/:armhf$/u, "") === packageName);
  return line?.split("\t")[1];
}

function sha256File(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}
