import fs from "node:fs";
import path from "node:path";
import { fork, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cpuDelta,
  forceGc,
  inotifyDelta,
  memoryDelta,
  nowMs,
  processSample,
  sleep,
  waitFor,
} from "./metrics.mjs";
import { createRecorder } from "./recorder.mjs";

export const scenarioNames = Object.freeze([
  "startup-cold",
  "startup-warm",
  "normal-deep-change",
  "moved-in-subtree",
  "root-replacement",
  "watch-limit",
  "bridge-backpressure",
  "queue-overflow",
  "dynamic-exclusions",
  "burst-files",
  "burst-directories",
  "burst-renames",
  "disposal",
]);

const overflowMutatorPath = fileURLToPath(new URL("overflow-mutator.mjs", import.meta.url));

export class SkipScenarioError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SkipScenarioError";
    this.details = details;
  }
}

export function scenarioRequirement(name) {
  if (name === "dynamic-exclusions") return "dynamicExclusions";
  if (name === "bridge-backpressure") return "consumerBackpressure";
  return null;
}

export function rootReplacementCoveragePreserved({
  recoverySucceeded,
  structuredCoverageLoss,
}) {
  return Boolean(recoverySucceeded || structuredCoverageLoss);
}

export function evaluateWatchLimitContract(capabilities, coverage) {
  if (!capabilities.explicitWatchLimits || !capabilities.explicitCoverage) return null;
  return coverage?.state === "partial" && coverage?.reason === "resource-limit";
}

function numbered(index) {
  return String(index).padStart(6, "0");
}

function ensureRoot(runDirectory) {
  const root = path.join(runDirectory, "root");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function prepareScenario(name, config, runDirectory) {
  const root = ensureRoot(runDirectory);
  if (name === "startup-cold" || name === "startup-warm") {
    for (let index = 0; index < config.directories; index += 1) {
      fs.mkdirSync(path.join(root, `directory-${numbered(index)}`));
    }
    return { root, directoryCount: config.directories };
  }
  if (name === "normal-deep-change") {
    const target = path.join(root, "level-1", "level-2", "level-3", "target.txt");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "before\n");
    return { root, target };
  }
  if (name === "moved-in-subtree") {
    const incoming = path.join(runDirectory, "incoming");
    const incomingTarget = path.join(incoming, "level-1", "level-2", "level-3", "target.txt");
    fs.mkdirSync(path.dirname(incomingTarget), { recursive: true });
    fs.writeFileSync(incomingTarget, "before\n");
    return {
      root,
      incoming,
      destination: path.join(root, "incoming"),
      destinationTarget: path.join(root, "incoming", "level-1", "level-2", "level-3", "target.txt"),
    };
  }
  if (name === "root-replacement") {
    const oldTarget = path.join(root, "old", "deep", "target.txt");
    fs.mkdirSync(path.dirname(oldTarget), { recursive: true });
    fs.writeFileSync(oldTarget, "old\n");
    return {
      root,
      movedRoot: path.join(runDirectory, "moved-root"),
      replacementTarget: path.join(root, "new", "deep", "target.txt"),
    };
  }
  if (name === "queue-overflow") {
    return { root, sentinel: path.join(root, "sentinel.txt") };
  }
  if (name === "watch-limit") {
    const childCount = Math.max(32, Math.min(config.burstCount, 256));
    for (let index = 0; index < childCount; index += 1) {
      fs.mkdirSync(path.join(root, `directory-${numbered(index)}`));
    }
    return { root, directoryCount: childCount + 1 };
  }
  if (name === "bridge-backpressure") {
    const burstRoot = path.join(root, "bridge-backpressure");
    fs.mkdirSync(burstRoot);
    const targetCount = Math.max(64, Math.min(config.burstCount, 256));
    const targets = [];
    for (let index = 0; index < targetCount; index += 1) {
      const target = path.join(burstRoot, `file-${numbered(index)}.txt`);
      fs.writeFileSync(target, "before\n");
      targets.push(target);
    }
    return { root, targets };
  }
  if (name === "dynamic-exclusions") {
    const git = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
    if (git.error || git.status !== 0) {
      throw new SkipScenarioError("git is required for the Codex dynamic-exclusion baseline", {
        status: git.status,
        error: git.error?.message ?? null,
        stderr: git.stderr || null,
      });
    }
    fs.writeFileSync(path.join(root, ".gitignore"), "");
    const target = path.join(root, "excluded", "deep", "target.txt");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "before\n");
    return { root, target, excludedDirectory: "excluded" };
  }
  if (name === "burst-files") {
    const burstRoot = path.join(root, "burst");
    fs.mkdirSync(burstRoot);
    const targets = [];
    for (let index = 0; index < config.burstCount; index += 1) {
      const target = path.join(burstRoot, `file-${numbered(index)}.txt`);
      fs.writeFileSync(target, "before\n");
      targets.push(target);
    }
    return { root, targets };
  }
  if (name === "burst-directories") {
    const burstRoot = path.join(root, "burst");
    fs.mkdirSync(burstRoot);
    return {
      root,
      targets: Array.from(
        { length: config.burstCount },
        (_value, index) => path.join(burstRoot, `directory-${numbered(index)}`),
      ),
    };
  }
  if (name === "burst-renames") {
    const burstRoot = path.join(root, "burst");
    fs.mkdirSync(burstRoot);
    const sources = [];
    const targets = [];
    for (let index = 0; index < config.burstCount; index += 1) {
      const source = path.join(burstRoot, `before-${numbered(index)}.txt`);
      const target = path.join(burstRoot, `after-${numbered(index)}.txt`);
      fs.writeFileSync(source, "before\n");
      sources.push(source);
      targets.push(target);
    }
    return { root, sources, targets };
  }
  if (name === "disposal") {
    const target = path.join(root, "deep", "target.txt");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "before\n");
    return { root, target };
  }
  throw new Error(`Unknown scenario: ${name}`);
}

async function safeStats(session) {
  try {
    return (await session.stats?.()) ?? null;
  } catch (error) {
    return { error: { code: error?.code ?? null, message: error?.message ?? String(error) } };
  }
}

async function subscribeMeasured(adapter, prepared, config, recorder, overrides = {}) {
  const gcBefore = forceGc();
  const before = processSample();
  const cpuBefore = process.cpuUsage();
  const startedAtMs = nowMs();
  const session = await adapter.subscribe({
    root: prepared.root,
    onBatch: recorder.onBatch,
    maxWatches: config.maxWatches,
    honorGitIgnore: false,
    ...overrides,
  });
  const startupMs = nowMs() - startedAtMs;
  const cpu = cpuDelta(cpuBefore);
  const gcAfter = forceGc();
  const after = processSample();
  return {
    session,
    measurement: {
      startupMs,
      cpu,
      gcAvailable: gcBefore && gcAfter,
      memoryBefore: before.memory,
      memoryAfter: after.memory,
      memoryDelta: memoryDelta(before, after),
      inotifyBefore: before.inotify,
      inotifyAfter: after.inotify,
      inotifyDelta: inotifyDelta(before.inotify, after.inotify),
      coverage: session.coverage ?? null,
      adapterStats: await safeStats(session),
    },
  };
}

async function disposeMeasured(session) {
  const before = processSample();
  const cpuBefore = process.cpuUsage();
  const startedAtMs = nowMs();
  await session.dispose();
  const latencyMs = nowMs() - startedAtMs;
  const cpu = cpuDelta(cpuBefore);
  forceGc();
  const after = processSample();
  return {
    latencyMs,
    cpu,
    memoryDelta: memoryDelta(before, after),
    inotifyBefore: before.inotify,
    inotifyAfter: after.inotify,
    inotifyDelta: inotifyDelta(before.inotify, after.inotify),
  };
}

function check(name, passed, details = {}) {
  return { name, passed: Boolean(passed), ...details };
}

function unavailableCheck(name, reason) {
  return { name, passed: null, applicable: false, reason };
}

function informationalCheck(name, passed, details = {}) {
  return check(name, passed, { ...details, countsTowardOutcome: false });
}

function quiescenceMaximumMs(config) {
  return Math.max(config.timeoutMs, config.settleMs * 5);
}

async function waitForQuiescence(recorder, config) {
  return recorder.waitForQuiet(config.settleMs, quiescenceMaximumMs(config));
}

async function requirePhaseQuiescence(recorder, config, phase) {
  if (await waitForQuiescence(recorder, config)) return true;
  const error = new Error(`Callbacks did not quiesce after ${phase}; refusing to overlap phases`);
  error.code = "WATCHBOUND_BENCH_NOT_QUIESCENT";
  throw error;
}

function deliverySucceeded(observation) {
  return observation.detectedBeforeTimeout && observation.missedPathCount === 0;
}

function observationHealthChecks(prefix, observation, { allowAsyncErrors = false } = {}) {
  const checks = [
    check(`${prefix}-quiesced`, observation.quiesced === true),
  ];
  if (!allowAsyncErrors) {
    checks.push(
      check(`${prefix}-no-async-errors`, observation.asyncErrors.length === 0, {
        errors: observation.asyncErrors,
      }),
    );
  }
  return checks;
}

async function observeExpected(recorder, checkpoint, expectedPaths, config) {
  const detectedBeforeTimeout = await waitFor(
    () => expectedPaths.every((expectedPath) => recorder.pathCountSince(checkpoint, expectedPath) > 0),
    config.timeoutMs,
  );
  const quiesced = await waitForQuiescence(recorder, config);
  return {
    detectedBeforeTimeout,
    quiesced,
    ...recorder.summary(checkpoint, expectedPaths),
  };
}

async function runStartup(adapter, prepared, config, warm) {
  const recorder = createRecorder(prepared.root);
  let warmup = null;
  if (warm) {
    const warmRecorder = createRecorder(prepared.root);
    const started = await subscribeMeasured(adapter, prepared, config, warmRecorder);
    warmup = {
      subscription: started.measurement,
      disposal: await disposeMeasured(started.session),
    };
    await sleep(config.settleMs);
  }
  const started = await subscribeMeasured(adapter, prepared, config, recorder);
  const expectedWatches = prepared.directoryCount + 1;
  const observedKernelWatches = started.measurement.inotifyDelta.supported
    ? started.measurement.inotifyDelta.watches
    : null;
  const publicWatches = started.measurement.adapterStats?.directoryWatches ?? null;
  const checks = [];
  if (observedKernelWatches == null) {
    checks.push(
      unavailableCheck(
        "one-kernel-watch-per-directory",
        started.measurement.inotifyDelta.reason,
      ),
    );
  } else {
    checks.push(
      check("one-kernel-watch-per-directory", observedKernelWatches === expectedWatches, {
        expected: expectedWatches,
        actual: observedKernelWatches,
      }),
    );
  }
  if (publicWatches != null) {
    checks.push(
      check("public-watch-count", publicWatches === expectedWatches, {
        expected: expectedWatches,
        actual: publicWatches,
      }),
    );
  }
  const disposal = await disposeMeasured(started.session);
  return {
    mode: warm ? "warm" : "cold",
    directoryCount: prepared.directoryCount,
    expectedKernelWatches: expectedWatches,
    warmup,
    subscription: started.measurement,
    disposal,
    checks,
  };
}

async function runNormalDeepChange(adapter, prepared, config) {
  const recorder = createRecorder(prepared.root);
  const started = await subscribeMeasured(adapter, prepared, config, recorder);
  let disposal;
  try {
    await requirePhaseQuiescence(recorder, config, "subscription startup");
    const mutationStartedAtMs = nowMs();
    fs.appendFileSync(prepared.target, "after\n");
    const mutationEndedAtMs = nowMs();
    const checkpoint = recorder.checkpoint(mutationEndedAtMs);
    const observation = await observeExpected(recorder, checkpoint, [prepared.target], config);
    return {
      mutationDurationMs: mutationEndedAtMs - mutationStartedAtMs,
      latencyOrigin: "mutation-end",
      subscription: started.measurement,
      observation,
      checks: [
        check("deep-change-delivered", deliverySucceeded(observation)),
        ...observationHealthChecks("deep-change", observation),
      ],
      get disposal() {
        return disposal;
      },
    };
  } finally {
    disposal = await disposeMeasured(started.session);
  }
}

async function runMovedInSubtree(adapter, prepared, config) {
  const recorder = createRecorder(prepared.root);
  const started = await subscribeMeasured(adapter, prepared, config, recorder);
  let disposal;
  try {
    await requirePhaseQuiescence(recorder, config, "subscription startup");
    const moveStartedAtMs = nowMs();
    fs.renameSync(prepared.incoming, prepared.destination);
    const moveEndedAtMs = nowMs();
    const moveCheckpoint = recorder.checkpoint(moveEndedAtMs);
    await sleep(config.topologyDelayMs);
    const moveQuiesced = await waitForQuiescence(recorder, config);
    const moveObservation = {
      quiesced: moveQuiesced,
      ...recorder.summary(moveCheckpoint, [prepared.destination]),
    };
    const topologySampleStartedAtMs = nowMs();
    const adapterStats = await safeStats(started.session);
    const topologySample = processSample();
    const topologySampleEndedAtMs = nowMs();

    let followupMutationDurationMs = null;
    let followupObservation = null;
    if (moveQuiesced) {
      const followupStartedAtMs = nowMs();
      fs.appendFileSync(prepared.destinationTarget, "after\n");
      const followupEndedAtMs = nowMs();
      followupMutationDurationMs = followupEndedAtMs - followupStartedAtMs;
      const followupCheckpoint = recorder.checkpoint(followupEndedAtMs);
      followupObservation = await observeExpected(
        recorder,
        followupCheckpoint,
        [prepared.destinationTarget],
        config,
      );
    }
    const movedInObserved =
      moveObservation.detectedPathCount > 0 || moveObservation.invalidationCount > 0;
    return {
      moveMutationDurationMs: moveEndedAtMs - moveStartedAtMs,
      followupMutationDurationMs,
      latencyOrigin: "mutation-end",
      subscription: started.measurement,
      moveObservation,
      topologyAfterMove: {
        sampledFromMs: topologySampleStartedAtMs,
        sampledToMs: topologySampleEndedAtMs,
        adapterStats,
        inotify: topologySample.inotify,
        inotifyDeltaFromPreSubscription: inotifyDelta(
          started.measurement.inotifyBefore,
          topologySample.inotify,
        ),
      },
      followupObservation,
      checks: [
        check("moved-in-destination-observed", movedInObserved, {
          expectedPath: prepared.destination,
          broadInvalidations: moveObservation.invalidationCount,
        }),
        ...observationHealthChecks("moved-in", moveObservation),
        followupObservation
          ? check("moved-in-deep-followup-delivered", deliverySucceeded(followupObservation))
          : unavailableCheck(
              "moved-in-deep-followup-delivered",
              "The move phase did not quiesce, so the follow-up mutation was not started",
            ),
        ...(followupObservation
          ? observationHealthChecks("moved-in-followup", followupObservation)
          : []),
      ],
      get disposal() {
        return disposal;
      },
    };
  } finally {
    disposal = await disposeMeasured(started.session);
  }
}

async function runRootReplacement(adapter, prepared, config) {
  const recorder = createRecorder(prepared.root);
  const started = await subscribeMeasured(adapter, prepared, config, recorder);
  let disposal;
  try {
    await requirePhaseQuiescence(recorder, config, "subscription startup");
    const oldIdentity = fs.statSync(prepared.root).ino;
    const replacementStartedAtMs = nowMs();
    fs.renameSync(prepared.root, prepared.movedRoot);
    fs.mkdirSync(path.dirname(prepared.replacementTarget), { recursive: true });
    fs.writeFileSync(prepared.replacementTarget, "replacement\n");
    const replacementEndedAtMs = nowMs();
    const replacementCheckpoint = recorder.checkpoint(replacementEndedAtMs);
    const newIdentity = fs.statSync(prepared.root).ino;
    await sleep(config.topologyDelayMs);
    const replacementQuiesced = await waitForQuiescence(recorder, config);
    const replacementObservation = {
      quiesced: replacementQuiesced,
      ...recorder.summary(replacementCheckpoint, [prepared.root]),
    };
    const topologySampleStartedAtMs = nowMs();
    const adapterStats = await safeStats(started.session);
    const topologySample = processSample();
    const topologySampleEndedAtMs = nowMs();

    let followupMutationDurationMs = null;
    let followupObservation = null;
    if (replacementQuiesced) {
      const followupStartedAtMs = nowMs();
      fs.appendFileSync(prepared.replacementTarget, "after\n");
      const followupEndedAtMs = nowMs();
      followupMutationDurationMs = followupEndedAtMs - followupStartedAtMs;
      const followupCheckpoint = recorder.checkpoint(followupEndedAtMs);
      followupObservation = await observeExpected(
        recorder,
        followupCheckpoint,
        [prepared.replacementTarget],
        config,
      );
    }
    const recoverySucceeded = followupObservation ? deliverySucceeded(followupObservation) : false;
    const structuredCoverageLoss =
      replacementObservation.uncertainReasons.includes("root-replaced");
    const observableLifecycleLoss =
      replacementObservation.detectedPathCount > 0 ||
      replacementObservation.invalidationCount > 0 ||
      replacementObservation.asyncErrors.length > 0;
    const coveragePreserved = rootReplacementCoveragePreserved({
      recoverySucceeded,
      structuredCoverageLoss,
    });
    const recoveryCheck = adapter.capabilities.rootReplacementRecovery
      ? informationalCheck("automatic-root-replacement-recovery", recoverySucceeded)
      : unavailableCheck(
          "automatic-root-replacement-recovery",
          "Adapter declares same-path root recovery unsupported",
        );
    return {
      replacementMutationDurationMs: replacementEndedAtMs - replacementStartedAtMs,
      followupMutationDurationMs,
      latencyOrigin: "mutation-end",
      subscription: started.measurement,
      oldRootInode: oldIdentity,
      replacementRootInode: newIdentity,
      inodeChanged: oldIdentity !== newIdentity,
      replacementObservation,
      topologyAfterReplacement: {
        sampledFromMs: topologySampleStartedAtMs,
        sampledToMs: topologySampleEndedAtMs,
        adapterStats,
        inotify: topologySample.inotify,
        inotifyDeltaFromPreSubscription: inotifyDelta(
          started.measurement.inotifyBefore,
          topologySample.inotify,
        ),
      },
      followupObservation,
      checks: [
        informationalCheck("root-was-replaced", oldIdentity !== newIdentity),
        informationalCheck(
          "root-lifecycle-observed",
          recoverySucceeded || observableLifecycleLoss,
        ),
        check(
          "root-coverage-not-silently-lost",
          coveragePreserved,
          { recoverySucceeded, structuredCoverageLoss },
        ),
        adapter.capabilities.explicitCoverage
          ? informationalCheck(
              "structured-root-coverage-loss-reported",
              structuredCoverageLoss,
            )
          : unavailableCheck(
              "structured-root-coverage-loss-reported",
              "Adapter does not expose complete/partial/uncertain coverage",
            ),
        ...observationHealthChecks("root-replacement", replacementObservation, {
          allowAsyncErrors: true,
        }),
        recoveryCheck,
        ...(followupObservation
          ? observationHealthChecks("root-replacement-followup", followupObservation)
          : []),
      ],
      get disposal() {
        return disposal;
      },
    };
  } finally {
    disposal = await disposeMeasured(started.session);
  }
}

async function runDynamicExclusions(adapter, prepared, config) {
  const recorder = createRecorder(prepared.root);
  const started = await subscribeMeasured(adapter, prepared, config, recorder, {
    honorGitIgnore: true,
  });
  if (typeof started.session.updateExclusions !== "function") {
    await started.session.dispose();
    throw new SkipScenarioError("The adapter cannot update exclusions on an active subscription");
  }
  let disposal;
  try {
    await requirePhaseQuiescence(recorder, config, "subscription startup");
    const initialStats = await safeStats(started.session);
    const initialWatchCount = Number.isInteger(initialStats?.directoryWatches)
      ? initialStats.directoryWatches
      : null;
    const statsUnavailableReason = initialStats?.error?.message ??
      "Adapter does not expose a numeric directory watch count";
    const excludeStartedAtMs = nowMs();
    await started.session.updateExclusions([prepared.excludedDirectory]);
    const pruned = initialWatchCount == null
      ? null
      : await waitFor(async () => {
          const stats = await safeStats(started.session);
          return stats?.directoryWatches < initialWatchCount;
        }, config.timeoutMs);
    if (initialWatchCount == null) await sleep(config.topologyDelayMs);
    const exclusionUpdateQuiesced = await waitForQuiescence(recorder, config);
    const exclusionUpdateLatencyMs = nowMs() - excludeStartedAtMs;

    let excludedMutationDurationMs = null;
    let excludedObservation = null;
    if (exclusionUpdateQuiesced) {
      const excludedMutationStartedAtMs = nowMs();
      fs.appendFileSync(prepared.target, "while-excluded\n");
      const excludedMutationEndedAtMs = nowMs();
      excludedMutationDurationMs = excludedMutationEndedAtMs - excludedMutationStartedAtMs;
      const excludedCheckpoint = recorder.checkpoint(excludedMutationEndedAtMs);
      await sleep(config.exclusionObservationMs);
      const excludedQuiesced = await waitForQuiescence(recorder, config);
      excludedObservation = {
        quiesced: excludedQuiesced,
        ...recorder.summary(excludedCheckpoint, [prepared.target]),
      };
    }

    let restored = null;
    let inclusionUpdateLatencyMs = null;
    let inclusionUpdateQuiesced = null;
    let includedMutationDurationMs = null;
    let includedObservation = null;
    if (excludedObservation?.quiesced) {
      const includeStartedAtMs = nowMs();
      await started.session.updateExclusions([]);
      restored = initialWatchCount == null
        ? null
        : await waitFor(async () => {
            const stats = await safeStats(started.session);
            return stats?.directoryWatches >= initialWatchCount;
          }, config.timeoutMs);
      if (initialWatchCount == null) await sleep(config.topologyDelayMs);
      inclusionUpdateQuiesced = await waitForQuiescence(recorder, config);
      inclusionUpdateLatencyMs = nowMs() - includeStartedAtMs;
      if (inclusionUpdateQuiesced) {
        const includedMutationStartedAtMs = nowMs();
        fs.appendFileSync(prepared.target, "after-reinclude\n");
        const includedMutationEndedAtMs = nowMs();
        includedMutationDurationMs = includedMutationEndedAtMs - includedMutationStartedAtMs;
        const includedCheckpoint = recorder.checkpoint(includedMutationEndedAtMs);
        includedObservation = await observeExpected(
          recorder,
          includedCheckpoint,
          [prepared.target],
          config,
        );
      }
    }
    const pruningCheck = initialWatchCount == null
      ? unavailableCheck("exclusion-pruned-coverage", statsUnavailableReason)
      : check("exclusion-pruned-coverage", pruned);
    const restorationCheck = initialWatchCount == null
      ? unavailableCheck("inclusion-restored-coverage", statsUnavailableReason)
      : check("inclusion-restored-coverage", restored);
    return {
      latencyOrigin: "mutation-end",
      subscription: started.measurement,
      initialStats,
      exclusion: {
        applied: pruned,
        latencyMs: exclusionUpdateLatencyMs,
        updateQuiesced: exclusionUpdateQuiesced,
        mutationDurationMs: excludedMutationDurationMs,
        observation: excludedObservation,
      },
      inclusion: {
        applied: restored,
        latencyMs: inclusionUpdateLatencyMs,
        updateQuiesced: inclusionUpdateQuiesced,
        mutationDurationMs: includedMutationDurationMs,
        observation: includedObservation,
      },
      checks: [
        pruningCheck,
        check("exclusion-update-quiesced", exclusionUpdateQuiesced),
        excludedObservation
          ? check("excluded-change-suppressed", excludedObservation.detectedPathCount === 0)
          : unavailableCheck(
              "excluded-change-suppressed",
              "The exclusion update did not quiesce, so the mutation was not started",
            ),
        ...(excludedObservation
          ? observationHealthChecks("excluded-change", excludedObservation)
          : []),
        restorationCheck,
        inclusionUpdateQuiesced == null
          ? unavailableCheck(
              "inclusion-update-quiesced",
              "The excluded-change phase did not quiesce",
            )
          : check("inclusion-update-quiesced", inclusionUpdateQuiesced),
        includedObservation
          ? check("reincluded-change-delivered", deliverySucceeded(includedObservation))
          : unavailableCheck(
              "reincluded-change-delivered",
              "The inclusion update did not quiesce, so the mutation was not started",
            ),
        ...(includedObservation
          ? observationHealthChecks("reincluded-change", includedObservation)
          : []),
      ],
      get disposal() {
        return disposal;
      },
    };
  } finally {
    disposal = await disposeMeasured(started.session);
  }
}

async function runQueueOverflow(adapter, prepared, config) {
  const recorder = createRecorder(prepared.root);
  const started = await subscribeMeasured(adapter, prepared, config, recorder);
  let disposal;
  try {
    await requirePhaseQuiescence(recorder, config, "subscription startup");
    let kernelQueueLimit = 16_384;
    try {
      const parsed = Number.parseInt(
        fs.readFileSync("/proc/sys/fs/inotify/max_queued_events", "utf8").trim(),
        10,
      );
      if (Number.isSafeInteger(parsed) && parsed > 0) kernelQueueLimit = parsed;
    } catch {}
    const generatedEventCount = kernelQueueLimit + 4_096;
    const expectedPaths = Array.from(
      { length: generatedEventCount },
      (_value, index) => path.join(prepared.root, `overflow-${numbered(index)}.txt`),
    );
    const checkpoint = recorder.checkpoint();
    const mutatorResult = await runOverflowMutator({
      watcherPid: process.pid,
      root: prepared.root,
      count: generatedEventCount,
      kernelQueueLimit,
    });
    const postResumeActivityObserved = await waitFor(
      () => recorder.batchCount > checkpoint.batchIndex,
      config.timeoutMs,
    );
    const drainedBeforeSentinel = postResumeActivityObserved
      ? await waitForQuiescence(recorder, config)
      : false;
    const observation = {
      quiesced: drainedBeforeSentinel,
      ...recorder.summary(checkpoint, expectedPaths),
    };

    let sentinelMutationDurationMs = null;
    let sentinelObservation = null;
    if (drainedBeforeSentinel) {
      const sentinelMutationStartedAtMs = nowMs();
      fs.writeFileSync(prepared.sentinel, "sentinel\n");
      const sentinelMutationEndedAtMs = nowMs();
      sentinelMutationDurationMs = sentinelMutationEndedAtMs - sentinelMutationStartedAtMs;
      const sentinelCheckpoint = recorder.checkpoint(sentinelMutationEndedAtMs);
      sentinelObservation = await observeExpected(
        recorder,
        sentinelCheckpoint,
        [prepared.sentinel],
        config,
      );
    }
    const sentinelDelivered = sentinelObservation
      ? deliverySucceeded(sentinelObservation)
      : false;
    const finalStats = await safeStats(started.session);
    const typedOverflowReport =
      observation.uncertainReasons.includes("event-overflow") ||
      Number(finalStats?.overflowEvents ?? 0) > 0;
    const overflowWasExplicit = adapter.capabilities.explicitCoverage
      ? typedOverflowReport
      : typedOverflowReport || observation.invalidationCount > 0;
    const inductionEvidence = {
      watcherStopConfirmed: mutatorResult.stopConfirmed === true,
      generatedDistinctFiles: mutatorResult.generated,
      kernelQueueLimit,
      exceededQueueBy: mutatorResult.generated - kernelQueueLimit,
      sufficient:
        mutatorResult.stopConfirmed === true && mutatorResult.generated > kernelQueueLimit,
      basis:
        "A confirmed-stopped watcher received more distinct file-create operations than max_queued_events",
    };
    const lossEpisodeObserved =
      typedOverflowReport ||
      observation.missedPathCount > 0 ||
      observation.invalidationCount > 0 ||
      observation.asyncErrors.length > 0;
    return {
      kernelQueueLimit,
      generatedEventCount,
      mutator: mutatorResult,
      inductionEvidence,
      subscription: started.measurement,
      observation,
      postResumeActivityObserved,
      drainedBeforeSentinel,
      sentinelMutationDurationMs,
      sentinelObservation,
      sentinelDelivered,
      lossEpisodeObserved,
      finalStats,
      checks: [
        check("overflow-induction-evidence", inductionEvidence.sufficient, inductionEvidence),
        check("post-resume-activity-observed", postResumeActivityObserved),
        check("queue-drained-before-sentinel", drainedBeforeSentinel),
        sentinelObservation
          ? check("post-overflow-sentinel-delivered", sentinelDelivered)
          : unavailableCheck(
              "post-overflow-sentinel-delivered",
              "The generated-event phase did not quiesce, so the sentinel was not written",
            ),
        check("overflow-was-explicit", overflowWasExplicit),
        ...(sentinelObservation
          ? observationHealthChecks("post-overflow-sentinel", sentinelObservation)
          : []),
      ],
      get disposal() {
        return disposal;
      },
    };
  } finally {
    disposal = await disposeMeasured(started.session);
  }
}

async function runWatchLimit(adapter, prepared, config) {
  const recorder = createRecorder(prepared.root);
  const watchLimit = Math.min(8, config.maxWatches);
  const started = await subscribeMeasured(adapter, prepared, config, recorder, {
    maxWatches: watchLimit,
  });
  const publicWatches = started.measurement.adapterStats?.directoryWatches ?? null;
  const kernelWatches = started.measurement.inotifyDelta.supported
    ? started.measurement.inotifyDelta.watches
    : null;
  const limitChecks = adapter.capabilities.explicitWatchLimits
    ? [
        kernelWatches == null
          ? unavailableCheck(
              "kernel-watch-limit-honored",
              started.measurement.inotifyDelta.reason ?? "Kernel watch accounting unavailable",
            )
          : informationalCheck("kernel-watch-limit-honored", kernelWatches <= watchLimit, {
              limit: watchLimit,
              actual: kernelWatches,
            }),
        publicWatches == null
          ? unavailableCheck(
              "public-watch-limit-honored",
              started.measurement.adapterStats?.error?.message ??
                "Adapter does not expose a numeric public watch count",
            )
          : informationalCheck("public-watch-limit-honored", publicWatches <= watchLimit, {
              limit: watchLimit,
              actual: publicWatches,
            }),
      ]
    : [unavailableCheck("explicit-watch-limit", "Adapter declares watch limits unsupported")];
  const contractResult = evaluateWatchLimitContract(
    adapter.capabilities,
    started.measurement.coverage,
  );
  const contractCheck = contractResult == null
    ? unavailableCheck(
        "explicit-watch-limit-contract",
        "Adapter does not expose both explicit watch limits and structured coverage",
      )
    : check(
        "explicit-watch-limit-contract",
        contractResult,
        { coverage: started.measurement.coverage },
      );
  const disposal = await disposeMeasured(started.session);
  return {
    directoryCount: prepared.directoryCount,
    watchLimit,
    subscription: started.measurement,
    disposal,
    checks: [
      informationalCheck("probe-tree-exceeds-limit", prepared.directoryCount > watchLimit),
      ...limitChecks,
      contractCheck,
    ],
  };
}

async function runBridgeBackpressure(adapter, prepared, config) {
  const recorder = createRecorder(prepared.root);
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  let callbackWasBlocked = false;
  let callbackWorkloadDurationMs = null;
  const callbackWorkloadRounds = Math.ceil(2_048 / prepared.targets.length);
  const callbackWorkloadOperations = callbackWorkloadRounds * prepared.targets.length;
  const started = await subscribeMeasured(adapter, prepared, config, recorder, {
    batchWindowMs: 1,
    // Keep the per-batch cardinality guard out of the way: this scenario must
    // prove output-queue pressure, not merely a large individual batch.
    maxBatchPaths: 4_096,
    outputQueueCapacity: 2,
    onBatch(batch) {
      if (!callbackWasBlocked) {
        callbackWasBlocked = true;
        const workloadStartedAtMs = nowMs();
        for (let round = 0; round < callbackWorkloadRounds; round += 1) {
          for (const target of prepared.targets) fs.appendFileSync(target, "pressure\n");
        }
        callbackWorkloadDurationMs = nowMs() - workloadStartedAtMs;
        Atomics.wait(waitCell, 0, 0, 200);
      }
      recorder.onBatch(batch);
    },
  });
  let disposal;
  try {
    await requirePhaseQuiescence(recorder, config, "subscription startup");
    const operationCpuBefore = process.cpuUsage();
    const mutationStartedAtMs = nowMs();
    for (const target of prepared.targets) fs.appendFileSync(target, "after\n");
    const mutationEndedAtMs = nowMs();
    const checkpoint = recorder.checkpoint(mutationEndedAtMs);
    const reportedBeforeTimeout = await waitFor(
      () => recorder
        .summary(checkpoint)
        .uncertainReasons
        .includes("consumer-backpressure"),
      config.timeoutMs,
    );
    const quiesced = await waitForQuiescence(recorder, config);
    const observation = {
      quiesced,
      ...recorder.summary(checkpoint, prepared.targets),
    };
    const finalStats = await safeStats(started.session);
    const rootInvalidated = recorder.pathCountSince(checkpoint, prepared.root) > 0;
    const explicitBackpressure = observation.uncertainReasons.includes("consumer-backpressure");
    const nativeOutputBatchDropped = Number(finalStats?.batchesDropped ?? 0) > 0;
    return {
      mutationDurationMs: mutationEndedAtMs - mutationStartedAtMs,
      latencyOrigin: "mutation-end",
      operationCpu: cpuDelta(operationCpuBefore),
      callbackBlockMs: 200,
      callbackWasBlocked,
      callbackWorkloadDurationMs,
      callbackWorkloadOperations,
      subscriptionOptions: {
        batchWindowMs: 1,
        maxBatchPaths: 4_096,
        outputQueueCapacity: 2,
      },
      subscription: started.measurement,
      observation,
      finalStats,
      checks: [
        check("bridge-callback-was-blocked", callbackWasBlocked),
        check("consumer-backpressure-reported-before-timeout", reportedBeforeTimeout),
        check("consumer-backpressure-explicit", explicitBackpressure),
        check("native-output-batch-dropped", nativeOutputBatchDropped, {
          batchesDropped: finalStats?.batchesDropped ?? null,
        }),
        check("consumer-backpressure-invalidated-root", rootInvalidated),
        ...observationHealthChecks("consumer-backpressure", observation),
      ],
      get disposal() {
        return disposal;
      },
    };
  } finally {
    disposal = await disposeMeasured(started.session);
  }
}

function runOverflowMutator(payload) {
  return new Promise((resolve, reject) => {
    const child = fork(overflowMutatorPath, [JSON.stringify(payload)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: true,
    });
    let stderr = "";
    let ipcResult = null;
    let settled = false;
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("message", (message) => {
      if (message?.type === "result") ipcResult = message.result;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      void notifyOverflowHelper("helper-finished", child.pid).catch(() => {});
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      void notifyOverflowHelper("helper-finished", child.pid).catch(() => {});
      if (code !== 0) {
        reject(
          new Error(
            `overflow mutator failed (code=${code}, signal=${signal}): ${stderr.trim()}`,
          ),
        );
        return;
      }
      if (ipcResult == null) {
        reject(new Error(`overflow mutator returned no IPC result; stderr=${stderr.trim() || "<empty>"}`));
        return;
      }
      resolve(ipcResult);
    });
    notifyOverflowHelper("helper-started", child.pid).then(
      () => {
        if (settled) return;
        child.send({ type: "ready" }, (error) => {
          if (!error || settled) return;
          settled = true;
          child.kill("SIGKILL");
          reject(error);
        });
      },
      (error) => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(error);
      },
    );
  });
}

function notifyOverflowHelper(type, pid) {
  if (!Number.isSafeInteger(pid)) return Promise.resolve();
  if (typeof process.send !== "function") return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      process.send({ type, pid }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function runBurst(adapter, prepared, config, kind) {
  const recorder = createRecorder(prepared.root);
  const started = await subscribeMeasured(adapter, prepared, config, recorder);
  let disposal;
  try {
    await requirePhaseQuiescence(recorder, config, "subscription startup");
    const operationCpuBefore = process.cpuUsage();
    const mutationStartedAtMs = nowMs();
    if (kind === "files") {
      for (const target of prepared.targets) fs.appendFileSync(target, "after\n");
    } else if (kind === "directories") {
      for (const target of prepared.targets) fs.mkdirSync(target);
    } else {
      for (let index = 0; index < prepared.targets.length; index += 1) {
        fs.renameSync(prepared.sources[index], prepared.targets[index]);
      }
    }
    const mutationEndedAtMs = nowMs();
    const mutationDurationMs = mutationEndedAtMs - mutationStartedAtMs;
    const checkpoint = recorder.checkpoint(mutationEndedAtMs);
    const observation = await observeExpected(recorder, checkpoint, prepared.targets, config);
    const operationCpu = cpuDelta(operationCpuBefore);
    const processAfterBurst = processSample();
    const steadyStateMemoryDelta = memoryDelta(
      { memory: started.measurement.memoryAfter },
      processAfterBurst,
    );
    return {
      kind,
      operationCount: prepared.targets.length,
      mutationDurationMs,
      latencyOrigin: "mutation-end",
      operationCpu,
      subscription: started.measurement,
      observation,
      processAfterBurst,
      steadyStateMemoryDelta,
      topologyAfterBurst: await safeStats(started.session),
      checks: [
        check("all-burst-paths-delivered", deliverySucceeded(observation)),
        ...observationHealthChecks("burst", observation),
      ],
      get disposal() {
        return disposal;
      },
    };
  } finally {
    disposal = await disposeMeasured(started.session);
  }
}

async function runDisposal(adapter, prepared, config) {
  const recorder = createRecorder(prepared.root);
  const started = await subscribeMeasured(adapter, prepared, config, recorder);
  const disposal = await disposeMeasured(started.session);
  const mutationStartedAtMs = nowMs();
  fs.appendFileSync(prepared.target, "after-dispose\n");
  const mutationEndedAtMs = nowMs();
  const checkpoint = recorder.checkpoint(mutationEndedAtMs);
  await sleep(config.disposalObservationMs);
  const quiesced = await waitForQuiescence(recorder, config);
  const observation = {
    quiesced,
    ...recorder.summary(checkpoint, [prepared.target]),
  };
  const watchReleaseSupported =
    started.measurement.inotifyBefore.supported && disposal.inotifyAfter.supported;
  const watchReleaseCheck = watchReleaseSupported
    ? check(
        "disposed-watch-released",
        disposal.inotifyAfter.watches === started.measurement.inotifyBefore.watches,
        {
          expected: started.measurement.inotifyBefore.watches,
          actual: disposal.inotifyAfter.watches,
        },
      )
    : unavailableCheck(
        "disposed-watch-released",
        disposal.inotifyAfter.reason ?? started.measurement.inotifyBefore.reason,
      );
  const instanceReleaseCheck = watchReleaseSupported
    ? check(
        "disposed-inotify-instance-released",
        disposal.inotifyAfter.instances === started.measurement.inotifyBefore.instances,
        {
          expected: started.measurement.inotifyBefore.instances,
          actual: disposal.inotifyAfter.instances,
        },
      )
    : unavailableCheck(
        "disposed-inotify-instance-released",
        disposal.inotifyAfter.reason ?? started.measurement.inotifyBefore.reason,
      );
  return {
    mutationDurationMs: mutationEndedAtMs - mutationStartedAtMs,
    latencyOrigin: "mutation-end",
    subscription: started.measurement,
    disposal,
    postDisposalObservation: observation,
    checks: [
      check("no-callback-after-dispose-resolved", observation.callbackCount === 0),
      watchReleaseCheck,
      instanceReleaseCheck,
      ...observationHealthChecks("post-disposal", observation),
    ],
  };
}

export async function runScenario(name, adapter, prepared, config) {
  if (name === "startup-cold") return runStartup(adapter, prepared, config, false);
  if (name === "startup-warm") return runStartup(adapter, prepared, config, true);
  if (name === "normal-deep-change") return runNormalDeepChange(adapter, prepared, config);
  if (name === "moved-in-subtree") return runMovedInSubtree(adapter, prepared, config);
  if (name === "root-replacement") return runRootReplacement(adapter, prepared, config);
  if (name === "watch-limit") return runWatchLimit(adapter, prepared, config);
  if (name === "bridge-backpressure") {
    return runBridgeBackpressure(adapter, prepared, config);
  }
  if (name === "queue-overflow") return runQueueOverflow(adapter, prepared, config);
  if (name === "dynamic-exclusions") return runDynamicExclusions(adapter, prepared, config);
  if (name === "burst-files") return runBurst(adapter, prepared, config, "files");
  if (name === "burst-directories") return runBurst(adapter, prepared, config, "directories");
  if (name === "burst-renames") return runBurst(adapter, prepared, config, "renames");
  if (name === "disposal") return runDisposal(adapter, prepared, config);
  throw new Error(`Unknown scenario: ${name}`);
}
