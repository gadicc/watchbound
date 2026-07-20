import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { parseOptions } from "../lib/cli.mjs";
import {
  aggregateResults,
  scenarioExclusionReason,
} from "../lib/controller.mjs";
import {
  prepareScenario,
  scenarioNames,
  scenarioRequirement,
} from "../lib/scenarios.mjs";

test("reconciliation is a quick conformance scenario with an explicit requirement", () => {
  assert.ok(scenarioNames.includes("reconciliation"));
  assert.equal(scenarioRequirement("reconciliation"), "reconciliation");
  const options = parseOptions("conformance", [
    "--adapter",
    "watchbound",
    "--scenario",
    "reconciliation",
    "--quick",
  ]);
  assert.deepEqual(options.scenarios, ["reconciliation"]);
  assert.equal(options.runs, 1);
  assert.equal(options.burstCount, 100);
});

test("automatic reconciliation is a separate quick conformance requirement", () => {
  assert.ok(scenarioNames.includes("automatic-reconciliation"));
  assert.equal(
    scenarioRequirement("automatic-reconciliation"),
    "automaticReconciliation",
  );
  const options = parseOptions("conformance", [
    "--adapter",
    "watchbound",
    "--scenario",
    "automatic-reconciliation",
    "--quick",
  ]);
  assert.deepEqual(options.scenarios, ["automatic-reconciliation"]);
});

test("reconciliation topology preparation stays modest and separates peer coverage", () => {
  const runDirectory = `/tmp/watchbound-reconciliation-prepare-${process.pid}-${Date.now()}`;
  try {
    const prepared = prepareScenario(
      "reconciliation",
      { burstCount: 100 },
      runDirectory,
    );
    assert.notEqual(prepared.root, prepared.peerRoot);
    assert.ok(prepared.pressureTargets.length >= 64);
    assert.ok(prepared.pressureTargets.length <= 256);
    assert.ok(prepared.scanDirectories.length >= 32);
    assert.ok(prepared.scanDirectories.length <= 256);
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("unsupported reconciliation adapters are excluded with a reason", () => {
  const plan = { scenario: "reconciliation" };
  const unsupported = {
    status: "available",
    adapter: {
      capabilities: {
        reconciliation: false,
        explicitCoverage: true,
        consumerBackpressureReporting: true,
        dynamicExclusions: { supported: true, atomic: true },
      },
    },
  };
  assert.match(scenarioExclusionReason(plan, unsupported), /reconciliation/iu);

  const supported = structuredClone(unsupported);
  supported.adapter.capabilities.reconciliation = true;
  assert.equal(scenarioExclusionReason(plan, supported), null);
});

test("automatic reconciliation requires the opt-in wrapper policy capability", () => {
  const plan = { scenario: "automatic-reconciliation" };
  const probe = {
    status: "available",
    adapter: {
      capabilities: {
        automaticReconciliation: false,
        reconciliation: true,
        explicitCoverage: true,
        consumerBackpressureReporting: true,
        dynamicExclusions: { supported: true, atomic: true },
      },
    },
  };
  assert.match(scenarioExclusionReason(plan, probe), /automatic/iu);
  probe.adapter.capabilities.automaticReconciliation = true;
  assert.equal(scenarioExclusionReason(plan, probe), null);
});

test("failed reconciliation repetitions retain correctness but add no performance samples", () => {
  const trial = (outcome, sequenceMonotonic) => ({
    status: "completed",
    outcome,
    adapterId: "watchbound",
    scenario: "reconciliation",
    config: { burstCount: 100 },
    adapterLoad: { latencyMs: 1, cpu: { totalMicros: 1 } },
    result: {
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
        firstExpectedLatencyMs: 1,
        allExpectedLatencyMs: sequenceMonotonic ? 1 : null,
        missedPathCount: sequenceMonotonic ? 0 : 1,
        duplicateExpectedEvents: 0,
        asyncErrors: [],
        sequenceMonotonic,
      },
    },
  });
  const [aggregate] = aggregateResults([
    trial("pass", true),
    trial("fail", false),
  ]);
  assert.equal(aggregate.runs, 2);
  assert.equal(aggregate.passed, 1);
  assert.equal(aggregate.failed, 1);
  assert.equal(aggregate.performanceRuns, 1);
  assert.equal(aggregate.allCompletedCorrectness.missedPathCount.samples, 2);
});

test("failed automatic recovery is correctness evidence and not a performance sample", () => {
  const failed = {
    status: "completed",
    outcome: "fail",
    adapterId: "watchbound",
    scenario: "automatic-reconciliation",
    config: { burstCount: 100 },
    adapterLoad: { latencyMs: 2, cpu: { totalMicros: 3 } },
    result: {
      subscription: {
        startupMs: 1,
        cpu: { totalMicros: 1 },
        memoryDelta: {},
        inotifyDelta: { supported: true, instances: 1, watches: 2 },
      },
      automaticReconciliation: {
        beforeDisposal: {
          state: "exhausted",
          reason: "consumer-backpressure",
          attempts: 3,
          error: "topology transaction is busy",
        },
      },
      observation: {
        callbackCount: 1,
        pathEventCount: 1,
        missedPathCount: 1,
        duplicateExpectedEvents: 0,
        asyncErrors: [],
      },
    },
  };
  const [aggregate] = aggregateResults([failed]);
  assert.equal(aggregate.runs, 1);
  assert.equal(aggregate.failed, 1);
  assert.equal(aggregate.performanceRuns, 0);
  assert.equal(aggregate.startupMs, null);
  assert.equal(aggregate.allCompletedCorrectness.missedPathCount.samples, 1);
});
