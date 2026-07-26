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
const baseline = matrix.kernelBaselineQualification;
const artifactSet = baseline.artifacts[target.architecture];
assert.ok(artifactSet, `kernel baseline omits ${target.architecture}`);
assert.equal(options.image, baseline.image, "workflow image differs from the pinned kernel baseline");

const version = readJson(path.join(workspaceRoot, "package.json")).version;
const packageManifest = readJson(path.join(workspaceRoot, "dist/native-package-manifest.json"));
const packagedTarget = packageManifest.targets.find(({ id }) => id === target.id);
assert.ok(packagedTarget, `prepared tree omits ${target.id}`);
const nativePath = path.join(workspaceRoot, "dist", packagedTarget.root, target.binary);
const nativeSha256 = sha256(nativePath);
assert.equal(nativeSha256, packagedTarget.sha256);

const tarballRoot = path.join(workspaceRoot, "dist/tarballs");
const tarballs = {
  target: tarballName(target.package, version),
  loader: tarballName(packageManifest.loader.name, version),
  wrapper: tarballName(packageManifest.wrapper.name, version),
};
for (const filename of Object.values(tarballs)) {
  assert.ok(fs.existsSync(path.join(tarballRoot, filename)), `missing ${filename}`);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-kernel-baseline-"));
let containerId = null;
try {
  const rootfs = path.join(temporaryRoot, "rootfs");
  const exportTar = path.join(temporaryRoot, "rootfs.tar");
  const disk = path.join(temporaryRoot, "rootfs.ext4");
  const kernel = path.join(temporaryRoot, "vmlinuz");
  const initrd = path.join(temporaryRoot, "initrd");
  fs.mkdirSync(rootfs);

  run("docker", ["pull", baseline.image]);
  containerId = capture("docker", ["create", baseline.image]).trim();
  assert.match(containerId, /^[0-9a-f]{64}$/u, "docker create did not return a container id");
  run("docker", ["export", "--output", exportTar, containerId]);
  run("tar", ["--extract", "--file", exportTar, "--directory", rootfs, "--no-same-owner"]);

  copyTree(path.resolve(options["node-root"]), path.join(rootfs, "watchbound-node"));
  copyFiles(
    Object.values(tarballs).map((filename) => path.join(tarballRoot, filename)),
    path.join(rootfs, "packages"),
  );
  copyFiles(
    [
      path.join(workspaceRoot, "scripts/check-installed-package.mjs"),
      path.join(workspaceRoot, "scripts/fixtures/distro-package-smoke.sh"),
    ],
    path.join(rootfs, "work/scripts/fixtures"),
  );
  fs.renameSync(
    path.join(rootfs, "work/scripts/fixtures/check-installed-package.mjs"),
    path.join(rootfs, "work/scripts/check-installed-package.mjs"),
  );
  const guestInit = path.join(rootfs, "watchbound-init");
  fs.copyFileSync(path.join(workspaceRoot, "scripts/fixtures/kernel-baseline-init.sh"), guestInit);
  fs.chmodSync(guestInit, 0o755);
  fs.writeFileSync(
    path.join(rootfs, "etc/watchbound-kernel-baseline.env"),
    guestEnvironment({ baseline, nativeSha256, target, tarballs, version }),
  );

  fs.closeSync(fs.openSync(disk, "w"));
  fs.truncateSync(disk, 1536 * 1024 * 1024);
  run("mkfs.ext4", ["-q", "-F", "-d", rootfs, disk]);
  downloadChecked(artifactSet.kernel, kernel);
  downloadChecked(artifactSet.initrd, initrd);

  // This lane is correctness-only. Deliberately avoid KVM/nested-virtualization
  // variance and keep resource use bounded on shared hosted runners.
  const acceleration = "tcg-single-threaded";
  const qemuArgs = [
    "-machine", artifactSet.machine,
    "-accel", "tcg,thread=single",
    "-cpu", "max",
    "-smp", "1",
    "-m", "1024",
    "-display", "none",
    "-monitor", "none",
    "-serial", "stdio",
    "-nic", "none",
    "-no-reboot",
    "-kernel", kernel,
    "-initrd", initrd,
    "-append", `root=/dev/vda rw rootfstype=ext4 console=${artifactSet.console} init=/watchbound-init panic=-1`,
    "-drive", `if=none,id=rootdisk,format=raw,aio=threads,file=${disk}`,
    "-device", "virtio-blk-pci,drive=rootdisk",
  ];
  const qemu = spawnSync(artifactSet.qemuSystem, qemuArgs, {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20 * 60 * 1000,
  });
  const serial = `${qemu.stdout ?? ""}${qemu.stderr ?? ""}`;
  process.stdout.write(serial);
  if (qemu.error) throw qemu.error;
  assert.match(serial, /WATCHBOUND_KERNEL_BASELINE_STATUS=passed\r?$/mu);
  const encoded = serial.match(/^WATCHBOUND_KERNEL_BASELINE_EVIDENCE=([A-Za-z0-9+/=]+)\r?$/mu)?.[1];
  assert.ok(encoded, "kernel baseline guest did not return its smoke evidence");
  const smoke = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.equal(smoke.status, "passed");
  assert.equal(smoke.host.architecture, target.architecture);
  assert.equal(smoke.host.kernel, baseline.kernelRelease);
  assert.equal(smoke.host.glibc, "2.35");
  assert.equal(smoke.native.sha256, nativeSha256);

  const evidence = {
    schemaVersion: 1,
    kind: "watchbound-kernel-baseline-qualification",
    classification: {
      purpose: "kernel-floor correctness component",
      architectureEvidence: "not provided by this QEMU lane; require the separate native runner matrix",
      performance: "non-authoritative",
    },
    source: {
      gitHead: capture("git", ["rev-parse", "HEAD"]).trim(),
      gitDirty: capture("git", ["status", "--porcelain=v1", "--untracked-files=all"]).trim() !== "",
      version,
    },
    target: {
      id: target.id,
      architecture: target.architecture,
      nativeSha256,
      nativeBytes: fs.statSync(nativePath).size,
    },
    baseline: {
      distribution: `${baseline.distribution} ${baseline.version}`,
      kernelSeries: baseline.kernelSeries,
      kernelRelease: baseline.kernelRelease,
      glibc: "2.35",
      image: baseline.image,
      kernel: artifactSet.kernel,
      initrd: artifactSet.initrd,
    },
    host: {
      architecture: os.arch(),
      kernel: os.release(),
      qemu: firstLine(capture(artifactSet.qemuSystem, ["--version"])),
      acceleration,
    },
    guest: smoke,
  };
  const evidencePath = path.resolve(options.evidence);
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`Kernel ${baseline.kernelSeries} baseline passed for ${target.id}\n`);
} finally {
  if (containerId) {
    spawnSync("docker", ["rm", "--force", containerId], { stdio: "ignore" });
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

function guestEnvironment({ baseline: selectedBaseline, nativeSha256: nativeHash, target: selectedTarget, tarballs: selectedTarballs, version: selectedVersion }) {
  const variables = {
    WATCHBOUND_TARGET_ID: selectedTarget.id,
    WATCHBOUND_TARGET_PACKAGE: selectedTarget.package,
    WATCHBOUND_NODE_ARCH: selectedTarget.architecture,
    WATCHBOUND_UNAME_ARCHITECTURE: selectedTarget.unameArchitecture,
    WATCHBOUND_VERSION: selectedVersion,
    WATCHBOUND_NATIVE_SHA256: nativeHash,
    WATCHBOUND_LANE: `kernel-${selectedBaseline.distribution}-${selectedBaseline.version}-${selectedBaseline.kernelSeries}-qemu`,
    WATCHBOUND_TARGET_TARBALL: selectedTarballs.target,
    WATCHBOUND_LOADER_TARBALL: selectedTarballs.loader,
    WATCHBOUND_WRAPPER_TARBALL: selectedTarballs.wrapper,
    WATCHBOUND_EVIDENCE: "/tmp/watchbound-kernel-baseline-smoke.json",
    WATCHBOUND_KERNEL_RELEASE: selectedBaseline.kernelRelease,
  };
  return `${Object.entries(variables).map(([name, value]) => `export ${name}=${shellQuote(value)}`).join("\n")}\n`;
}

function downloadChecked(artifact, destination) {
  run("curl", ["--fail", "--location", "--retry", "3", "--output", destination, artifact.url]);
  assert.equal(sha256(destination), artifact.sha256, `checksum mismatch for ${artifact.url}`);
}

function copyTree(source, destination) {
  assert.ok(fs.statSync(source).isDirectory(), `missing directory ${source}`);
  fs.cpSync(source, destination, { recursive: true });
}

function copyFiles(sources, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const source of sources) fs.copyFileSync(source, path.join(destination, path.basename(source)));
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("usage: run-kernel-baseline-qualification.mjs --target <id> --image <digest> --node-root <path> --evidence <path>");
    }
    parsed[flag.slice(2)] = value;
  }
  for (const required of ["target", "image", "node-root", "evidence"]) {
    assert.ok(parsed[required], `--${required} is required`);
  }
  return parsed;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspaceRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: workspaceRoot, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}: ${result.stderr}`);
  return result.stdout;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function firstLine(value) {
  return value.trim().split("\n", 1)[0];
}

function tarballName(name, selectedVersion) {
  return `${name.replace(/^@/u, "").replaceAll("/", "-")}-${selectedVersion}.tgz`;
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function sha256(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}
