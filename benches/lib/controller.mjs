import crypto from "node:crypto";
import { fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serializeError } from "./metrics.mjs";
import { scenarioRequirement } from "./scenarios.mjs";
import {
  WATCHBOUND_BUILD_COMMAND,
  WATCHBOUND_SOURCE_INPUTS,
} from "./watchbound-identity.mjs";

const childPath = fileURLToPath(new URL("../run-child.mjs", import.meta.url));
const workspaceRoot = path.dirname(path.dirname(childPath));
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;

function appendDiagnostic(current, chunk) {
  if (current.length >= MAX_DIAGNOSTIC_BYTES) return current;
  return (current + chunk.toString()).slice(0, MAX_DIAGNOSTIC_BYTES);
}

export function isolatedResultAfterExit(
  payload,
  reportedResult,
  {
    timeoutMs,
    timedOut = false,
    exitCode = null,
    signal = null,
    processError = null,
  },
) {
  const cleanExit =
    !timedOut && processError === null && exitCode === 0 && signal === null;
  if (cleanExit && reportedResult !== null) return reportedResult;

  const reportedSuffix =
    reportedResult === null
      ? "before reporting a result"
      : "after reporting a result";
  return {
    kind: payload.kind,
    adapterId: payload.adapterId,
    scenario: payload.scenario ?? null,
    run: payload.run ?? null,
    status: "error",
    error: processError
      ? serializeError(processError)
      : {
          name: timedOut ? "TimeoutError" : "ChildProcessError",
          message: timedOut
            ? `Isolated child exceeded ${timeoutMs} ms`
            : `Isolated child exited ${reportedSuffix} (code=${exitCode}, signal=${signal})`,
          code: timedOut ? "WATCHBOUND_BENCH_TIMEOUT" : exitCode,
          stack: null,
        },
  };
}

export function runIsolated(payload, timeoutMs) {
  return new Promise((resolve) => {
    const child = fork(childPath, [JSON.stringify(payload)], {
      cwd: path.dirname(path.dirname(childPath)),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
    let stdout = "";
    let stderr = "";
    let result = null;
    let runDirectory = null;
    let helperProcessGroup = null;
    let timedOut = false;
    let settled = false;
    child.stdout.on("data", (chunk) => {
      stdout = appendDiagnostic(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendDiagnostic(stderr, chunk);
    });
    child.on("message", (message) => {
      if (
        message?.type === "started" &&
        runDirectory == null &&
        typeof message.runDirectory === "string"
      ) {
        const candidate = path.resolve(message.runDirectory);
        const expectedParent = path.resolve(payload.config?.tempDir || os.tmpdir());
        if (
          path.dirname(candidate) === expectedParent &&
          path.basename(candidate).startsWith("watchbound-bench-")
        ) {
          runDirectory = candidate;
        }
      }
      if (
        message?.type === "helper-started" &&
        Number.isSafeInteger(message.pid) &&
        message.pid > 1
      ) {
        helperProcessGroup = message.pid;
      }
      if (message?.type === "helper-finished" && message.pid === helperProcessGroup) {
        helperProcessGroup = null;
      }
      if (message?.type === "result") result = message.result;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(helperProcessGroup, "SIGKILL");
      child.kill("SIGCONT");
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();

    const finish = (exitCode, signal, processError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessGroup(helperProcessGroup, "SIGKILL");
      if (runDirectory) {
        try {
          fs.rmSync(runDirectory, { recursive: true, force: true });
        } catch {}
      }
      result = isolatedResultAfterExit(payload, result, {
        timeoutMs,
        timedOut,
        exitCode,
        signal,
        processError,
      });
      if (stdout || stderr) {
        result.diagnostics = {
          stdout: stdout || null,
          stderr: stderr || null,
          truncated:
            stdout.length >= MAX_DIAGNOSTIC_BYTES || stderr.length >= MAX_DIAGNOSTIC_BYTES,
        };
      }
      resolve(result);
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

function killProcessGroup(groupId, signal) {
  if (!Number.isSafeInteger(groupId) || groupId <= 1) return false;
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function planForOptions(kind, options) {
  const plans = [];
  for (const scenario of options.scenarios) {
    const directoryCounts = scenario.startsWith("startup-") ? options.directoryCounts : [null];
    for (const directories of directoryCounts) {
      for (let run = 1; run <= options.runs; run += 1) {
        const offset = options.trialOrder === "rotating" ? (run - 1) % options.adapters.length : 0;
        const orderedAdapters = [
          ...options.adapters.slice(offset),
          ...options.adapters.slice(0, offset),
        ];
        for (const adapterId of orderedAdapters) {
          plans.push({
            kind,
            adapterId,
            scenario,
            run,
            config: {
              directories: directories ?? options.directoryCounts[0],
              burstCount: options.burstCount,
              maxWatches: options.maxWatches,
              timeoutMs: options.timeoutMs,
              settleMs: options.settleMs,
              topologyDelayMs: options.topologyDelayMs,
              exclusionObservationMs: options.exclusionObservationMs,
              disposalObservationMs: options.disposalObservationMs,
              allowForcedOverflow: options.allowForcedOverflow,
              tempDir: options.tempDir,
            },
          });
        }
      }
    }
  }
  return plans;
}

export function scenarioExclusionReason(plan, probe) {
  if (!probe || probe.status !== "available") {
    return probe?.reason ?? "Adapter capability probe did not succeed";
  }
  const requirement = scenarioRequirement(plan.scenario);
  if (requirement === "dynamicExclusions") {
    const capability = probe.adapter.capabilities.dynamicExclusions;
    if (!capability?.supported) {
      return capability?.reason ?? "Dynamic exclusions are not supported";
    }
  }
  if (requirement === "consumerBackpressure") {
    if (!probe.adapter.capabilities.consumerBackpressureReporting) {
      return "Explicit consumer-backpressure reporting is not supported";
    }
  }
  if (requirement === "reconciliation") {
    const capabilities = probe.adapter.capabilities;
    if (capabilities.reconciliation !== true) {
      return "Public existing-subscription reconciliation is not supported";
    }
    if (!capabilities.explicitCoverage) {
      return "Reconciliation requires explicit coverage reporting";
    }
    if (!capabilities.consumerBackpressureReporting) {
      return "Reconciliation requires explicit consumer-backpressure reporting";
    }
    if (
      !capabilities.dynamicExclusions?.supported ||
      !capabilities.dynamicExclusions?.atomic
    ) {
      return "Reconciliation requires atomic dynamic exclusions";
    }
  }
  if (requirement === "rootReplacementRecovery") {
    const capabilities = probe.adapter.capabilities;
    if (capabilities.rootReplacementRecovery !== true) {
      return "Public explicit root replacement recovery is not supported";
    }
    if (!capabilities.explicitCoverage) {
      return "Root replacement recovery requires explicit coverage reporting";
    }
    if (
      !capabilities.dynamicExclusions?.supported ||
      !capabilities.dynamicExclusions?.atomic
    ) {
      return "Root replacement recovery requires atomic dynamic exclusions";
    }
  }
  if (requirement === "automaticReconciliation") {
    const capabilities = probe.adapter.capabilities;
    if (capabilities.automaticReconciliation !== true) {
      return "Opt-in automatic reconciliation is not supported";
    }
    if (capabilities.reconciliation !== true) {
      return "Automatic reconciliation requires public existing-subscription reconciliation";
    }
    if (!capabilities.explicitCoverage) {
      return "Automatic reconciliation requires explicit coverage reporting";
    }
    if (!capabilities.consumerBackpressureReporting) {
      return "Automatic reconciliation requires explicit consumer-backpressure reporting";
    }
    if (
      !capabilities.dynamicExclusions?.supported ||
      !capabilities.dynamicExclusions?.atomic
    ) {
      return "Automatic reconciliation requires atomic dynamic exclusions";
    }
  }
  if (requirement === "automaticOverflowReconciliation") {
    const capabilities = probe.adapter.capabilities;
    if (capabilities.automaticReconciliation !== true) {
      return "Opt-in automatic reconciliation is not supported";
    }
    if (capabilities.reconciliation !== true) {
      return "Automatic overflow reconciliation requires existing-subscription reconciliation";
    }
    if (!capabilities.explicitCoverage) {
      return "Automatic overflow reconciliation requires explicit coverage reporting";
    }
    if (!capabilities.overflowReporting) {
      return "Automatic overflow reconciliation requires explicit event-overflow reporting";
    }
    if (!capabilities.supervisedOverflow) {
      return "The supervised genuine-overflow mechanism is not supported";
    }
    if (
      !capabilities.dynamicExclusions?.supported ||
      !capabilities.dynamicExclusions?.atomic
    ) {
      return "Automatic overflow reconciliation requires atomic dynamic exclusions";
    }
  }
  if (requirement === "overflowReconciliation") {
    const capabilities = probe.adapter.capabilities;
    if (capabilities.reconciliation !== true) {
      return "Overflow reconciliation requires public existing-subscription reconciliation";
    }
    if (!capabilities.explicitCoverage) {
      return "Overflow reconciliation requires explicit coverage reporting";
    }
    if (!capabilities.overflowReporting) {
      return "Overflow reconciliation requires explicit event-overflow reporting";
    }
    if (!capabilities.supervisedOverflow) {
      return "The supervised genuine-overflow mechanism is not supported";
    }
    if (
      !capabilities.dynamicExclusions?.supported ||
      !capabilities.dynamicExclusions?.atomic
    ) {
      return "Overflow reconciliation requires atomic dynamic exclusions";
    }
  }
  return null;
}

function summarize(results, excludedRuns) {
  return {
    planned: results.length + excludedRuns.length,
    executed: results.length,
    excluded: excludedRuns.length,
    completed: results.filter((result) => result.status === "completed").length,
    passed: results.filter((result) => result.outcome === "pass").length,
    nonconforming: results.filter((result) => result.outcome === "fail").length,
    observed: results.filter((result) => result.outcome === "observed").length,
    errors: results.filter((result) => result.status === "error").length,
    runtimeSkips: results.filter((result) => result.status === "skipped").length,
    cleanupErrors: results.filter((result) => result.cleanupError != null).length,
    skipped:
      excludedRuns.length + results.filter((result) => result.status === "skipped").length,
  };
}

function numericSummary(values) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  const median = numbers.length % 2 === 0
    ? (numbers[middle - 1] + numbers[middle]) / 2
    : numbers[middle];
  return {
    samples: numbers.length,
    min: numbers[0],
    median,
    max: numbers.at(-1),
    mean: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
  };
}

export function aggregateResults(results) {
  const groups = new Map();
  for (const trial of results) {
    if (trial.status !== "completed") continue;
    const scale = trial.scenario.startsWith("startup-")
      ? `directories=${trial.config.directories}`
      : trial.scenario.startsWith("burst-")
        ? `operations=${trial.config.burstCount}`
        : "default";
    const key = `${trial.adapterId}\0${trial.scenario}\0${scale}`;
    const group = groups.get(key) ?? {
      adapterId: trial.adapterId,
      scenario: trial.scenario,
      scale,
      trials: [],
    };
    group.trials.push(trial);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const performanceTrials = group.trials.filter((trial) => trial.outcome === "pass");
    const subscriptions = performanceTrials
      .map((trial) => trial.result?.subscription)
      .filter(Boolean);
    const disposals = performanceTrials.map((trial) => trial.result?.disposal).filter(Boolean);
    const observations = performanceTrials
      .map((trial) => trial.result?.observation ?? trial.result?.followupObservation)
      .filter(Boolean);
    const allObservations = group.trials
      .map((trial) => trial.result?.observation ?? trial.result?.followupObservation)
      .filter(Boolean);
    return {
      adapterId: group.adapterId,
      scenario: group.scenario,
      scale: group.scale,
      runs: group.trials.length,
      passed: group.trials.filter((trial) => trial.outcome === "pass").length,
      failed: group.trials.filter((trial) => trial.outcome === "fail").length,
      observed: group.trials.filter((trial) => trial.outcome === "observed").length,
      performanceRuns: performanceTrials.length,
      performanceSamplePolicy: "pass-only",
      adapterLoadMs: numericSummary(
        performanceTrials.map((trial) => trial.adapterLoad?.latencyMs),
      ),
      adapterLoadCpuMicros: numericSummary(
        performanceTrials.map((trial) => trial.adapterLoad?.cpu?.totalMicros),
      ),
      adapterLoadMemoryDeltaBytes: memorySummary(
        performanceTrials.map((trial) => trial.adapterLoad?.memoryDelta),
      ),
      startupMs: numericSummary(subscriptions.map((measurement) => measurement.startupMs)),
      startupCpuMicros: numericSummary(
        subscriptions.map((measurement) => measurement.cpu?.totalMicros),
      ),
      startupMemoryDeltaBytes: memorySummary(
        subscriptions.map((measurement) => measurement.memoryDelta),
      ),
      startupRssDeltaBytes: numericSummary(subscriptions.map((measurement) =>
        measurement.memoryDelta?.rssBytes
      )),
      inotifyInstanceDelta: numericSummary(
        subscriptions.map((measurement) =>
          measurement.inotifyDelta?.supported ? measurement.inotifyDelta.instances : null,
        ),
      ),
      inotifyWatchDelta: numericSummary(
        subscriptions.map((measurement) =>
          measurement.inotifyDelta?.supported ? measurement.inotifyDelta.watches : null,
        ),
      ),
      disposalMs: numericSummary(disposals.map((measurement) => measurement.latencyMs)),
      disposalCpuMicros: numericSummary(
        disposals.map((measurement) => measurement.cpu?.totalMicros),
      ),
      disposalMemoryDeltaBytes: memorySummary(
        disposals.map((measurement) => measurement.memoryDelta),
      ),
      disposalInotifyWatchDelta: numericSummary(
        disposals.map((measurement) =>
          measurement.inotifyDelta?.supported ? measurement.inotifyDelta.watches : null,
        ),
      ),
      disposalInotifyInstanceDelta: numericSummary(
        disposals.map((measurement) =>
          measurement.inotifyDelta?.supported ? measurement.inotifyDelta.instances : null,
        ),
      ),
      operationCpuMicros: numericSummary(
        performanceTrials.map((trial) => trial.result?.operationCpu?.totalMicros),
      ),
      mutationDurationMs: numericSummary(
        performanceTrials.map((trial) => trial.result?.mutationDurationMs),
      ),
      steadyStateMemoryDeltaBytes: memorySummary(
        performanceTrials.map((trial) => trial.result?.steadyStateMemoryDelta),
      ),
      callbackCount: numericSummary(observations.map((observation) => observation.callbackCount)),
      deliveredPathEventCount: numericSummary(
        observations.map((observation) => observation.pathEventCount),
      ),
      firstCallbackLatencyMs: numericSummary(
        observations.map((observation) => observation.firstCallbackLatencyMs),
      ),
      finalCallbackLatencyMs: numericSummary(
        observations.map((observation) => observation.finalCallbackLatencyMs),
      ),
      firstExpectedLatencyMs: numericSummary(
        observations.map((observation) => observation.firstExpectedLatencyMs),
      ),
      allExpectedLatencyMs: numericSummary(
        observations.map((observation) => observation.allExpectedLatencyMs),
      ),
      missedPathCount: numericSummary(
        observations.map((observation) => observation.missedPathCount),
      ),
      duplicateExpectedEvents: numericSummary(
        observations.map((observation) => observation.duplicateExpectedEvents),
      ),
      allCompletedCorrectness: {
        missedPathCount: numericSummary(
          allObservations.map((observation) => observation.missedPathCount),
        ),
        duplicateExpectedEvents: numericSummary(
          allObservations.map((observation) => observation.duplicateExpectedEvents),
        ),
        asyncErrorCount: numericSummary(
          allObservations.map((observation) => observation.asyncErrors?.length ?? 0),
        ),
      },
    };
  });
}

function memorySummary(values) {
  const keys = [
    "rssBytes",
    "heapTotalBytes",
    "heapUsedBytes",
    "externalBytes",
    "arrayBuffersBytes",
  ];
  return Object.fromEntries(
    keys.map((key) => [key, numericSummary(values.map((value) => value?.[key]))]),
  );
}

function readLinuxLimit(name) {
  try {
    const value = Number.parseInt(
      fs.readFileSync(`/proc/sys/fs/inotify/${name}`, "utf8").trim(),
      10,
    );
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function readTextFile(filename) {
  try {
    return fs.readFileSync(filename, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function tempFilesystemIdentity(tempDir) {
  const resolved = path.resolve(tempDir);
  try {
    const stat = fs.statSync(resolved);
    const statfs = fs.statfsSync(resolved);
    return {
      path: resolved,
      device: stat.dev,
      filesystemType: statfs.type,
      blockSize: statfs.bsize,
      blocks: statfs.blocks,
      blocksAvailable: statfs.bavail,
    };
  } catch (error) {
    return {
      path: resolved,
      error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    };
  }
}

export function workspaceSourceIdentity() {
  const headResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const statusResult = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: workspaceRoot, encoding: "utf8" },
  );
  const files = [];
  for (const relative of WATCHBOUND_SOURCE_INPUTS) {
    const candidate = path.join(workspaceRoot, relative);
    if (!fs.existsSync(candidate)) {
      throw new Error(`Configured Watchbound source input is missing: ${relative}`);
    }
    collectSourceFiles(candidate, files);
  }
  files.sort();
  const hash = crypto.createHash("sha256");
  for (const filename of files) {
    hash.update(path.relative(workspaceRoot, filename));
    hash.update("\0");
    hash.update(fs.readFileSync(filename));
    hash.update("\0");
  }
  const statusLines = statusResult.status === 0
    ? statusResult.stdout.split("\n").filter(Boolean)
    : [];
  return {
    workspaceRoot,
    gitHead: headResult.status === 0 ? headResult.stdout.trim() : null,
    gitHeadError: headResult.status === 0 ? null : (headResult.stderr.trim() || null),
    gitDirty: statusResult.status === 0 ? statusLines.length > 0 : null,
    gitStatusEntryCount: statusResult.status === 0 ? statusLines.length : null,
    sourceSha256: hash.digest("hex"),
    sourceFileCount: files.length,
    expectedBuildProfile: "release",
    expectedBuildCommand: WATCHBOUND_BUILD_COMMAND,
  };
}

function collectSourceFiles(candidate, files) {
  if (!fs.existsSync(candidate)) return;
  const stat = fs.statSync(candidate);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(candidate)) {
      collectSourceFiles(path.join(candidate, entry), files);
    }
    return;
  }
  files.push(candidate);
}

export async function runSuite(kind, options) {
  const startedAt = new Date();
  const loadAverageAtStart = os.loadavg();
  const sourceIdentity = workspaceSourceIdentity();
  const probes = {};
  for (const adapterId of options.adapters) {
    probes[adapterId] = await runIsolated(
      { kind: "probe", adapterId },
      Math.min(options.childTimeoutMs, 15_000),
    );
  }

  const plans = planForOptions(kind, options);
  const excludedRuns = [];
  const runnablePlans = [];
  for (const plan of plans) {
    const reason = scenarioExclusionReason(plan, probes[plan.adapterId]);
    if (reason) {
      excludedRuns.push({
        adapterId: plan.adapterId,
        scenario: plan.scenario,
        run: plan.run,
        directories: plan.config.directories,
        status: "skipped",
        reason,
      });
    } else {
      runnablePlans.push(plan);
    }
  }

  const results = [];
  for (const plan of runnablePlans) {
    results.push(await runIsolated(plan, options.childTimeoutMs));
  }
  const finishedAt = new Date();
  const summary = summarize(results, excludedRuns);
  return {
    schemaVersion: 2,
    suite: kind,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    system: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      kernel: os.release(),
      cpuModel: os.cpus()[0]?.model ?? null,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      loadAverageAtStart,
      loadAverageAtFinish: os.loadavg(),
      cpuGovernor: readTextFile(
        "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
      ),
      tempFilesystem: tempFilesystemIdentity(options.tempDir),
      inotifyLimits: {
        maxUserWatches: readLinuxLimit("max_user_watches"),
        maxUserInstances: readLinuxLimit("max_user_instances"),
        maxQueuedEvents: readLinuxLimit("max_queued_events"),
      },
    },
    methodology: {
      isolation: "Each capability probe and trial runs in a fresh Node child process",
      scheduling: "Trials run serially to avoid cross-trial inotify, CPU, and RSS interference",
      adapterOrdering:
        options.trialOrder === "rotating"
          ? "Adapter order rotates across repetitions to balance slow system drift"
          : "Adapter order is fixed as requested",
      latencyClock: "Monotonic performance.now() timestamps in the watcher child",
      callbackAccounting: "Callback invocations and the sum of delivered path events are separate",
      watchAccounting:
        "Delta of inotify wd records in /proc/self/fdinfo; unsupported states are explicit",
      memory:
        "process.memoryUsage() snapshots are noisy high-water/process allocator observations, not precise ownership",
      cpu: "process.cpuUsage() user and system microseconds for measured operations",
      semanticPerformanceSamples:
        "Numeric performance aggregates include completed passing trials only; every raw trial is retained",
      mutationLatency:
        "Mutation duration is separate; delivery latency is measured from the end of the synchronous mutation",
      parcelBackend: "The Parcel adapter forces backend=inotify",
      coldStartup:
        "The first subscription in a fresh child; adapter loading is reported separately",
      warmStartup:
        "A fresh child creates and disposes one subscription, then measures a second subscription",
    },
    config: {
      adapters: options.adapters,
      scenarios: options.scenarios,
      runs: options.runs,
      directoryCounts: options.directoryCounts,
      burstCount: options.burstCount,
      maxWatches: options.maxWatches,
      timeoutMs: options.timeoutMs,
      childTimeoutMs: options.childTimeoutMs,
      settleMs: options.settleMs,
      topologyDelayMs: options.topologyDelayMs,
      exclusionObservationMs: options.exclusionObservationMs,
      disposalObservationMs: options.disposalObservationMs,
      tempDir: options.tempDir,
      trialOrder: options.trialOrder,
      quick: options.quick,
      allowForcedOverflow: options.allowForcedOverflow,
      codexWatcherPath:
        process.env.WATCHBOUND_CODEX_WATCHER_PATH ||
        "/home/dragon/src/codex-desktop-linux/linux-features/directory-only-working-tree-watch/patch.js",
      parcelWatcherPath: process.env.WATCHBOUND_PARCEL_WATCHER_PATH || "@parcel/watcher",
    },
    sourceIdentity,
    adapterProbes: probes,
    excludedRuns,
    results,
    aggregates: aggregateResults(results),
    summary,
  };
}
