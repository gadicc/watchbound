import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPreparedArmhfRuntime } from "../../scripts/lib/armhf-runtime.mjs";
import { loadNativeMatrix, targetForId } from "../../scripts/lib/native-matrix.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "../..");
const target = targetForId(
  loadNativeMatrix(workspaceRoot),
  "linux-arm-gnueabihf",
);

test("prepared ARMHF runtime evidence is bound to its target and package manifest", () => {
  const rootfs = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-armhf-runtime-"));
  const packageDatabase = Buffer.from("Package: libc6\nArchitecture: armhf\n");
  fs.mkdirSync(path.join(rootfs, "var/lib/dpkg"), { recursive: true });
  fs.writeFileSync(path.join(rootfs, "var/lib/dpkg/status"), packageDatabase);
  const installedPackages = ["libc6:armhf\t2.35-0ubuntu3.11"];
  const evidence = {
    schemaVersion: 1,
    kind: "watchbound-armhf-runtime-rootfs",
    target: target.id,
    status: "prepared",
    platform: target.runtimeRootfs.platform,
    image: target.runtimeRootfs.image,
    binfmtImage: target.runtimeRootfs.binfmtImage,
    imageIdentity: `linux/arm/v7 sha256:${"0".repeat(64)}`,
    snapshot: target.runtimeRootfs.snapshot,
    operatingSystem: { id: "ubuntu", version: "22.04" },
    architecture: "armhf",
    requestedPackages: target.runtimeRootfs.packages,
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
    /Expected values to be strictly equal/u,
  );
});
