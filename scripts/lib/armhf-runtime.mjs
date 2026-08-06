import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function readPreparedArmhfRuntime(rootfs, target) {
  const source = path.join(path.resolve(rootfs), "watchbound-armhf-runtime.json");
  const evidence = JSON.parse(fs.readFileSync(source, "utf8"));
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.kind, "watchbound-armhf-runtime-rootfs");
  assert.equal(evidence.status, "prepared");
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
  assert.equal(
    evidence.installedPackageManifestSha256,
    crypto.createHash("sha256")
      .update(`${evidence.installedPackages.join("\n")}\n`)
      .digest("hex"),
  );
  assert.equal(
    evidence.packageDatabaseSha256,
    crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(path.resolve(rootfs), "var/lib/dpkg/status")))
      .digest("hex"),
  );
  return evidence;
}
