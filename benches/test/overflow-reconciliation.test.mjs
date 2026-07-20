import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { help, parseOptions } from "../lib/cli.mjs";
import {
  aggregateResults,
  scenarioExclusionReason,
} from "../lib/controller.mjs";
import {
  evaluateOverflowReconciliationEvidence,
  prepareScenario,
  runScenario,
  scenarioNames,
  scenarioRequirement,
} from "../lib/scenarios.mjs";

function completeEvidence(overrides = {}) {
  const root = "/tmp/watchbound-overflow-reconciliation/root";
  const coverage = { state: "complete" };
  return {
    root,
    helper: {
      stopConfirmed: true,
      mutationStartedAfterStopConfirmed: true,
      mutationCompletedBeforeResume: true,
      resumeAttempted: true,
      resumeConfirmed: true,
      generated: 20_480,
      kernelQueueLimit: 16_384,
    },
    lossObservation: {
      uncertainReasons: ["event-overflow"],
      rootBoundaryCount: 1,
      quiesced: true,
    },
    statsBeforeLoss: { overflowEvents: 0 },
    statsAfterLoss: { overflowEvents: 1, batchesDropped: 0 },
    committedGeneration: "1",
    generationZeroResult: { exclusionGeneration: "0" },
    generationZeroRootBoundaries: [{ exclusionGeneration: "0" }],
    reconciliationResult: { exclusionGeneration: "1", coverage },
    reconciliationError: null,
    recoveryBatches: [{
      sequence: "8",
      exclusionGeneration: "1",
      paths: [root],
      coverage,
    }],
    primaryBatches: [
      {
        sequence: "6",
        exclusionGeneration: "1",
        paths: [root],
        coverage: { state: "uncertain", reason: "event-overflow" },
      },
      {
        sequence: "7",
        exclusionGeneration: "1",
        paths: [root],
        coverage: { state: "uncertain", reason: "event-overflow" },
      },
      {
        sequence: "8",
        exclusionGeneration: "1",
        paths: [root],
        coverage,
      },
      {
        sequence: "9",
        exclusionGeneration: "1",
        paths: [`${root}/recovered/deep/sentinel.txt`],
        coverage,
      },
    ],
    intervalMutation: {
      startedAfterOverflowObserved: true,
      completedBeforeReconciliation: true,
      guaranteedDetailedReconstruction: false,
      conservativeRootBoundary: true,
      coverageStayedUncertain: true,
      quiesced: true,
    },
    excludedPathsObserved: false,
    originalSubscription: {
      publicSubscriptionCreations: 1,
      automaticReconciliationEnabled: false,
      reconciliationCalls: 1,
      reconciliationCallsOnOriginalSubscription: 1,
      disposalRequests: 0,
    },
    peer: {
      deliveredDuringScan: true,
      coverageTruthful: true,
      sequencesStrictlyMonotonic: true,
      generationStayedZero: true,
    },
    scanProgressObserved: true,
    postReconciliationSentinelDelivered: true,
    finalCoverageReason: null,
    lifecycle: {
      bothDisposed: true,
      reconcileRejectedAfterDisposal: true,
      noCallbackAfterDisposal: true,
      inotifyRestored: true,
      eventfdsRestored: true,
      threadsRestored: true,
      subscriptionStateReleased: true,
    },
    ...overrides,
  };
}

function failedCheckNames(evidence) {
  return evaluateOverflowReconciliationEvidence(evidence)
    .filter((check) => check.passed === false)
    .map((check) => check.name);
}

test("overflow reconciliation is listed but removed with every forced-overflow scenario by quick", () => {
  assert.ok(scenarioNames.includes("overflow-reconciliation"));
  assert.ok(scenarioNames.includes("automatic-overflow-reconciliation"));
  assert.match(help("conformance"), /overflow-reconciliation/u);
  assert.match(help("conformance"), /automatic-overflow-reconciliation/u);
  assert.equal(parseOptions("conformance", ["--help"]).help, true);
  assert.equal(scenarioRequirement("overflow-reconciliation"), "overflowReconciliation");
  assert.throws(
    () => parseOptions("conformance", [
      "--adapter", "watchbound",
      "--scenario", "overflow-reconciliation",
      "--quick",
      "--strict",
      "--pretty",
    ]),
    /No scenarios remain after applying command presets/u,
  );
  const quick = parseOptions("conformance", ["--quick"]);
  assert.ok(!quick.scenarios.includes("queue-overflow"));
  assert.ok(!quick.scenarios.includes("overflow-reconciliation"));
  assert.ok(!quick.scenarios.includes("automatic-overflow-reconciliation"));
});

test("all heavy scenarios require explicit forced-overflow permission before planning", () => {
  for (const scenario of [
    "queue-overflow",
    "overflow-reconciliation",
    "automatic-overflow-reconciliation",
  ]) {
    assert.throws(
      () => parseOptions("conformance", ["--scenario", scenario]),
      /--allow-forced-overflow/u,
    );
    const allowed = parseOptions("conformance", [
      "--scenario", scenario,
      "--allow-forced-overflow",
    ]);
    assert.equal(allowed.allowForcedOverflow, true);
  }
});

test("scenario dispatch retains a second forced-overflow permission guard", async () => {
  await assert.rejects(
    runScenario("queue-overflow", null, null, {}),
    /permission gate/u,
  );
  await assert.rejects(
    runScenario("overflow-reconciliation", null, null, {}),
    /permission gate/u,
  );
  await assert.rejects(
    runScenario("automatic-overflow-reconciliation", null, null, {}),
    /permission gate/u,
  );
});

test("overflow reconciliation preparation is bounded and keeps primary and peer roots separate", () => {
  const runDirectory = `/tmp/watchbound-overflow-reconciliation-prepare-${process.pid}-${Date.now()}`;
  try {
    const prepared = prepareScenario(
      "automatic-overflow-reconciliation",
      { burstCount: 100 },
      runDirectory,
    );
    assert.notEqual(prepared.root, prepared.peerRoot);
    assert.ok(prepared.scanDirectories.length >= 32);
    assert.ok(prepared.scanDirectories.length <= 256);
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("automatic overflow evidence requires zero manual calls on the original subscription", () => {
  const automatic = completeEvidence({
    automatic: true,
    automaticStatus: {
      state: "recovered",
      reason: "event-overflow",
      attempts: 1,
      exclusionGeneration: "1",
      coverage: { state: "complete" },
    },
    originalSubscription: {
      publicSubscriptionCreations: 1,
      automaticReconciliationEnabled: true,
      reconciliationCalls: 0,
      reconciliationCallsOnOriginalSubscription: 0,
      disposalRequests: 0,
    },
    lifecycle: {
      ...completeEvidence().lifecycle,
      automaticDisposed: true,
    },
  });
  assert.deepEqual(failedCheckNames(automatic), []);

  automatic.originalSubscription.reconciliationCalls = 1;
  automatic.originalSubscription.reconciliationCallsOnOriginalSubscription = 1;
  assert.ok(
    failedCheckNames(automatic).includes("reconciliation-used-original-subscription"),
  );
});

test("unsupported adapters are explicitly capability-excluded and cannot receive pass credit", () => {
  const plan = { scenario: "overflow-reconciliation" };
  const base = {
    status: "available",
    adapter: {
      capabilities: {
        reconciliation: true,
        explicitCoverage: true,
        overflowReporting: true,
        supervisedOverflow: true,
        dynamicExclusions: { supported: true, atomic: true },
      },
    },
  };
  assert.equal(scenarioExclusionReason(plan, base), null);
  for (const mutate of [
    (value) => { value.adapter.capabilities.reconciliation = false; },
    (value) => { value.adapter.capabilities.explicitCoverage = false; },
    (value) => { value.adapter.capabilities.overflowReporting = false; },
    (value) => { value.adapter.capabilities.supervisedOverflow = false; },
    (value) => { value.adapter.capabilities.dynamicExclusions.atomic = false; },
  ]) {
    const unsupported = structuredClone(base);
    mutate(unsupported);
    assert.match(scenarioExclusionReason(plan, unsupported), /requires|supported/iu);
  }
});

test("automatic overflow reconciliation requires both automatic and overflow capabilities", () => {
  const plan = { scenario: "automatic-overflow-reconciliation" };
  const probe = {
    status: "available",
    adapter: {
      capabilities: {
        automaticReconciliation: true,
        reconciliation: true,
        explicitCoverage: true,
        overflowReporting: true,
        supervisedOverflow: true,
        dynamicExclusions: { supported: true, atomic: true },
      },
    },
  };
  assert.equal(scenarioExclusionReason(plan, probe), null);
  probe.adapter.capabilities.automaticReconciliation = false;
  assert.match(scenarioExclusionReason(plan, probe), /automatic/iu);
});

test("only supervised genuine event-overflow evidence receives loss credit", () => {
  assert.deepEqual(failedCheckNames(completeEvidence()), []);

  const synthetic = completeEvidence({
    lossObservation: {
      uncertainReasons: ["consumer-backpressure"],
      rootBoundaryCount: 1,
      quiesced: true,
    },
  });
  assert.ok(failedCheckNames(synthetic).includes("genuine-event-overflow-observed"));

  const unsupervised = completeEvidence({
    helper: { ...completeEvidence().helper, stopConfirmed: false },
  });
  assert.ok(failedCheckNames(unsupervised).includes("overflow-helper-handshake-ordered"));

  const tooSmall = completeEvidence({
    helper: { ...completeEvidence().helper, generated: 16_384 },
  });
  assert.ok(failedCheckNames(tooSmall).includes("overflow-workload-exceeded-kernel-queue-bound"));
});

test("the uncertain interval must carry explicit successful quiescence evidence", () => {
  const notQuiesced = completeEvidence();
  notQuiesced.intervalMutation.quiesced = false;
  assert.ok(failedCheckNames(notQuiesced).includes("loss-interval-quiesced"));
});

test("recovery evidence enforces the original subscription, stable generations, and one root-only boundary", () => {
  const reconstructed = completeEvidence({
    intervalMutation: {
      startedAfterOverflowObserved: true,
      completedBeforeReconciliation: true,
      guaranteedDetailedReconstruction: true,
      conservativeRootBoundary: true,
      coverageStayedUncertain: true,
      quiesced: true,
    },
  });
  assert.ok(failedCheckNames(reconstructed).includes("loss-interval-not-credited-as-detailed-reconstruction"));

  const replacement = completeEvidence({ finalCoverageReason: "root-replaced" });
  assert.ok(failedCheckNames(replacement).includes("root-replaced-not-credited-as-recovered"));

  const replacedLoss = completeEvidence();
  replacedLoss.lossObservation.uncertainReasons.push("root-replaced");
  assert.ok(failedCheckNames(replacedLoss).includes("root-replaced-not-credited-as-recovered"));

  const mixed = completeEvidence();
  mixed.primaryBatches[2].exclusionGeneration = "2";
  assert.ok(failedCheckNames(mixed).includes("no-primary-batch-crossed-committed-generation"));

  const duplicateRoot = completeEvidence();
  duplicateRoot.recoveryBatches.push({ ...duplicateRoot.recoveryBatches[0], sequence: "9" });
  assert.ok(failedCheckNames(duplicateRoot).includes("one-singleton-root-recovery-boundary"));

  const rebuilt = completeEvidence({
    originalSubscription: {
      publicSubscriptionCreations: 2,
      reconciliationCalls: 1,
      reconciliationCallsOnOriginalSubscription: 0,
      disposalRequests: 1,
    },
  });
  assert.ok(failedCheckNames(rebuilt).includes("reconciliation-used-original-subscription"));

  const changedZero = completeEvidence({
    generationZeroResult: { exclusionGeneration: "1" },
  });
  assert.ok(failedCheckNames(changedZero).includes("generation-zero-remained-zero"));

  const extraPath = completeEvidence();
  extraPath.recoveryBatches[0].paths.push(`${extraPath.root}/not-a-boundary.txt`);
  assert.ok(failedCheckNames(extraPath).includes("one-singleton-root-recovery-boundary"));

  const mismatchedCoverage = completeEvidence();
  mismatchedCoverage.recoveryBatches[0].coverage = {
    state: "partial",
    reason: "resource-limit",
  };
  assert.ok(
    failedCheckNames(mismatchedCoverage)
      .includes("reconciliation-result-matches-root-batch-coverage"),
  );
});

test("sequence, exclusion, peer, sentinel, and joined-cleanup failures are correctness failures", () => {
  const invalid = completeEvidence();
  invalid.primaryBatches[1].sequence = invalid.primaryBatches[0].sequence;
  invalid.excludedPathsObserved = true;
  invalid.peer.deliveredDuringScan = false;
  invalid.postReconciliationSentinelDelivered = false;
  invalid.lifecycle.noCallbackAfterDisposal = false;
  invalid.lifecycle.threadsRestored = false;
  invalid.lifecycle.eventfdsRestored = false;
  invalid.lifecycle.inotifyRestored = false;
  invalid.lifecycle.subscriptionStateReleased = false;
  const failed = failedCheckNames(invalid);
  assert.ok(failed.includes("primary-sequences-strictly-monotonic"));
  assert.ok(failed.includes("current-and-future-excluded-prefixes-stayed-excluded"));
  assert.ok(failed.includes("peer-delivered-during-reconciliation-scan"));
  assert.ok(failed.includes("post-reconciliation-deep-sentinel-delivered"));
  assert.ok(failed.includes("no-callback-started-after-disposal-resolved"));
  assert.ok(failed.includes("final-disposal-joined-native-threads"));
  assert.ok(failed.includes("final-disposal-restored-eventfd-resources"));
  assert.ok(failed.includes("final-disposal-restored-inotify-resources"));
  assert.ok(failed.includes("final-subscription-state-returned-to-baseline"));
});

test("missing counters and untruthful peer coverage cannot pass", () => {
  const missing = completeEvidence();
  missing.primaryBatches[0].sequence = null;
  missing.peer.coverageTruthful = false;
  missing.peer.generationStayedZero = false;
  const failed = failedCheckNames(missing);
  assert.ok(failed.includes("all-primary-batches-have-counters"));
  assert.ok(failed.includes("primary-sequences-strictly-monotonic"));
  assert.ok(failed.includes("peer-delivered-during-reconciliation-scan"));
  assert.ok(failed.includes("peer-generation-stayed-zero"));
});

test("failed and skipped overflow reconciliation evidence stays raw and out of performance samples", () => {
  const trial = (status, outcome) => ({
    status,
    outcome,
    adapterId: "watchbound",
    scenario: "overflow-reconciliation",
    config: { burstCount: 100 },
    adapterLoad: { latencyMs: 1, cpu: { totalMicros: 1 } },
    error: status === "error" ? { code: "WATCHBOUND_BENCH_TIMEOUT" } : undefined,
    reason: status === "skipped" ? "helper unavailable" : undefined,
    result: status === "completed" ? {
      subscription: {
        startupMs: 1,
        cpu: { totalMicros: 1 },
        memoryDelta: {},
        inotifyDelta: { supported: true, instances: 1, watches: 2 },
      },
      observation: {
        callbackCount: 1,
        pathEventCount: 1,
        firstCallbackLatencyMs: 1,
        finalCallbackLatencyMs: 1,
        firstExpectedLatencyMs: outcome === "pass" ? 1 : null,
        allExpectedLatencyMs: outcome === "pass" ? 1 : null,
        missedPathCount: outcome === "pass" ? 0 : 1,
        duplicateExpectedEvents: 0,
        asyncErrors: [],
      },
    } : undefined,
  });
  const raw = [
    trial("completed", "pass"),
    trial("completed", "fail"),
    trial("error", undefined),
    trial("skipped", undefined),
  ];
  const [aggregate] = aggregateResults(raw);
  assert.equal(raw.length, 4);
  assert.equal(aggregate.runs, 2);
  assert.equal(aggregate.performanceRuns, 1);
  assert.equal(aggregate.allCompletedCorrectness.missedPathCount.samples, 2);
});
