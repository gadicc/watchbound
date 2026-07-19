import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { parseOptions, strictSummaryFailed } from "../lib/cli.mjs";
import { aggregateResults } from "../lib/controller.mjs";
import { outcomeFromChecks } from "../lib/outcomes.mjs";
import { createRecorder } from "../lib/recorder.mjs";
import {
  evaluateWatchLimitContract,
  rootReplacementCoveragePreserved,
  scenarioRequirement,
} from "../lib/scenarios.mjs";

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
