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
  serializeError,
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
  "reconciliation",
  "automatic-reconciliation",
  "overflow-reconciliation",
  "automatic-overflow-reconciliation",
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
  if (name === "reconciliation") return "reconciliation";
  if (name === "automatic-reconciliation") return "automaticReconciliation";
  if (name === "overflow-reconciliation") return "overflowReconciliation";
  if (name === "automatic-overflow-reconciliation") {
    return "automaticOverflowReconciliation";
  }
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
  if (
    name === "reconciliation" ||
    name === "automatic-reconciliation" ||
    name === "overflow-reconciliation" ||
    name === "automatic-overflow-reconciliation"
  ) {
    const pressureRoot = path.join(root, "pressure");
    const excludedRoot = path.join(root, "excluded");
    const peerRoot = path.join(runDirectory, "peer-root");
    fs.mkdirSync(pressureRoot);
    fs.mkdirSync(path.join(excludedRoot, "current", "deep"), { recursive: true });
    fs.mkdirSync(peerRoot);
    const targetCount = Math.max(64, Math.min(config.burstCount, 256));
    const pressureTargets = [];
    for (let index = 0; index < targetCount; index += 1) {
      const target = path.join(pressureRoot, `file-${numbered(index)}.txt`);
      fs.writeFileSync(target, "before\n");
      pressureTargets.push(target);
    }
    const scanCount = Math.max(128, Math.min(config.burstCount * 2, 256));
    const recoveredRoot = path.join(root, "recovered");
    return {
      root,
      peerRoot,
      pressureTargets,
      scanDirectories: Array.from(
        { length: scanCount },
        (_value, index) => path.join(recoveredRoot, `directory-${numbered(index)}`, "deep"),
      ),
      intervalTarget: path.join(recoveredRoot, "interval", "deep", "during.txt"),
      postReconciliationTarget: path.join(
        recoveredRoot,
        `directory-${numbered(scanCount - 1)}`,
        "deep",
        "after.txt",
      ),
      excludedDirectory: "excluded",
      excludedCurrentTarget: path.join(excludedRoot, "current", "deep", "ignored.txt"),
      excludedFutureTarget: path.join(excludedRoot, "future", "deep", "ignored.txt"),
      peerTarget: path.join(peerRoot, "during-reconciliation.txt"),
    };
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

function countersStrictlyIncrease(batches) {
  return batches.every((batch, index) => {
    if (batch.sequence == null || batch.exclusionGeneration == null) return false;
    return index === 0 || BigInt(batch.sequence) > BigInt(batches[index - 1].sequence);
  });
}

export function evaluateOverflowReconciliationEvidence(evidence) {
  const helper = evidence.helper ?? {};
  const loss = evidence.lossObservation ?? {};
  const result = evidence.reconciliationResult;
  const recoveryBatches = evidence.recoveryBatches ?? [];
  const primaryBatches = evidence.primaryBatches ?? [];
  const allPrimaryBatches = evidence.allPrimaryBatches ?? primaryBatches;
  const rootOnlyMatching = recoveryBatches.filter((batch) =>
    batch.paths?.length === 1 &&
    batch.paths[0] === evidence.root &&
    batch.exclusionGeneration === evidence.committedGeneration &&
    sameCoverage(batch.coverage, result?.coverage)
  );
  const operation = evidence.originalSubscription ?? {};
  const automatic = evidence.automatic === true;
  const interval = evidence.intervalMutation ?? {};
  const peer = evidence.peer ?? {};
  const lifecycle = evidence.lifecycle ?? {};
  const generationZeroBoundaries = evidence.generationZeroRootBoundaries ?? [];
  return [
    check(
      "overflow-helper-handshake-ordered",
      helper.stopConfirmed === true &&
      helper.mutationStartedAfterStopConfirmed === true &&
      helper.mutationCompletedBeforeResume === true &&
      helper.resumeAttempted === true &&
      helper.resumeConfirmed === true,
    ),
    check(
      "overflow-workload-exceeded-kernel-queue-bound",
      Number.isSafeInteger(helper.generated) &&
      Number.isSafeInteger(helper.kernelQueueLimit) &&
      helper.generated > helper.kernelQueueLimit,
    ),
    check(
      "genuine-event-overflow-observed",
      loss.uncertainReasons?.includes("event-overflow") === true &&
      Number(evidence.statsAfterLoss?.overflowEvents ?? 0) >
        Number(evidence.statsBeforeLoss?.overflowEvents ?? 0) &&
      helper.stopConfirmed === true,
    ),
    check(
      "consumer-backpressure-not-used-as-overflow-credit",
      loss.uncertainReasons?.includes("consumer-backpressure") !== true &&
      Number(evidence.statsAfterLoss?.batchesDropped ?? 0) === 0,
    ),
    check("event-overflow-invalidated-root", loss.rootBoundaryCount >= 1),
    check("overflow-output-path-drained-and-quiesced", loss.quiesced === true),
    check(
      "reconciliation-used-original-subscription",
      operation.publicSubscriptionCreations === 1 &&
      operation.automaticReconciliationEnabled === automatic &&
      operation.reconciliationCalls === (automatic ? 0 : 1) &&
      operation.reconciliationCallsOnOriginalSubscription === (automatic ? 0 : 1) &&
      operation.disposalRequests === 0,
    ),
    check(
      "automatic-overflow-policy-reported-recovery",
      !automatic || evidence.automaticStatus?.state === "recovered",
    ),
    check(
      "generation-zero-remained-zero",
      evidence.generationZeroResult?.exclusionGeneration === "0" &&
      generationZeroBoundaries.length === 1 &&
      generationZeroBoundaries[0].exclusionGeneration === "0",
    ),
    check("nonzero-exclusion-generation-committed", evidence.committedGeneration === "1"),
    check(
      "reconciliation-generation-unchanged",
      result?.exclusionGeneration === evidence.committedGeneration,
    ),
    check("all-primary-batches-have-counters", allPrimaryBatches.every((batch) =>
      batch.sequence != null && batch.exclusionGeneration != null
    )),
    check("primary-sequences-strictly-monotonic", countersStrictlyIncrease(allPrimaryBatches)),
    check(
      "no-primary-batch-crossed-committed-generation",
      primaryBatches.every((batch) =>
        batch.exclusionGeneration === evidence.committedGeneration
      ),
    ),
    check(
      "one-singleton-root-recovery-boundary",
      recoveryBatches.length === 1 && rootOnlyMatching.length === 1,
    ),
    check(
      "reconciliation-result-matches-root-batch-coverage",
      result != null && evidence.reconciliationError == null && rootOnlyMatching.length === 1,
    ),
    check(
      "loss-interval-mutation-was-supervised",
      interval.startedAfterOverflowObserved === true &&
      interval.completedBeforeReconciliation === true &&
      interval.conservativeRootBoundary === true,
    ),
    check(
      "coverage-stayed-uncertain-through-loss-interval",
      interval.coverageStayedUncertain === true,
    ),
    check("loss-interval-quiesced", interval.quiesced === true),
    check(
      "loss-interval-not-credited-as-detailed-reconstruction",
      interval.guaranteedDetailedReconstruction === false,
    ),
    check(
      "current-and-future-excluded-prefixes-stayed-excluded",
      evidence.excludedPathsObserved === false,
    ),
    check("reconciliation-scan-progress-observed", evidence.scanProgressObserved === true),
    check(
      "peer-delivered-during-reconciliation-scan",
      peer.deliveredDuringScan === true && peer.coverageTruthful === true,
    ),
    check("peer-sequences-strictly-monotonic", peer.sequencesStrictlyMonotonic === true),
    check("peer-generation-stayed-zero", peer.generationStayedZero === true),
    check(
      "post-reconciliation-deep-sentinel-delivered",
      evidence.postReconciliationSentinelDelivered === true,
    ),
    check(
      "root-replaced-not-credited-as-recovered",
      loss.uncertainReasons?.includes("root-replaced") !== true &&
      evidence.finalCoverageReason !== "root-replaced",
    ),
    check("joined-idempotent-disposal", lifecycle.bothDisposed === true),
    check(
      "post-disposal-reconciliation-rejected-by-lifecycle",
      lifecycle.reconcileRejectedAfterDisposal === true,
    ),
    check(
      "no-callback-started-after-disposal-resolved",
      lifecycle.noCallbackAfterDisposal === true,
    ),
    check("final-disposal-restored-inotify-resources", lifecycle.inotifyRestored === true),
    check("final-disposal-restored-eventfd-resources", lifecycle.eventfdsRestored === true),
    check("final-disposal-joined-native-threads", lifecycle.threadsRestored === true),
    check("final-subscription-state-returned-to-baseline", lifecycle.subscriptionStateReleased === true),
    check(
      "automatic-overflow-policy-joined-disposal",
      !automatic || lifecycle.automaticDisposed === true,
    ),
  ];
}

async function safeStats(session) {
  try {
    return (await session.stats?.()) ?? null;
  } catch (error) {
    return { error: { code: error?.code ?? null, message: error?.message ?? String(error) } };
  }
}

function normalizedGeneration(value) {
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  return typeof value === "string" ? value : null;
}

function sameCoverage(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compactBatchEvidence(batch, relevantPaths = []) {
  const relevant = new Set(relevantPaths.map((value) => path.resolve(value)));
  return {
    atMs: batch.atMs,
    sequence: batch.sequence,
    exclusionGeneration: batch.exclusionGeneration,
    pathCount: batch.paths.length,
    relevantPaths: batch.paths.filter((value) => relevant.has(value)),
    invalidated: batch.invalidated,
    rawEventCount: batch.rawEventCount,
    error: batch.error,
    coverage: batch.coverage,
  };
}

function watchboundThreadSample() {
  if (process.platform !== "linux") {
    return { supported: false, reason: "Linux /proc task metadata is required" };
  }
  try {
    const threads = fs.readdirSync("/proc/self/task")
      .filter((entry) => /^\d+$/u.test(entry))
      .map((entry) => ({
        tid: Number(entry),
        name: fs.readFileSync(`/proc/self/task/${entry}/comm`, "utf8").trim(),
      }))
      .filter((thread) => thread.name.startsWith("watchbound-"))
      .sort((left, right) => left.tid - right.tid);
    return { supported: true, count: threads.length, threads };
  } catch (error) {
    return {
      supported: false,
      reason: `Could not inspect /proc/self/task: ${error?.code ?? error?.message ?? String(error)}`,
    };
  }
}

function eventfdSample() {
  if (process.platform !== "linux") {
    return { supported: false, reason: "Linux /proc descriptor metadata is required" };
  }
  try {
    const descriptors = [];
    for (const entry of fs.readdirSync("/proc/self/fd")) {
      if (!/^\d+$/u.test(entry)) continue;
      let target;
      try {
        target = fs.readlinkSync(`/proc/self/fd/${entry}`);
      } catch {
        continue;
      }
      if (target === "anon_inode:[eventfd]") {
        descriptors.push(Number(entry));
      }
    }
    descriptors.sort((left, right) => left - right);
    return { supported: true, count: descriptors.length, descriptors };
  } catch (error) {
    return {
      supported: false,
      reason: `Could not inspect /proc/self/fd: ${error?.code ?? error?.message ?? String(error)}`,
    };
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
  if (config.allowForcedOverflow !== true) {
    throw new Error("queue-overflow requires the forced-overflow permission gate");
  }
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

async function runReconciliation(
  adapter,
  prepared,
  config,
  lossKind = "consumer-backpressure",
  automatic = false,
) {
  const forcedOverflow = lossKind === "event-overflow";
  if (forcedOverflow && config.allowForcedOverflow !== true) {
    throw new Error("overflow-reconciliation requires the forced-overflow permission gate");
  }
  const recorder = createRecorder(prepared.root);
  const peerRecorder = createRecorder(prepared.peerRoot);
  const primaryAllCheckpoint = recorder.checkpoint();
  const peerAllCheckpoint = peerRecorder.checkpoint();
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const lifecycleStartedAt = processSample();
  const threadsAtStart = watchboundThreadSample();
  const eventfdsAtStart = eventfdSample();
  let blockNextCallback = false;
  let callbackWasBlocked = false;
  let callbackWorkloadDurationMs = null;
  const callbackWorkloadRounds = Math.ceil(2_048 / prepared.pressureTargets.length);
  const callbackWorkloadOperations = callbackWorkloadRounds * prepared.pressureTargets.length;
  const automaticReconciliation = automatic
    ? { maxAttempts: 3, initialDelayMs: 750, maxDelayMs: 1_000 }
    : false;
  const primary = await subscribeMeasured(adapter, prepared, config, recorder, {
    batchWindowMs: 1,
    maxBatchPaths: 4_096,
    outputQueueCapacity: forcedOverflow ? 64 : 2,
    automaticReconciliation,
    onBatch(batch) {
      if (blockNextCallback && !callbackWasBlocked) {
        callbackWasBlocked = true;
        const workloadStartedAtMs = nowMs();
        for (let round = 0; round < callbackWorkloadRounds; round += 1) {
          for (const target of prepared.pressureTargets) {
            fs.appendFileSync(target, "pressure\n");
          }
        }
        callbackWorkloadDurationMs = nowMs() - workloadStartedAtMs;
        Atomics.wait(waitCell, 0, 0, 200);
      }
      recorder.onBatch(batch);
    },
  });
  let peer;
  let primaryDisposal = null;
  let peerDisposal = null;
  let cleanupFinished = false;
  try {
    peer = await subscribeMeasured(
      adapter,
      { root: prepared.peerRoot },
      config,
      peerRecorder,
      { batchWindowMs: 1 },
    );
    let threadsWhileSubscribed = watchboundThreadSample();
    let eventfdsWhileSubscribed = eventfdSample();
    await waitFor(() => {
      threadsWhileSubscribed = watchboundThreadSample();
      eventfdsWhileSubscribed = eventfdSample();
      const threadsReady = !threadsAtStart.supported || !threadsWhileSubscribed.supported ||
        threadsWhileSubscribed.count >= threadsAtStart.count + 3;
      const eventfdReady = !eventfdsAtStart.supported || !eventfdsWhileSubscribed.supported ||
        eventfdsWhileSubscribed.count >= eventfdsAtStart.count + 1;
      return threadsReady && eventfdReady;
    }, Math.min(config.timeoutMs, 1_000));
    await requirePhaseQuiescence(recorder, config, "primary subscription startup");
    await requirePhaseQuiescence(peerRecorder, config, "peer subscription startup");

    const peerGenerationZeroCheckpoint = peerRecorder.checkpoint();
    const peerReconcileStartedAtMs = nowMs();
    const peerReconciliation = await peer.session.reconcile();
    const peerReconcileAcknowledgedAtMs = nowMs();
    const peerRootObserved = await waitFor(
      () => peerRecorder.batchesSince(peerGenerationZeroCheckpoint).some((batch) =>
        batch.paths.includes(path.resolve(prepared.peerRoot)) &&
        batch.exclusionGeneration === "0" &&
        sameCoverage(batch.coverage, peerReconciliation.coverage)
      ),
      config.timeoutMs,
    );
    const peerGenerationZeroQuiesced = await waitForQuiescence(peerRecorder, config);
    const peerGenerationZeroObservation = {
      quiesced: peerGenerationZeroQuiesced,
      ...peerRecorder.summary(peerGenerationZeroCheckpoint),
    };

    const exclusionCoverage = await primary.session.updateExclusions([
      prepared.excludedDirectory,
    ]);
    const committedGeneration = primary.session.exclusionGeneration;
    await requirePhaseQuiescence(recorder, config, "exclusion commit");

    blockNextCallback = !forcedOverflow;
    const pressureCheckpoint = recorder.checkpoint();
    const statsBeforePressure = await safeStats(primary.session);
    const pressureStartedAtMs = nowMs();
    let overflowHelper = null;
    let kernelQueueLimit = null;
    let generatedEventCount = null;
    if (forcedOverflow) {
      kernelQueueLimit = 16_384;
      try {
        const parsed = Number.parseInt(
          fs.readFileSync("/proc/sys/fs/inotify/max_queued_events", "utf8").trim(),
          10,
        );
        if (Number.isSafeInteger(parsed) && parsed > 0) kernelQueueLimit = parsed;
      } catch {}
      generatedEventCount = kernelQueueLimit + 4_096;
      overflowHelper = await runOverflowMutator({
        watcherPid: process.pid,
        root: prepared.root,
        count: generatedEventCount,
        kernelQueueLimit,
      });
    } else {
      for (const target of prepared.pressureTargets) {
        fs.appendFileSync(target, "trigger\n");
      }
    }
    const pressureMutationEndedAtMs = nowMs();
    const uncertaintyObserved = await waitFor(
      () => recorder
        .summary(pressureCheckpoint)
        .uncertainReasons
        .includes(lossKind),
      config.timeoutMs,
    );
    const pressureQuiesced = await waitForQuiescence(recorder, config);
    const pressureObservation = {
      quiesced: pressureQuiesced,
      ...recorder.summary(pressureCheckpoint, [prepared.root]),
    };
    const pressureBatches = recorder.batchesSince(pressureCheckpoint);
    const statsAfterPressure = await safeStats(primary.session);

    const intervalCheckpoint = recorder.checkpoint();
    const intervalMutationStartedAtMs = nowMs();
    for (const directory of prepared.scanDirectories) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.mkdirSync(path.dirname(prepared.intervalTarget), { recursive: true });
    fs.writeFileSync(prepared.intervalTarget, "during uncertainty\n");
    fs.writeFileSync(prepared.excludedCurrentTarget, "ignored current\n");
    fs.mkdirSync(path.dirname(prepared.excludedFutureTarget), { recursive: true });
    fs.writeFileSync(prepared.excludedFutureTarget, "ignored future\n");
    const intervalMutationEndedAtMs = nowMs();
    const intervalQuiesced = await requirePhaseQuiescence(
      recorder,
      config,
      "uncertain-interval mutations",
    );
    const intervalObservation = {
      quiesced: intervalQuiesced,
      ...recorder.summary(intervalCheckpoint, [
        prepared.intervalTarget,
        prepared.excludedCurrentTarget,
        prepared.excludedFutureTarget,
      ]),
    };
    const intervalBatches = recorder.batchesSince(intervalCheckpoint);

    const reconciliationCheckpoint = recorder.checkpoint();
    const statsBeforeReconciliation = await safeStats(primary.session);
    const reconciliationStartedAtMs = nowMs();
    let reconciliationSettled = false;
    const requestedReconciliation = automatic
      ? (async () => {
          const terminalObserved = await waitFor(() =>
            ["recovered", "incomplete", "exhausted", "blocked"].includes(
              primary.session.automaticReconciliation?.state,
            ), config.timeoutMs, 1);
          const status = primary.session.automaticReconciliation;
          if (!terminalObserved) {
            throw new Error("automatic reconciliation did not reach a terminal status");
          }
          if (status.state !== "recovered" && status.state !== "incomplete") {
            throw new Error(
              `automatic reconciliation ended in ${status.state}: ${status.error ?? status.reason}`,
            );
          }
          return {
            exclusionGeneration: status.exclusionGeneration,
            coverage: status.coverage,
          };
        })()
      : primary.session.reconcile();
    const reconciliationPromise = requestedReconciliation.then(
      (result) => {
        reconciliationSettled = true;
        return result;
      },
      (error) => {
        reconciliationSettled = true;
        throw error;
      },
    );
    let statsAtScanProgress = null;
    let scanProgressObserved = false;
    await waitFor(async () => {
      statsAtScanProgress = await safeStats(primary.session);
      scanProgressObserved = !reconciliationSettled &&
        Number(statsAtScanProgress?.topologyScans ?? 0) >
          Number(statsBeforeReconciliation?.topologyScans ?? 0);
      return scanProgressObserved || reconciliationSettled;
    }, config.timeoutMs, 1);
    const peerMutationStartedAtMs = nowMs();
    fs.writeFileSync(prepared.peerTarget, "peer delivery\n");
    const peerMutationEndedAtMs = nowMs();
    let reconciliationResult = null;
    let reconciliationError = null;
    try {
      reconciliationResult = await reconciliationPromise;
    } catch (error) {
      reconciliationError = serializeError(error);
    }
    const reconciliationAcknowledgedAtMs = nowMs();
    const recoveryRootObserved = reconciliationResult != null && await waitFor(
      () => recorder.batchesSince(reconciliationCheckpoint).some((batch) =>
        batch.paths.includes(path.resolve(prepared.root)) &&
        batch.exclusionGeneration === committedGeneration &&
        sameCoverage(batch.coverage, reconciliationResult.coverage)
      ),
      config.timeoutMs,
    );
    const peerDelivered = await waitFor(
      () => peerRecorder.pathCountSince(peerGenerationZeroCheckpoint, prepared.peerTarget) > 0,
      config.timeoutMs,
    );
    const recoveryQuiesced = await waitForQuiescence(recorder, config);
    const peerQuiesced = await waitForQuiescence(peerRecorder, config);
    const reconciliationObservation = {
      quiesced: recoveryQuiesced,
      ...recorder.summary(reconciliationCheckpoint),
    };
    const reconciliationBatches = recorder.batchesSince(reconciliationCheckpoint);
    const peerObservation = {
      detectedBeforeTimeout: peerDelivered,
      quiesced: peerQuiesced,
      ...peerRecorder.summary(peerGenerationZeroCheckpoint, [prepared.peerTarget]),
    };
    const peerBatches = peerRecorder.batchesSince(peerGenerationZeroCheckpoint);
    const peerDeliveryBatch = peerBatches.find((batch) =>
      batch.paths.includes(path.resolve(prepared.peerTarget))
    );
    const resolvedPrimaryRoot = path.resolve(prepared.root);
    const recoveryRootBatches = reconciliationBatches.filter((batch) =>
      batch.paths.includes(resolvedPrimaryRoot)
    );
    const matchingRecoveryBoundaries = reconciliationResult == null
      ? []
      : recoveryRootBatches.filter((batch) =>
        batch.paths.length === 1 &&
        batch.paths[0] === resolvedPrimaryRoot &&
        batch.exclusionGeneration === committedGeneration &&
        sameCoverage(batch.coverage, reconciliationResult.coverage)
      );

    const postReconciliationCheckpoint = recorder.checkpoint();
    fs.writeFileSync(prepared.postReconciliationTarget, "post reconciliation\n");
    const postReconciliationObservation = await observeExpected(
      recorder,
      postReconciliationCheckpoint,
      [prepared.postReconciliationTarget],
      config,
    );
    const postReconciliationBatches = recorder.batchesSince(postReconciliationCheckpoint);
    const primaryPostCommitObservation = recorder.summary(pressureCheckpoint);
    const resolvedExcludedRoot = path.resolve(prepared.root, prepared.excludedDirectory);
    const isExcludedPath = (candidate) =>
      candidate === resolvedExcludedRoot ||
      candidate.startsWith(`${resolvedExcludedRoot}${path.sep}`);
    const excludedPathsObserved = pressureBatches
      .concat(intervalBatches)
      .concat(reconciliationBatches)
      .concat(postReconciliationBatches)
      .some((batch) => batch.paths.some(isExcludedPath));
    const primaryOperationEvidenceBeforeDisposal = primary.session.operationEvidence?.() ?? null;
    const automaticStatusBeforeDisposal = primary.session.automaticReconciliation ?? null;
    const finalStatsBeforeDisposal = await safeStats(primary.session);
    const peerFinalStatsBeforeDisposal = await safeStats(peer.session);

    [primaryDisposal, peerDisposal] = await Promise.all([
      disposeMeasured(primary.session),
      disposeMeasured(peer.session),
    ]);
    await Promise.all([primary.session.dispose(), peer.session.dispose()]);
    cleanupFinished = true;
    const postDisposalPrimaryCheckpoint = recorder.checkpoint();
    const postDisposalPeerCheckpoint = peerRecorder.checkpoint();
    const finalStats = await safeStats(primary.session);
    const peerFinalStats = await safeStats(peer.session);
    let postDisposalReconciliationError = null;
    try {
      await primary.session.reconcile();
    } catch (error) {
      postDisposalReconciliationError = serializeError(error);
    }
    const postDisposalReconciliationRejectedByLifecycle =
      /disposing|disposed|not connected|no longer active/iu.test(
        postDisposalReconciliationError?.message ?? "",
      );
    fs.appendFileSync(prepared.pressureTargets[0], "after disposal\n");
    fs.appendFileSync(prepared.peerTarget, "after disposal\n");
    await sleep(config.disposalObservationMs);
    const postDisposalObservation = {
      primary: recorder.summary(postDisposalPrimaryCheckpoint),
      peer: peerRecorder.summary(postDisposalPeerCheckpoint),
    };
    const primaryOperationEvidenceAfterDisposal = primary.session.operationEvidence?.() ?? null;
    const automaticStatusAfterDisposal = primary.session.automaticReconciliation ?? null;
    const lifecycleFinishedAt = processSample();
    const threadsAtEnd = watchboundThreadSample();
    const eventfdsAtEnd = eventfdSample();
    const inotifyRestored =
      lifecycleStartedAt.inotify.supported && lifecycleFinishedAt.inotify.supported
        ? lifecycleStartedAt.inotify.instances === lifecycleFinishedAt.inotify.instances &&
          lifecycleStartedAt.inotify.watches === lifecycleFinishedAt.inotify.watches
        : null;
    const threadsRestored = threadsAtStart.supported && threadsAtEnd.supported
      ? threadsAtStart.count === threadsAtEnd.count
      : null;
    const activeThreadsObserved = threadsAtStart.supported && threadsWhileSubscribed.supported
      ? threadsWhileSubscribed.count >= threadsAtStart.count + 3
      : null;
    const eventfdsRestored = eventfdsAtStart.supported && eventfdsAtEnd.supported
      ? eventfdsAtStart.count === eventfdsAtEnd.count
      : null;
    const runtimeEventfdObserved = eventfdsAtStart.supported && eventfdsWhileSubscribed.supported
      ? eventfdsWhileSubscribed.count >= eventfdsAtStart.count + 1
      : null;
    const allPrimaryPostCommitBatchesUseGeneration = pressureBatches
      .concat(intervalBatches)
      .concat(reconciliationBatches)
      .concat(postReconciliationBatches)
      .every((batch) => batch.exclusionGeneration === committedGeneration);
    const peerCoverageStayedComplete = peerBatches.every(
      (batch) => batch.coverage?.state === "complete",
    );
    const peerCoverageTruthful = peerBatches.every((batch) =>
      typeof batch.coverage?.state === "string"
    );
    const allPrimaryBatches = recorder.batchesSince(primaryAllCheckpoint);
    const allPeerBatches = peerRecorder.batchesSince(peerAllCheckpoint);
    const isRootBatch = (batch, root) => batch.paths.includes(path.resolve(root));
    const overflowChecks = forcedOverflow
      ? [
          ...evaluateOverflowReconciliationEvidence({
            automatic,
            automaticStatus: automaticStatusBeforeDisposal,
            root: resolvedPrimaryRoot,
            helper: overflowHelper,
            lossObservation: pressureObservation,
            statsBeforeLoss: statsBeforePressure,
            statsAfterLoss: statsAfterPressure,
            committedGeneration,
            generationZeroResult: peerReconciliation,
            generationZeroRootBoundaries: peerGenerationZeroObservation.rootBoundaries,
            reconciliationResult,
            reconciliationError,
            recoveryBatches: recoveryRootBatches,
            primaryBatches: pressureBatches
              .concat(intervalBatches)
              .concat(reconciliationBatches)
              .concat(postReconciliationBatches),
            allPrimaryBatches,
            intervalMutation: {
              startedAfterOverflowObserved: uncertaintyObserved &&
                intervalMutationStartedAtMs >= pressureMutationEndedAtMs,
              completedBeforeReconciliation:
                intervalMutationEndedAtMs <= reconciliationStartedAtMs,
              detailedPathObserved: intervalObservation.detectedPathCount > 0,
              guaranteedDetailedReconstruction: false,
              conservativeRootBoundary:
                recoveryRootBatches.length === 1 && matchingRecoveryBoundaries.length === 1,
              coverageStayedUncertain:
                intervalObservation.uncertainReasons.includes("event-overflow"),
              quiesced: intervalObservation.quiesced,
            },
            excludedPathsObserved,
            originalSubscription: primaryOperationEvidenceBeforeDisposal,
            peer: {
              deliveredDuringScan: scanProgressObserved && peerDelivered &&
                peerDeliveryBatch?.atMs >= reconciliationStartedAtMs &&
                peerDeliveryBatch?.atMs <= reconciliationAcknowledgedAtMs,
              coverageTruthful: peerCoverageTruthful && allPeerBatches.every((batch) =>
                typeof batch.coverage?.state === "string"
              ),
              sequencesStrictlyMonotonic: countersStrictlyIncrease(allPeerBatches),
              generationStayedZero: allPeerBatches.every((batch) =>
                batch.exclusionGeneration === "0"
              ),
            },
            scanProgressObserved,
            postReconciliationSentinelDelivered:
              deliverySucceeded(postReconciliationObservation),
            finalCoverageReason: reconciliationResult?.coverage?.reason ?? null,
            lifecycle: {
              bothDisposed: finalStats?.disposed === true && peerFinalStats?.disposed === true,
              reconcileRejectedAfterDisposal:
                postDisposalReconciliationRejectedByLifecycle,
              noCallbackAfterDisposal:
                postDisposalObservation.primary.batchCount === 0 &&
                postDisposalObservation.peer.batchCount === 0,
              inotifyRestored,
              eventfdsRestored,
              threadsRestored,
              subscriptionStateReleased:
                finalStats?.disposed === true && peerFinalStats?.disposed === true &&
                Number(finalStats?.directoryWatches ?? 0) === 0 &&
                Number(peerFinalStats?.directoryWatches ?? 0) === 0,
              automaticDisposed: automaticStatusAfterDisposal?.state === "disposed",
            },
          }),
          ...observationHealthChecks("event-overflow", pressureObservation),
          ...observationHealthChecks("overflow-loss-interval", intervalObservation),
          ...observationHealthChecks("overflow-reconciliation", reconciliationObservation),
          ...observationHealthChecks("post-overflow-reconciliation", postReconciliationObservation),
          ...observationHealthChecks("overflow-peer", peerObservation),
        ]
      : null;

    return {
      subscriptionLifecycle: {
        beforeDisposal: primaryOperationEvidenceBeforeDisposal,
        afterDisposal: primaryOperationEvidenceAfterDisposal,
      },
      automaticReconciliation: {
        beforeDisposal: automaticStatusBeforeDisposal,
        afterDisposal: automaticStatusAfterDisposal,
      },
      subscriptionOptions: {
        batchWindowMs: 1,
        maxBatchPaths: 4_096,
        outputQueueCapacity: forcedOverflow ? 64 : 2,
        automaticReconciliation,
      },
      recoveryMode: automatic ? "automatic" : "manual",
      lossKind,
      overflowInduction: forcedOverflow ? {
        kernelQueueLimit,
        generatedEventCount,
        helper: overflowHelper,
      } : null,
      callbackBlockMs: 200,
      callbackWasBlocked,
      callbackWorkloadDurationMs,
      callbackWorkloadOperations,
      pressureMutationDurationMs: pressureMutationEndedAtMs - pressureStartedAtMs,
      intervalMutationDurationMs: intervalMutationEndedAtMs - intervalMutationStartedAtMs,
      peerMutationDurationMs: peerMutationEndedAtMs - peerMutationStartedAtMs,
      subscription: primary.measurement,
      peerSubscription: peer.measurement,
      committedExclusion: {
        generation: committedGeneration,
        coverage: exclusionCoverage,
      },
      pressureObservation,
      statsBeforePressure,
      statsAfterPressure,
      intervalObservation,
      relevantBatches: {
        uncertainty: pressureBatches.filter((batch) =>
          batch.coverage?.state === "uncertain" || isRootBatch(batch, prepared.root)
        ).map((batch) => compactBatchEvidence(batch, [prepared.root])),
        uncertainInterval: intervalBatches.filter((batch) =>
          batch.coverage?.state === "uncertain" || isRootBatch(batch, prepared.root)
        ).map((batch) => compactBatchEvidence(batch, [
          prepared.root,
          prepared.intervalTarget,
          prepared.excludedCurrentTarget,
          prepared.excludedFutureTarget,
        ])),
        recovery: reconciliationBatches.filter((batch) =>
          isRootBatch(batch, prepared.root)
        ).map((batch) => compactBatchEvidence(batch, [prepared.root])),
        postReconciliation: postReconciliationBatches.map((batch) =>
          compactBatchEvidence(batch, [prepared.postReconciliationTarget])
        ),
        peer: peerBatches.filter((batch) =>
          isRootBatch(batch, prepared.peerRoot) ||
          batch.paths.includes(path.resolve(prepared.peerTarget))
        ).map((batch) => compactBatchEvidence(batch, [
          prepared.peerRoot,
          prepared.peerTarget,
        ])),
      },
      reconciliation: {
        startedAtMs: reconciliationStartedAtMs,
        acknowledgedAtMs: reconciliationAcknowledgedAtMs,
        statsBefore: statsBeforeReconciliation,
        scanProgressObserved,
        statsAtScanProgress,
        result: reconciliationResult,
        error: reconciliationError,
        callbackRootObserved: recoveryRootObserved,
        matchingRootBoundaries: matchingRecoveryBoundaries,
        callbackAfterAcknowledgement:
          matchingRecoveryBoundaries[0]?.atMs > reconciliationAcknowledgedAtMs,
      },
      peerGenerationZero: {
        startedAtMs: peerReconcileStartedAtMs,
        acknowledgedAtMs: peerReconcileAcknowledgedAtMs,
        result: peerReconciliation,
        callbackRootObserved: peerRootObserved,
        observation: peerGenerationZeroObservation,
      },
      peerObservation,
      postReconciliationObservation,
      primaryPostCommitObservation,
      finalStatsBeforeDisposal,
      peerFinalStatsBeforeDisposal,
      finalStats,
      peerFinalStats,
      disposal: primaryDisposal,
      peerDisposal,
      postDisposalReconciliationError,
      postDisposalReconciliationRejectedByLifecycle,
      postDisposalObservation,
      cleanup: {
        inotifyAtStart: lifecycleStartedAt.inotify,
        inotifyAtEnd: lifecycleFinishedAt.inotify,
        inotifyRestored,
        eventfdsAtStart,
        eventfdsWhileSubscribed,
        eventfdsAtEnd,
        runtimeEventfdObserved,
        eventfdsRestored,
        threadsAtStart,
        threadsWhileSubscribed,
        threadsAtEnd,
        activeThreadsObserved,
        threadsRestored,
      },
      observation: postReconciliationObservation,
      checks: overflowChecks ?? [
        check(
          "reconciliation-used-existing-subscription",
          primaryOperationEvidenceBeforeDisposal?.publicSubscriptionCreations === 1 &&
          primaryOperationEvidenceBeforeDisposal?.reconciliationCalls === (automatic ? 0 : 1) &&
          primaryOperationEvidenceBeforeDisposal?.reconciliationCallsOnOriginalSubscription ===
            (automatic ? 0 : 1) &&
          primaryOperationEvidenceBeforeDisposal?.disposalRequests === 0,
          { evidence: primaryOperationEvidenceBeforeDisposal },
        ),
        check(
          "automatic-policy-mode-explicit",
          primaryOperationEvidenceBeforeDisposal?.automaticReconciliationEnabled === automatic,
          { automatic, evidence: primaryOperationEvidenceBeforeDisposal },
        ),
        check(
          "automatic-policy-reported-terminal-recovery",
          !automatic || automaticStatusBeforeDisposal?.state === "recovered",
          { status: automaticStatusBeforeDisposal },
        ),
        check("generation-zero-result-remained-zero", peerReconciliation.exclusionGeneration === "0"),
        check("generation-zero-root-remained-zero", peerGenerationZeroObservation.rootBoundaries.some(
          (batch) => batch.exclusionGeneration === "0",
        )),
        check("nonzero-exclusion-generation-committed", committedGeneration === "1"),
        check(
          "consumer-backpressure-reported-before-reconciliation",
          uncertaintyObserved && pressureObservation.uncertainReasons.includes("consumer-backpressure"),
        ),
        check("consumer-backpressure-output-path-drained", pressureQuiesced),
        check("native-output-batch-dropped", Number(statsAfterPressure?.batchesDropped ?? 0) > 0, {
          batchesDropped: statsAfterPressure?.batchesDropped ?? null,
        }),
        check("reconciliation-succeeded", reconciliationResult != null && reconciliationError == null, {
          error: reconciliationError,
        }),
        check(
          "reconciliation-generation-unchanged",
          reconciliationResult?.exclusionGeneration === committedGeneration,
        ),
        check("recovery-root-entered-public-callback-path", recoveryRootObserved),
        check(
          "recovery-commit-has-result-and-root-evidence",
          reconciliationResult != null && recoveryRootObserved,
        ),
        check("one-root-only-conservative-recovery-boundary",
          recoveryRootBatches.length === 1 && matchingRecoveryBoundaries.length === 1,
          {
            rootBatchCount: recoveryRootBatches.length,
            matchingRootOnlyCount: matchingRecoveryBoundaries.length,
            pathCounts: recoveryRootBatches.map((batch) => batch.paths.length),
          },
        ),
        check("reconciliation-scan-progress-observed", scanProgressObserved, {
          before: statsBeforeReconciliation?.topologyScans ?? null,
          during: statsAtScanProgress?.topologyScans ?? null,
        }),
        check(
          "reconciliation-result-matches-root-coverage",
          matchingRecoveryBoundaries.length === 1 &&
          sameCoverage(matchingRecoveryBoundaries[0].coverage, reconciliationResult?.coverage),
        ),
        check(
          "interval-mutations-have-conservative-root-boundary",
          recoveryRootBatches.length === 1 && matchingRecoveryBoundaries.length === 1,
          { detailedIntervalPathObserved: intervalObservation.detectedPathCount > 0 },
        ),
        check(
          "coverage-stayed-uncertain-through-interval-mutations",
          intervalObservation.uncertainReasons.includes("consumer-backpressure"),
        ),
        check("current-and-future-excluded-prefixes-stayed-excluded", !excludedPathsObserved),
        check("post-reconciliation-deep-change-delivered", deliverySucceeded(postReconciliationObservation)),
        check("primary-sequences-monotonic", primaryPostCommitObservation.sequencesStrictlyMonotonic),
        check("primary-batch-counters-complete", pressureObservation.allSequencesPresent &&
          pressureObservation.allExclusionGenerationsPresent &&
          reconciliationObservation.allSequencesPresent &&
          reconciliationObservation.allExclusionGenerationsPresent),
        check("no-primary-batch-crossed-the-committed-generation", allPrimaryPostCommitBatchesUseGeneration),
        check("peer-generation-zero-reconciliation-root-delivered", peerRootObserved),
        check(
          "peer-has-one-generation-zero-reconciliation-boundary",
          peerGenerationZeroObservation.rootBoundaryCount === 1,
          { count: peerGenerationZeroObservation.rootBoundaryCount },
        ),
        check(
          "peer-change-delivered-during-primary-reconciliation-phase",
          scanProgressObserved && peerDelivered &&
          peerDeliveryBatch?.atMs >= reconciliationStartedAtMs &&
          peerDeliveryBatch?.atMs <= reconciliationAcknowledgedAtMs,
          {
            reconciliationStartedAtMs,
            reconciliationAcknowledgedAtMs,
            peerDeliveredAtMs: peerDeliveryBatch?.atMs ?? null,
          },
        ),
        check("peer-coverage-remained-complete", peerCoverageStayedComplete),
        check("peer-sequences-monotonic", peerObservation.sequencesStrictlyMonotonic),
        check("peer-batches-remained-generation-zero", peerObservation.allExclusionGenerationsPresent &&
          peerObservation.exclusionGenerations.length === 1 &&
          peerObservation.exclusionGenerations[0] === "0"),
        check("joined-disposal-marked-both-subscriptions-disposed", finalStats?.disposed === true &&
          peerFinalStats?.disposed === true),
        check(
          "automatic-policy-joined-disposal",
          !automatic || automaticStatusAfterDisposal?.state === "disposed",
          { status: automaticStatusAfterDisposal },
        ),
        check("post-disposal-reconciliation-rejected-by-lifecycle", postDisposalReconciliationRejectedByLifecycle, {
          error: postDisposalReconciliationError,
        }),
        check("no-primary-callback-after-disposal", postDisposalObservation.primary.batchCount === 0),
        check("no-peer-callback-after-disposal", postDisposalObservation.peer.batchCount === 0),
        inotifyRestored == null
          ? unavailableCheck(
              "final-disposal-restored-inotify-resources",
              lifecycleFinishedAt.inotify.reason ?? lifecycleStartedAt.inotify.reason,
            )
          : check("final-disposal-restored-inotify-resources", inotifyRestored),
        runtimeEventfdObserved == null
          ? unavailableCheck(
              "shared-runtime-eventfd-was-observed",
              eventfdsWhileSubscribed.reason ?? eventfdsAtStart.reason,
            )
          : check("shared-runtime-eventfd-was-observed", runtimeEventfdObserved, {
              baseline: eventfdsAtStart.count,
              active: eventfdsWhileSubscribed.count,
            }),
        eventfdsRestored == null
          ? unavailableCheck(
              "final-disposal-restored-eventfd-resources",
              eventfdsAtEnd.reason ?? eventfdsAtStart.reason,
            )
          : check("final-disposal-restored-eventfd-resources", eventfdsRestored),
        activeThreadsObserved == null
          ? unavailableCheck(
              "native-runtime-and-bridge-threads-were-observed",
              threadsWhileSubscribed.reason ?? threadsAtStart.reason,
            )
          : check("native-runtime-and-bridge-threads-were-observed", activeThreadsObserved, {
              baseline: threadsAtStart.count,
              active: threadsWhileSubscribed.count,
            }),
        threadsRestored == null
          ? unavailableCheck(
              "final-disposal-joined-native-threads",
              threadsAtEnd.reason ?? threadsAtStart.reason,
            )
          : check("final-disposal-joined-native-threads", threadsRestored),
        ...observationHealthChecks("reconciliation", reconciliationObservation),
        ...observationHealthChecks("post-reconciliation", postReconciliationObservation),
        ...observationHealthChecks("peer", peerObservation),
      ],
    };
  } finally {
    if (!cleanupFinished) {
      await Promise.allSettled([
        primary.session.dispose(),
        peer?.session.dispose(),
      ].filter(Boolean));
    }
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
      if (stderr.length < 32 * 1_024) {
        stderr = (stderr + chunk.toString()).slice(0, 32 * 1_024);
      }
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
  if (name === "reconciliation") return runReconciliation(adapter, prepared, config);
  if (name === "automatic-reconciliation") {
    return runReconciliation(adapter, prepared, config, "consumer-backpressure", true);
  }
  if (name === "overflow-reconciliation") {
    return runReconciliation(adapter, prepared, config, "event-overflow");
  }
  if (name === "automatic-overflow-reconciliation") {
    return runReconciliation(adapter, prepared, config, "event-overflow", true);
  }
  if (name === "burst-files") return runBurst(adapter, prepared, config, "files");
  if (name === "burst-directories") return runBurst(adapter, prepared, config, "directories");
  if (name === "burst-renames") return runBurst(adapter, prepared, config, "renames");
  if (name === "disposal") return runDisposal(adapter, prepared, config);
  throw new Error(`Unknown scenario: ${name}`);
}
