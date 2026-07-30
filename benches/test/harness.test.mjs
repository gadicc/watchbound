import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  advertisesReconciliation,
  createAdapterMetadata,
  reconcileExistingSubscription,
} from "../adapters/watchbound.mjs";
import { parseOptions, strictSummaryFailed } from "../lib/cli.mjs";
import {
  aggregateResults,
  isolatedResultAfterExit,
  workspaceSourceIdentity,
} from "../lib/controller.mjs";
import { outcomeFromChecks } from "../lib/outcomes.mjs";
import { createRecorder } from "../lib/recorder.mjs";
import {
  evaluateWatchLimitContract,
  rootReplacementCoveragePreserved,
  scenarioRequirement,
} from "../lib/scenarios.mjs";
import {
  WATCHBOUND_ADAPTER_LABEL,
  WATCHBOUND_BUILD_COMMAND,
  WATCHBOUND_SOURCE_INPUTS,
} from "../lib/watchbound-identity.mjs";

test("informational setup checks do not turn unsupported scenarios into passes", () => {
  assert.equal(
    outcomeFromChecks([
      { name: "setup", passed: true, countsTowardOutcome: false },
      { name: "capability", passed: null, applicable: false },
    ]),
    "observed",
  );
});

test("quick mode rejects an explicitly selected overflow-only suite", () => {
  assert.throws(
    () => parseOptions("conformance", ["--scenario", "queue-overflow", "--quick"]),
    /No scenarios remain/u,
  );
});

test("duplicate adapters and scenarios are rejected", () => {
  assert.throws(
    () => parseOptions("benchmark", ["--adapters", "watchbound,watchbound"]),
    /Duplicate adapter/u,
  );
  assert.throws(
    () => parseOptions("benchmark", ["--scenarios", "burst-files,burst-files"]),
    /Duplicate scenario/u,
  );
});

test("strict summaries fail skips and zero-work reports", () => {
  const base = {
    errors: 0,
    nonconforming: 0,
    skipped: 0,
    cleanupErrors: 0,
    completed: 1,
  };
  assert.equal(strictSummaryFailed(base), false);
  assert.equal(strictSummaryFailed({ ...base, skipped: 1 }), true);
  assert.equal(strictSummaryFailed({ ...base, completed: 0 }), true);
});

test("isolated results are accepted only after a clean child exit", () => {
  const payload = {
    kind: "conformance",
    adapterId: "watchbound",
    scenario: "burst-files",
    run: 1,
  };
  const reported = {
    ...payload,
    status: "completed",
    outcome: "pass",
  };

  assert.equal(
    isolatedResultAfterExit(payload, reported, {
      timeoutMs: 1_000,
      exitCode: 0,
      signal: null,
    }),
    reported,
  );

  const crashed = isolatedResultAfterExit(payload, reported, {
    timeoutMs: 1_000,
    exitCode: 1,
    signal: null,
  });
  assert.equal(crashed.status, "error");
  assert.equal(crashed.error.name, "ChildProcessError");
  assert.match(crashed.error.message, /after reporting a result/u);

  const hung = isolatedResultAfterExit(payload, reported, {
    timeoutMs: 1_000,
    timedOut: true,
    exitCode: null,
    signal: "SIGKILL",
  });
  assert.equal(hung.status, "error");
  assert.equal(hung.error.name, "TimeoutError");
  assert.equal(hung.error.code, "WATCHBOUND_BENCH_TIMEOUT");
});

test("capability-gated contracts cannot pass from diagnostic evidence", () => {
  assert.equal(
    evaluateWatchLimitContract(
      { explicitWatchLimits: true, explicitCoverage: false },
      { state: "partial", reason: "resource-limit" },
    ),
    null,
  );
  assert.equal(
    evaluateWatchLimitContract(
      { explicitWatchLimits: true, explicitCoverage: true },
      { state: "partial", reason: "resource-limit" },
    ),
    true,
  );
  assert.equal(
    rootReplacementCoveragePreserved({
      recoverySucceeded: false,
      structuredCoverageLoss: false,
    }),
    false,
  );
  assert.equal(
    rootReplacementCoveragePreserved({
      recoverySucceeded: true,
      structuredCoverageLoss: false,
    }),
    true,
  );
  assert.equal(scenarioRequirement("bridge-backpressure"), "consumerBackpressure");
});

test("Watchbound advertises reconciliation only for the complete public operation", () => {
  const completeOperation = { reconcile() {} };
  assert.equal(
    advertisesReconciliation({ reconciliation: true }, completeOperation),
    true,
  );
  assert.equal(
    advertisesReconciliation(
      { features: { reconciliation: true } },
      completeOperation,
    ),
    true,
  );
  assert.equal(
    advertisesReconciliation({ reconciliation: false }, completeOperation),
    false,
  );
  assert.equal(advertisesReconciliation({ reconciliation: true }, {}), false);
  assert.equal(
    advertisesReconciliation({ reconciliation: true }, { reconcile: null }),
    false,
  );
});

test("Watchbound evidence identifies the controlled source-build candidate", () => {
  const metadata = createAdapterMetadata(
    {
      capabilities: {
        versions: { engine: "0.1.0" },
        build: {
          nodeApi: 6,
          profile: "release",
          targetTriple: "x86_64-unknown-linux-gnu",
        },
      },
    },
    { path: "/synthetic/watchbound.node", sha256: "a".repeat(64) },
  );

  assert.equal(
    WATCHBOUND_ADAPTER_LABEL,
    "Watchbound controlled source-build candidate",
  );
  assert.equal(metadata.label, WATCHBOUND_ADAPTER_LABEL);
  assert.equal(metadata.build.command, WATCHBOUND_BUILD_COMMAND);
  assert.equal(metadata.build.nativeLibraryOverride, null);
  assert.equal(
    workspaceSourceIdentity().expectedBuildCommand,
    WATCHBOUND_BUILD_COMMAND,
  );
  assert.equal(
    new Set(WATCHBOUND_SOURCE_INPUTS).size,
    WATCHBOUND_SOURCE_INPUTS.length,
  );
  for (const requiredInput of [
    "pnpm-workspace.yaml",
    "node/load-native.cjs",
    "js/capabilities.js",
    "js/errors.js",
    "js/observed-state.js",
    "scripts/build-node.mjs",
  ]) {
    assert.equal(WATCHBOUND_SOURCE_INPUTS.includes(requiredInput), true);
  }
});

test("Watchbound reconciliation calls the existing subscription and normalizes its generation", async () => {
  const calls = [];
  const subscription = {
    async reconcile() {
      calls.push(this);
      return {
        exclusionGeneration: 9n,
        coverage: { state: "complete" },
      };
    },
  };

  assert.deepEqual(await reconcileExistingSubscription(subscription), {
    exclusionGeneration: "9",
    coverage: { state: "complete" },
  });
  assert.deepEqual(calls, [subscription]);
  await assert.rejects(
    reconcileExistingSubscription({}),
    /does not expose reconciliation/u,
  );
});

test("performance aggregates use passing trials while retaining all correctness samples", () => {
  const observation = (missedPathCount, latency) => ({
    callbackCount: 1,
    pathEventCount: 1,
    firstCallbackLatencyMs: latency,
    finalCallbackLatencyMs: latency,
    firstExpectedLatencyMs: latency,
    allExpectedLatencyMs: missedPathCount === 0 ? latency : null,
    missedPathCount,
    duplicateExpectedEvents: 0,
    asyncErrors: [],
  });
  const trial = (outcome, startupMs, missedPathCount) => ({
    status: "completed",
    outcome,
    adapterId: "watchbound",
    scenario: "burst-files",
    config: { burstCount: 10 },
    adapterLoad: { latencyMs: startupMs, cpu: { totalMicros: startupMs } },
    result: {
      subscription: {
        startupMs,
        cpu: { totalMicros: startupMs },
        memoryDelta: {},
        inotifyDelta: { supported: true, instances: 1, watches: 2 },
      },
      observation: observation(missedPathCount, startupMs),
      mutationDurationMs: startupMs,
    },
  });
  const [aggregate] = aggregateResults([
    trial("pass", 10, 0),
    trial("fail", 1, 4),
  ]);
  assert.equal(aggregate.runs, 2);
  assert.equal(aggregate.performanceRuns, 1);
  assert.equal(aggregate.startupMs.median, 10);
  assert.equal(aggregate.allCompletedCorrectness.missedPathCount.samples, 2);
});

test("recorder reports first-seen completion instead of the last duplicate", async () => {
  const recorder = createRecorder("/tmp/watchbound-recorder-test");
  const checkpoint = recorder.checkpoint();
  recorder.onBatch({ paths: ["first"] });
  await delay(5);
  recorder.onBatch({ paths: ["second"] });
  await delay(10);
  recorder.onBatch({ paths: ["first"] });
  const summary = recorder.summary(checkpoint, ["first", "second"]);
  assert.equal(summary.missedPathCount, 0);
  assert.equal(summary.finalExpectedLatencyMs, summary.allExpectedLatencyMs);
  assert.ok(summary.lastExpectedCallbackLatencyMs > summary.allExpectedLatencyMs);
});

test("recorder retains ordered reconciliation batch evidence with JSON-safe counters", () => {
  const recorder = createRecorder("/tmp/watchbound-recorder-reconciliation");
  recorder.onBatch({
    sequence: 4n,
    exclusionGeneration: 2n,
    paths: ["before"],
    coverage: { state: "uncertain", reason: "consumer-backpressure" },
  });
  const checkpoint = recorder.checkpoint();
  recorder.onBatch({
    sequence: 5n,
    exclusionGeneration: 2n,
    paths: ["/tmp/watchbound-recorder-reconciliation"],
    coverage: { state: "complete" },
  });
  recorder.onBatch({
    sequence: 6n,
    exclusionGeneration: 2n,
    paths: ["after"],
    coverage: { state: "complete" },
  });

  const summary = recorder.summary(checkpoint);
  assert.deepEqual(summary.sequences, ["5", "6"]);
  assert.deepEqual(summary.exclusionGenerations, ["2"]);
  assert.equal(summary.allSequencesPresent, true);
  assert.equal(summary.sequencesStrictlyMonotonic, true);
  assert.equal(summary.allExclusionGenerationsPresent, true);
  assert.equal(summary.rootBoundaryCount, 1);
  const evidence = recorder.batchesSince(checkpoint);
  assert.deepEqual(summary.rootBoundaries, [{
    atMs: evidence[0].atMs,
    sequence: "5",
    exclusionGeneration: "2",
    coverage: { state: "complete" },
  }]);
  assert.deepEqual(
    evidence.map((batch) => batch.paths),
    [
      ["/tmp/watchbound-recorder-reconciliation"],
      ["/tmp/watchbound-recorder-reconciliation/after"],
    ],
  );
  assert.doesNotThrow(() => JSON.stringify(summary));
});

test("recorder reports missing and non-monotonic public batch counters", () => {
  const recorder = createRecorder("/tmp/watchbound-recorder-order");
  const checkpoint = recorder.checkpoint();
  recorder.onBatch({ sequence: 3n, exclusionGeneration: 0n, paths: ["one"] });
  recorder.onBatch({ sequence: 3n, paths: ["two"] });
  const summary = recorder.summary(checkpoint);
  assert.equal(summary.allSequencesPresent, true);
  assert.equal(summary.sequencesStrictlyMonotonic, false);
  assert.equal(summary.allExclusionGenerationsPresent, false);
});
