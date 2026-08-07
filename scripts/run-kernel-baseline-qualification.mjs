import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_INSTALLED_SMOKE_WAIT_TIMEOUT_MS,
} from "./installed-package-smoke-helpers.mjs";
import {
  assertCleanQemuCompletion,
  copyTreePreservingSymlinks,
} from "./kernel-baseline-qualification-helpers.mjs";
import { readPreparedArmhfKernelRuntime } from "./lib/armhf-runtime.mjs";
import { loadNativeMatrix, targetForId } from "./lib/native-matrix.mjs";
import { verifyReleaseCandidate } from "./lib/release-version.mjs";

const KERNEL_ARM64_GUEST_WAIT_TIMEOUT_MS = 30_000;
const KERNEL_ARM_GUEST_WAIT_TIMEOUT_MS = 120_000;
const qualificationStartedAt = Date.now();
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const matrix = loadNativeMatrix(workspaceRoot);
const target = targetForId(matrix, options.target);
const guestWaitTimeoutOverrideMs =
  target.architecture === "arm"
    ? KERNEL_ARM_GUEST_WAIT_TIMEOUT_MS
    : target.architecture === "arm64"
    ? KERNEL_ARM64_GUEST_WAIT_TIMEOUT_MS
    : undefined;
const baseline = matrix.kernelBaselineQualification;
const artifactSet = baseline.artifacts[target.architecture];
assert.ok(artifactSet, `kernel baseline omits ${target.architecture}`);
assert.equal(options.image, baseline.image, "workflow image differs from the pinned kernel baseline");
const kernelRelease = artifactSet.kernelRelease ?? baseline.kernelRelease;
const qemuTimeoutMs = target.architecture === "arm"
  ? 30 * 60 * 1000
  : 20 * 60 * 1000;
const preparedRootfs = options["prepared-rootfs"]
  ? path.resolve(options["prepared-rootfs"])
  : null;
assert.equal(
  Boolean(preparedRootfs),
  Boolean(artifactSet.rootfs),
  `${target.id} prepared-rootfs selection differs from its kernel contract`,
);

const version = readJson(path.join(workspaceRoot, "package.json")).version;
const sourceSha = capture("git", ["rev-parse", "HEAD"]).trim();
const candidate = verifyReleaseCandidate(workspaceRoot, { sourceSha, version });
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
  const rootfs = preparedRootfs ?? path.join(temporaryRoot, "rootfs");
  const exportTar = path.join(temporaryRoot, "rootfs.tar");
  const disk = path.join(temporaryRoot, "rootfs.ext4");
  const kernel = path.join(temporaryRoot, "vmlinuz");
  const initrd = path.join(temporaryRoot, "initrd");
  let rootfsEvidence = null;
  if (preparedRootfs) {
    logPhase("prepared-rootfs-validation-start");
    rootfsEvidence = readPreparedArmhfKernelRuntime(rootfs, target, baseline);
    logPhase("prepared-rootfs-validation-complete");
  } else {
    fs.mkdirSync(rootfs);
    logPhase("container-image-pull-start", { image: baseline.image });
    run("docker", ["pull", baseline.image]);
    logPhase("container-image-pull-complete");

    logPhase("rootfs-export-start");
    containerId = capture("docker", ["create", baseline.image]).trim();
    assert.match(containerId, /^[0-9a-f]{64}$/u, "docker create did not return a container id");
    run("docker", ["export", "--output", exportTar, containerId]);
    run("tar", ["--extract", "--file", exportTar, "--directory", rootfs, "--no-same-owner"]);
    logPhase("rootfs-export-complete");
  }

  logPhase("guest-files-assemble-start");
  copyTreePreservingSymlinks(
    path.resolve(options["node-root"]),
    path.join(rootfs, "watchbound-node"),
  );
  copyFiles(
    Object.values(tarballs).map((filename) => path.join(tarballRoot, filename)),
    path.join(rootfs, "packages"),
  );
  copyFiles(
    [
      path.join(workspaceRoot, "scripts/check-installed-package.mjs"),
      path.join(workspaceRoot, "scripts/installed-package-smoke-helpers.mjs"),
    ],
    path.join(rootfs, "work/scripts"),
  );
  copyFiles(
    [
      path.join(workspaceRoot, "scripts/fixtures/distro-package-smoke.sh"),
      path.join(workspaceRoot, "scripts/fixtures/exclusion-smoke-helpers.cjs"),
    ],
    path.join(rootfs, "work/scripts/fixtures"),
  );
  const guestInit = path.join(rootfs, "watchbound-init");
  fs.copyFileSync(path.join(workspaceRoot, "scripts/fixtures/kernel-baseline-init.sh"), guestInit);
  fs.chmodSync(guestInit, 0o755);
  fs.writeFileSync(
    path.join(rootfs, "etc/watchbound-kernel-baseline.env"),
    guestEnvironment({
      baseline,
      nativeSha256,
      target,
      tarballs,
      version,
      waitTimeoutMs: guestWaitTimeoutOverrideMs,
      kernelRelease,
    }),
  );
  logPhase("guest-files-assemble-complete");

  logPhase("disk-image-build-start");
  fs.closeSync(fs.openSync(disk, "w"));
  fs.truncateSync(disk, 1536 * 1024 * 1024);
  run("mkfs.ext4", ["-q", "-F", "-d", rootfs, disk]);
  logPhase("disk-image-build-complete");

  logPhase("boot-artifacts-download-start");
  if (artifactSet.rootfs) {
    fs.copyFileSync(path.join(rootfs, stripLeadingSlash(artifactSet.rootfs.kernelPath)), kernel);
    fs.copyFileSync(path.join(rootfs, stripLeadingSlash(artifactSet.rootfs.initrdPath)), initrd);
    assert.equal(sha256(kernel), artifactSet.rootfs.kernelSha256);
  } else {
    downloadChecked(artifactSet.kernel, kernel);
    downloadChecked(artifactSet.initrd, initrd);
  }
  logPhase("boot-artifacts-download-complete");

  // This lane is correctness-only. Deliberately avoid KVM/nested-virtualization
  // variance and keep resource use bounded on shared hosted runners.
  const acceleration = "tcg-single-threaded";
  const qemuArgs = [
    "-machine", artifactSet.machine,
    "-accel", "tcg,thread=single",
    "-cpu", artifactSet.cpu ?? "max",
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
  logPhase("qemu-start", {
    system: artifactSet.qemuSystem,
    timeoutMs: qemuTimeoutMs,
    serialDelivery: "buffered-until-exit",
  });
  const qemu = spawnSync(artifactSet.qemuSystem, qemuArgs, {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: qemuTimeoutMs,
  });
  const serial = `${qemu.stdout ?? ""}${qemu.stderr ?? ""}`;
  process.stdout.write(serial);
  logPhase("qemu-complete", {
    status: qemu.status,
    signal: qemu.signal,
    errorCode: qemu.error?.code ?? null,
  });
  assertCleanQemuCompletion(qemu);
  assert.match(serial, /WATCHBOUND_KERNEL_BASELINE_STATUS=passed\r?$/mu);
  const encoded = serial.match(/^WATCHBOUND_KERNEL_BASELINE_EVIDENCE=([A-Za-z0-9+/=]+)\r?$/mu)?.[1];
  assert.ok(encoded, "kernel baseline guest did not return its smoke evidence");
  const smoke = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.equal(smoke.status, "passed");
  assert.equal(smoke.host.architecture, target.architecture);
  assert.equal(smoke.host.kernel, kernelRelease);
  assert.equal(smoke.host.glibc, "2.35");
  assert.equal(
    smoke.waitTimeoutMs,
    guestWaitTimeoutOverrideMs ?? DEFAULT_INSTALLED_SMOKE_WAIT_TIMEOUT_MS,
  );
  assert.equal(smoke.native.sha256, nativeSha256);

  const evidence = {
    schemaVersion: 1,
    kind: "watchbound-kernel-baseline-qualification",
    classification: {
      purpose: "kernel-floor correctness component",
      architectureEvidence: target.architecture === "arm"
        ? "emulated ARMv7 execution only; no native ARMv7 runner evidence"
        : "not provided by this QEMU lane; require the separate native runner matrix",
      performance: "non-authoritative",
    },
    source: {
      gitHead: sourceSha,
      gitDirty: candidate.gitDirty,
      version,
      materialization: candidate,
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
      kernelRelease,
      glibc: "2.35",
      image: baseline.image,
      kernel: artifactSet.rootfs
        ? { path: artifactSet.rootfs.kernelPath, sha256: sha256(kernel) }
        : artifactSet.kernel,
      initrd: artifactSet.rootfs
        ? { path: artifactSet.rootfs.initrdPath, sha256: sha256(initrd) }
        : artifactSet.initrd,
      ...(rootfsEvidence ? { rootfs: rootfsEvidence } : {}),
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
  logPhase("qualification-complete");
  process.stdout.write(`Kernel ${baseline.kernelSeries} baseline passed for ${target.id}\n`);
} finally {
  logPhase("cleanup-start");
  if (containerId) {
    spawnSync("docker", ["rm", "--force", containerId], { stdio: "ignore" });
  }
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  logPhase("cleanup-complete");
}

function logPhase(phase, details = {}) {
  process.stdout.write(
    `WATCHBOUND_KERNEL_BASELINE_HOST_PHASE=${JSON.stringify({
      phase,
      elapsedMs: Date.now() - qualificationStartedAt,
      target: target.id,
      ...details,
    })}\n`,
  );
}

function guestEnvironment({
  baseline: selectedBaseline,
  nativeSha256: nativeHash,
  target: selectedTarget,
  tarballs: selectedTarballs,
  version: selectedVersion,
  waitTimeoutMs,
  kernelRelease: selectedKernelRelease,
}) {
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
    WATCHBOUND_KERNEL_RELEASE: selectedKernelRelease,
  };
  if (selectedTarget.architecture === "arm") {
    variables.ELECTRON_RUN_AS_NODE = "1";
  }
  if (waitTimeoutMs !== undefined) {
    variables.WATCHBOUND_WAIT_TIMEOUT_MS = String(waitTimeoutMs);
  }
  return `${Object.entries(variables).map(([name, value]) => `export ${name}=${shellQuote(value)}`).join("\n")}\n`;
}

function downloadChecked(artifact, destination) {
  run("curl", ["--fail", "--location", "--retry", "3", "--output", destination, artifact.url]);
  assert.equal(sha256(destination), artifact.sha256, `checksum mismatch for ${artifact.url}`);
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

function stripLeadingSlash(value) {
  return value.replace(/^\//u, "");
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
