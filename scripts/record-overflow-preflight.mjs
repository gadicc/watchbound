import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_APPROVED_KERNEL_QUEUE_EVENTS,
  OVERFLOW_EVENT_MARGIN,
  planOverflowWorkload,
} from "../benches/lib/overflow-workload.mjs";
import {
  loadNativeMatrix,
  nativeArtifactEntries,
  targetForId,
} from "./lib/native-matrix.mjs";
import { verifyReleaseCandidate } from "./lib/release-version.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseOptions(process.argv.slice(2));
const outputPath = path.resolve(workspaceRoot, options.output);
const canonicalRoot = path.resolve(workspaceRoot, options["canonical-dir"]);
const reportPath = path.resolve(workspaceRoot, options.report);
const matrix = loadNativeMatrix(workspaceRoot);
const target = targetForId(matrix, options.target);
const errors = [];

const manifest = {
  schemaVersion: 1,
  kind: "watchbound-overflow-qualification-preflight",
  recordedAt: new Date().toISOString(),
  classification: {
    purpose: "correctness pass/fail qualification",
    performance: "non-authoritative hosted-runner timing",
  },
  qualification: {
    scenario: options.scenario,
    attempt: Number(options.attempt),
    reportPath,
  },
};

try {
  recordEvidence(manifest);
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
}

manifest.decision = {
  passed: errors.length === 0,
  errors,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (errors.length > 0) {
  throw new Error(`overflow qualification preflight failed: ${errors.join("; ")}`);
}
process.stdout.write(
  `Recorded ${target.id} ${options.scenario} preflight for ${manifest.canonicalArtifact.sha256}\n`,
);

function recordEvidence(destination) {
  check(
    options.scenario === "overflow-reconciliation" ||
      options.scenario === "automatic-overflow-reconciliation",
    "scenario is not an allowed forced-overflow qualification",
  );
  check(
    /^[1-9][0-9]*$/u.test(options.attempt),
    "qualification attempt must be a positive integer",
  );

  const rootPackage = readJson(path.join(workspaceRoot, "package.json"));
  const sourceSha = capture("git", ["rev-parse", "HEAD"]);
  const candidate = verifyReleaseCandidate(workspaceRoot, {
    sourceSha,
    version: rootPackage.version,
  });
  const comparisonPath = path.join(
    canonicalRoot,
    "independent-reproducibility.json",
  );
  const comparison = readJson(comparisonPath);
  const comparisonTarget = comparison.targets?.find(
    (candidate) => candidate.target === target.id,
  );
  const artifactPath = path.join(canonicalRoot, target.binary);
  const artifact = fs.readFileSync(artifactPath);
  const artifactSha256 = sha256(artifact);
  const osRelease = readOsRelease();
  const uname = capture("uname", ["-m"]);
  const glibc = capture("getconf", ["GNU_LIBC_VERSION"]);
  const maxQueuedEvents = readOptional(
    "/proc/sys/fs/inotify/max_queued_events",
  );
  let overflowWorkload = null;
  try {
    overflowWorkload = planOverflowWorkload(maxQueuedEvents);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  check(
    JSON.stringify(nativeArtifactEntries(workspaceRoot)) ===
      JSON.stringify([target.binary]),
    "qualification checkout does not contain exactly the intended native artifact",
  );
  check(comparison.schemaVersion === 2, "canonical matrix schema is not 2");
  check(
    comparison.kind === "watchbound-independent-native-matrix-comparison",
    "canonical matrix kind is invalid",
  );
  check(
    comparison.sourceSha === sourceSha,
    "canonical matrix source SHA differs",
  );
  check(
    comparison.version === rootPackage.version,
    "canonical matrix version differs",
  );
  check(
    JSON.stringify(comparison.candidate) === JSON.stringify(candidate),
    "canonical matrix candidate materialization differs",
  );
  check(Boolean(comparisonTarget), "canonical matrix target is missing");
  check(
    comparisonTarget?.filename === target.binary,
    "canonical artifact filename differs",
  );
  check(
    comparisonTarget?.sha256 === artifactSha256,
    "canonical artifact SHA-256 differs",
  );
  check(
    comparisonTarget?.bytes === artifact.length,
    "canonical artifact size differs",
  );
  check(
    comparisonTarget?.byteIdentical === true,
    "canonical artifact was not byte-identical",
  );
  check(process.platform === "linux", "qualification host is not Linux");
  check(
    process.arch === target.architecture,
    "Node architecture differs from target",
  );
  check(
    uname === target.unameArchitecture,
    "kernel architecture differs from target",
  );
  check(osRelease.ID === "ubuntu", "qualification host is not Ubuntu");
  check(
    osRelease.VERSION_ID === "24.04",
    "qualification host is not Ubuntu 24.04",
  );
  check(
    process.version === `v${matrix.buildNode}`,
    "Node version differs from the pinned build/qualification version",
  );
  check(
    target.overflowRunner ===
      (target.architecture === "x64" ? "ubuntu-24.04" : "ubuntu-24.04-arm"),
    "target does not select the approved hosted overflow runner",
  );

  destination.source = {
    gitHead: sourceSha,
    gitDirty: candidate.gitDirty,
    version: rootPackage.version,
    materialization: candidate,
    locks: {
      cargo: sha256(fs.readFileSync(path.join(workspaceRoot, "Cargo.lock"))),
      pnpm: sha256(fs.readFileSync(path.join(workspaceRoot, "pnpm-lock.yaml"))),
    },
  };
  destination.qualification.workloadPolicy = {
    approvedMaximumKernelQueueLimit: MAX_APPROVED_KERNEL_QUEUE_EVENTS,
    generatedEventMargin: OVERFLOW_EVENT_MARGIN,
    plan: overflowWorkload,
  };
  destination.canonicalArtifact = {
    target: target.id,
    architecture: target.architecture,
    filename: target.binary,
    bytes: artifact.length,
    sha256: artifactSha256,
    independentComparisonSha256: sha256(fs.readFileSync(comparisonPath)),
    builders: comparisonTarget?.builders ?? [],
  };
  destination.host = {
    distribution: `${osRelease.ID ?? "unknown"} ${osRelease.VERSION_ID ?? "unknown"}`,
    kernel: capture("uname", ["-r"]),
    architecture: uname,
    glibc,
    cpuCount: globalThis.navigator?.hardwareConcurrency ?? null,
    loadAverage: readOptional("/proc/loadavg"),
    memory: readOptional("/proc/meminfo"),
    vmstat: commandEvidence("vmstat", ["1", "5"]),
    pressure: {
      cpu: readOptional("/proc/pressure/cpu"),
      io: readOptional("/proc/pressure/io"),
      memory: readOptional("/proc/pressure/memory"),
    },
    inotify: {
      max_queued_events: maxQueuedEvents,
      max_user_instances: readOptional("/proc/sys/fs/inotify/max_user_instances"),
      max_user_watches: readOptional("/proc/sys/fs/inotify/max_user_watches"),
    },
    filesystem: {
      mount: commandEvidence("findmnt", [
        "--target",
        process.env.RUNNER_TEMP ?? workspaceRoot,
        "--noheadings",
        "--output",
        "SOURCE,FSTYPE,TARGET,OPTIONS",
      ]),
      blocks: commandEvidence("df", ["-Pk", process.env.RUNNER_TEMP ?? workspaceRoot]),
      inodes: commandEvidence("df", ["-Pi", process.env.RUNNER_TEMP ?? workspaceRoot]),
    },
    cpuGovernor: readOptional(
      "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
    ),
    processes: commandEvidence("ps", [
      "-eo",
      "pid,ppid,stat,comm,args",
      "--sort=pid",
    ]),
  };
  destination.tools = {
    node: process.version,
    pnpm: commandEvidence("pnpm", ["--version"]),
  };
  destination.runner = {
    configuredLabel: target.overflowRunner,
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    os: process.env.RUNNER_OS ?? null,
    architecture: process.env.RUNNER_ARCH ?? null,
    name: process.env.RUNNER_NAME ?? null,
    environment: process.env.RUNNER_ENVIRONMENT ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null,
  };
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: record-overflow-preflight.mjs --canonical-dir <path> --target <id> --scenario <name> --attempt <n> --report <path> --output <path>",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  for (const name of [
    "canonical-dir",
    "target",
    "scenario",
    "attempt",
    "report",
    "output",
  ]) {
    assert.ok(parsed[name], `--${name} is required`);
  }
  return parsed;
}

function check(condition, message) {
  if (!condition) errors.push(message);
}

function capture(command, args) {
  const evidence = commandEvidence(command, args);
  if (evidence.status !== 0) {
    throw new Error(
      `${command} failed with status ${evidence.status}: ${evidence.stderr}`,
    );
  }
  return evidence.stdout;
}

function commandEvidence(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    error: result.error?.message ?? null,
  };
}

function sha256(source) {
  return crypto.createHash("sha256").update(source).digest("hex");
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function readOptional(source) {
  try {
    return fs.readFileSync(source, "utf8").trim();
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function readOsRelease() {
  const fields = {};
  for (const line of fs.readFileSync("/etc/os-release", "utf8").split(/\r?\n/u)) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line);
    if (match) fields[match[1]] = match[2].replace(/^"(.*)"$/u, "$1");
  }
  return fields;
}
