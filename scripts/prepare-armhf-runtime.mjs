import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeMatrix, targetForId } from "./lib/native-matrix.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const matrix = loadNativeMatrix(workspaceRoot);
const target = targetForId(matrix, options.target);
assert.equal(target.runtimeQualification, "qemu-user-electron");
assert.ok(target.runtimeRootfs, `${target.id} has no runtime rootfs contract`);

const outputRoot = path.resolve(options.output);
const evidencePath = path.resolve(options.evidence);
const temporaryRoot = path.resolve(process.env.RUNNER_TEMP ?? os.tmpdir());
assert.notEqual(outputRoot, path.parse(outputRoot).root, "runtime rootfs cannot be a filesystem root");
assert.notEqual(outputRoot, workspaceRoot, "runtime rootfs cannot replace the workspace");
assert.equal(
  outputRoot.startsWith(`${temporaryRoot}${path.sep}`),
  true,
  "runtime rootfs must be inside RUNNER_TEMP or the platform temporary directory",
);
assert.equal(
  evidencePath.startsWith(`${temporaryRoot}${path.sep}`),
  true,
  "runtime evidence must be inside RUNNER_TEMP or the platform temporary directory",
);

fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.rmSync(outputRoot, { recursive: true, force: true });

run("docker", [
  "pull",
  "--platform",
  target.runtimeRootfs.platform,
  target.runtimeRootfs.image,
]);
const imageIdentity = capture("docker", [
  "image",
  "inspect",
  "--format",
  "{{.Os}}/{{.Architecture}}/{{.Variant}} {{.Id}}",
  target.runtimeRootfs.image,
]);
assert.match(imageIdentity, /^linux\/arm\/v7 sha256:[0-9a-f]{64}$/u);

let containerId;
let containerRunning = false;
const archivePath = path.join(path.dirname(outputRoot), `${path.basename(outputRoot)}.tar`);
const policyPath = path.join(
  temporaryRoot,
  `.watchbound-policy-rc-${process.pid}-${path.basename(outputRoot)}`,
);
let architecture;
let packageManifest;
let sourceList;
let preparationError;
try {
  containerId = capture("docker", [
    "create",
    "--entrypoint",
    "/bin/sleep",
    "--platform",
    target.runtimeRootfs.platform,
    target.runtimeRootfs.image,
    "infinity",
  ]);
  assert.match(containerId, /^[0-9a-f]{64}$/u);
  run("docker", ["start", containerId]);
  containerRunning = true;
  assert.equal(
    capture("docker", ["inspect", "--format", "{{.State.Running}}", containerId]),
    "true",
    "ARMHF container did not start; configure the pinned binfmt image first",
  );
  run("docker", [
    "exec",
    containerId,
    "sed",
    "--in-place",
    `s#http://ports.ubuntu.com/ubuntu-ports/#http://snapshot.ubuntu.com/ubuntu/${target.runtimeRootfs.snapshot} #g`,
    "/etc/apt/sources.list",
  ]);
  fs.writeFileSync(policyPath, "#!/bin/sh\nexit 101\n");
  run("docker", ["cp", policyPath, `${containerId}:/usr/sbin/policy-rc.d`]);
  run("docker", ["exec", containerId, "chmod", "755", "/usr/sbin/policy-rc.d"]);

  const snapshotAptOptions = [
    "-o",
    "Acquire::Check-Valid-Until=false",
    "-o",
    "APT::Sandbox::User=root",
  ];
  runInContainer([
    "apt-get",
    ...snapshotAptOptions,
    "-o",
    "Acquire::https::Verify-Peer=false",
    "update",
  ]);
  runInContainer([
    "/usr/bin/env",
    "DEBIAN_FRONTEND=noninteractive",
    "apt-get",
    ...snapshotAptOptions,
    "-o",
    "Acquire::https::Verify-Peer=false",
    "install",
    "--yes",
    "--no-install-recommends",
    "ca-certificates",
  ]);
  runInContainer(["rm", "-rf", "/var/lib/apt/lists"]);
  runInContainer(["mkdir", "-p", "/var/lib/apt/lists/partial"]);
  runInContainer(["apt-get", ...snapshotAptOptions, "update"]);
  runInContainer([
    "/usr/bin/env",
    "DEBIAN_FRONTEND=noninteractive",
    "apt-get",
    ...snapshotAptOptions,
    "install",
    "--yes",
    "--no-install-recommends",
    ...target.runtimeRootfs.packages,
  ]);

  architecture = captureInContainer(["dpkg", "--print-architecture"]);
  packageManifest = captureInContainer([
    "dpkg-query",
    "--show",
    "--showformat=${binary:Package}\t${Version}\n",
  ]).trim().split("\n").filter(Boolean).sort();
  sourceList = captureInContainer(["cat", "/etc/apt/sources.list"]);
  run("docker", ["stop", "--time", "10", containerId]);
  containerRunning = false;
  run("docker", ["export", "--output", archivePath, containerId]);
} catch (error) {
  preparationError = error;
  throw error;
} finally {
  fs.rmSync(policyPath, { force: true });
  if (containerId) {
    try {
      cleanupContainer(containerId, containerRunning);
    } catch (cleanupError) {
      if (!preparationError) throw cleanupError;
      process.stderr.write(`Container cleanup also failed: ${cleanupError.message}\n`);
    }
  }
}
fs.mkdirSync(outputRoot, { recursive: true });
run("tar", [
  "--extract",
  "--same-permissions",
  "--file",
  archivePath,
  "--directory",
  outputRoot,
]);
fs.rmSync(archivePath);
assert.equal(fs.statSync(path.join(outputRoot, "tmp")).mode & 0o7777, 0o1777);

const osRelease = readKeyValueFile(path.join(outputRoot, "etc/os-release"));
assert.equal(osRelease.ID, "ubuntu");
assert.equal(osRelease.VERSION_ID, "22.04");
assert.equal(architecture, "armhf");
const installedNames = new Set(packageManifest.map((line) =>
  line.split("\t", 1)[0].replace(/:armhf$/u, "")));
for (const packageName of target.runtimeRootfs.packages) {
  assert.ok(installedNames.has(packageName), `runtime rootfs omits ${packageName}`);
}
const packageManifestText = `${packageManifest.join("\n")}\n`;
const packageDatabase = path.join(outputRoot, "var/lib/dpkg/status");
assert.match(
  sourceList,
  new RegExp(`^deb http://snapshot\\.ubuntu\\.com/ubuntu/${target.runtimeRootfs.snapshot} jammy`, "mu"),
);
assert.doesNotMatch(sourceList, /ports\.ubuntu\.com/u);

const evidence = {
  schemaVersion: 1,
  kind: "watchbound-armhf-runtime-rootfs",
  target: target.id,
  status: "prepared",
  platform: target.runtimeRootfs.platform,
  image: target.runtimeRootfs.image,
  binfmtImage: target.runtimeRootfs.binfmtImage,
  imageIdentity,
  snapshot: target.runtimeRootfs.snapshot,
  operatingSystem: {
    id: osRelease.ID,
    version: osRelease.VERSION_ID,
  },
  architecture,
  requestedPackages: target.runtimeRootfs.packages,
  certificateBootstrap: "signed-snapshot-metadata-before-tls-peer-verification",
  installedPackages: packageManifest,
  installedPackageManifestSha256: sha256(Buffer.from(packageManifestText)),
  packageDatabaseSha256: sha256(fs.readFileSync(packageDatabase)),
};
writeJson(path.join(outputRoot, "watchbound-armhf-runtime.json"), evidence);
writeJson(evidencePath, evidence);
process.stdout.write(
  `Prepared pinned ${target.id} rootfs with ${packageManifest.length} packages\n`,
);

function runInContainer(command) {
  run("docker", ["exec", containerId, ...command]);
}

function captureInContainer(command) {
  return capture("docker", ["exec", containerId, ...command]);
}

function cleanupContainer(id, running) {
  const args = running ? ["rm", "--force", id] : ["rm", id];
  const result = spawnSync("docker", args, {
    cwd: workspaceRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker cleanup failed with status ${result.status}`);
  }
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: prepare-armhf-runtime.mjs --target <id> --output <rootfs> --evidence <path>",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  for (const required of ["target", "output", "evidence"]) {
    assert.ok(parsed[required], `--${required} is required`);
  }
  return parsed;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function readKeyValueFile(source) {
  const fields = {};
  for (const line of fs.readFileSync(source, "utf8").split(/\r?\n/u)) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line);
    if (!match) continue;
    fields[match[1]] = match[2].replace(/^"(.*)"$/u, "$1");
  }
  return fields;
}

function writeJson(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}
