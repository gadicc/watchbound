import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createEngine } from "../js/index.js";

const CYCLE_COUNT = 5;
const HARD_DEADLINE_MS = 60_000;
const WAIT_TIMEOUT_MS = 4_000;
const POLL_INTERVAL_MS = 10;
const POST_DISPOSAL_QUIET_MS = 50;
const NATIVE_WATCH_BUDGET = 3;
const PRESSURE_PATH_COUNT = 24;
const MAX_BATCH_PATHS = 8;
const FD_TOLERANCE = 2;
const TASK_TOLERANCE = 1;
const COLD_TASK_WARMUP_TOLERANCE = 4;

const inactiveRuntime = Object.freeze({
  active: false,
  inotifyInstances: 0,
  workerThreads: 0,
  nativeWatches: 0,
  nativeWatchBudget: null,
  deferredInterests: 0,
  subscriptions: 0,
});

let emergencyRoot;
const soakStartedAt = Date.now();
const watchdog = setTimeout(() => {
  if (emergencyRoot !== undefined) {
    try {
      fs.rmSync(emergencyRoot, { recursive: true, force: true });
    } catch {
      // The process is about to exit; the path is included in the diagnostic.
    }
  }
  process.stderr.write(
    `[maintenance-soak] hard deadline of ${HARD_DEADLINE_MS} ms exceeded` +
      `${emergencyRoot === undefined ? "" : `; cleanup root: ${emergencyRoot}`}\n`,
  );
  process.exit(1);
}, HARD_DEADLINE_MS);

try {
  const summary = await runSoak();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} catch (error) {
  process.stderr.write(
    `[maintenance-soak] failed: ${error?.stack ?? String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
}

async function runSoak() {
  const engine = createEngine({ nativeWatchBudget: NATIVE_WATCH_BUDGET });
  assert.deepEqual(
    engine.runtimeStats(),
    inactiveRuntime,
    "resource-free engine did not begin at the inactive runtime baseline",
  );

  const procBaseline = readProcResources();
  let steadyProcBaseline = null;
  const cycleDurationsMs = [];
  let maximumFileDescriptors = procBaseline?.fileDescriptors ?? null;
  let maximumTasks = procBaseline?.tasks ?? null;

  for (let cycle = 1; cycle <= CYCLE_COUNT; cycle += 1) {
    const cycleStartedAt = Date.now();
    await runCycle(engine, cycle);
    await delay(POLL_INTERVAL_MS);

    assert.deepEqual(
      engine.runtimeStats(),
      inactiveRuntime,
      `cycle ${cycle}: joined disposal did not restore the inactive runtime baseline`,
    );
    const resources = assertProcResourcesNearBaseline(
      steadyProcBaseline ?? procBaseline,
      cycle,
      steadyProcBaseline === null ? COLD_TASK_WARMUP_TOLERANCE : TASK_TOLERANCE,
    );
    if (cycle === 1 && resources !== null) steadyProcBaseline = resources;
    if (resources !== null) {
      maximumFileDescriptors = Math.max(
        maximumFileDescriptors,
        resources.fileDescriptors,
      );
      maximumTasks = Math.max(maximumTasks, resources.tasks);
    }

    const durationMs = Date.now() - cycleStartedAt;
    cycleDurationsMs.push(durationMs);
    process.stdout.write(
      `[maintenance-soak] cycle ${cycle}/${CYCLE_COUNT} passed ` +
        `(${durationMs} ms, fd=${resources?.fileDescriptors ?? "unavailable"}, ` +
        `tasks=${resources?.tasks ?? "unavailable"})\n`,
    );
  }

  assert.deepEqual(
    engine.runtimeStats(),
    inactiveRuntime,
    "final joined disposal did not restore the inactive runtime baseline",
  );
  const finalResources = assertProcResourcesNearBaseline(
    steadyProcBaseline ?? procBaseline,
    "final",
    TASK_TOLERANCE,
  );

  return {
    kind: "watchbound-maintenance-soak",
    benchmark: false,
    cycles: CYCLE_COUNT,
    hardDeadlineMs: HARD_DEADLINE_MS,
    durationMs: Date.now() - soakStartedAt,
    cycleDurationsMs,
    ordinaryPressurePathsPerCycle: PRESSURE_PATH_COUNT,
    proc: procBaseline === null
      ? { available: false }
      : {
          available: true,
          coldBaseline: procBaseline,
          steadyBaseline: steadyProcBaseline,
          final: finalResources,
          maximum: {
            fileDescriptors: maximumFileDescriptors,
            tasks: maximumTasks,
          },
          tolerance: {
            fileDescriptors: FD_TOLERANCE,
            tasks: TASK_TOLERANCE,
            coldTaskWarmup: COLD_TASK_WARMUP_TOLERANCE,
          },
        },
  };
}

async function runCycle(engine, cycle) {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), `watchbound-maintenance-soak-${cycle}-`),
  );
  emergencyRoot = parent;
  const holderRoot = path.join(parent, "holder");
  const heldDirectory = path.join(holderRoot, "held");
  const targetRoot = path.join(parent, "target");
  const hiddenDirectory = path.join(targetRoot, "hidden");
  const hiddenNested = path.join(hiddenDirectory, "nested");
  const incomingTree = path.join(parent, "incoming-tree");
  const incomingNested = path.join(incomingTree, "nested");
  fs.mkdirSync(heldDirectory, { recursive: true });
  fs.mkdirSync(hiddenNested, { recursive: true });
  fs.mkdirSync(incomingNested, { recursive: true });
  fs.writeFileSync(path.join(incomingNested, "present-before-move.txt"), "present\n");

  let holder;
  let target;
  try {
    holder = await engine.subscribe(holderRoot, () => {}, subscriptionOptions());
    assert.deepEqual(holder.initialCoverage, { state: "complete" });

    const batches = [];
    const callbackTrigger = path.join(targetRoot, "callback-throws-once.txt");
    let callbackThrew = false;
    target = await engine.subscribe(
      targetRoot,
      (batch) => {
        batches.push(batch);
        if (!callbackThrew && batch.invalidatedPaths.includes(callbackTrigger)) {
          callbackThrew = true;
          throw new Error(`cycle ${cycle}: intentional maintenance-soak callback exception`);
        }
      },
      subscriptionOptions(),
    );

    assert.deepEqual(target.initialCoverage, {
      state: "partial",
      reason: "resource-limit",
      watchedDirectories: 1,
      deferredDirectories: 2,
    });
    assertRuntimeBounded(engine, cycle, {
      nativeWatches: NATIVE_WATCH_BUDGET,
      deferredInterests: 2,
      subscriptions: 2,
    });

    const excluded = await target.replaceExclusions(1n, ["hidden"]);
    assert.deepEqual(excluded, { state: "complete" });
    assert.deepEqual(
      pickCoverageStats(target.stats()),
      { watchedDirectories: 1, deferredDirectories: 0 },
    );

    const reincludedBatchIndex = batches.length;
    const reincluded = await target.replaceExclusions(2n, []);
    assert.deepEqual(reincluded, {
      state: "partial",
      reason: "resource-limit",
      watchedDirectories: 1,
      deferredDirectories: 1,
    });
    await waitFor(
      () => batches.slice(reincludedBatchIndex).some((batch) =>
        batch.exclusionGeneration === 2n &&
        batch.invalidatedPaths.includes(hiddenDirectory)),
      `cycle ${cycle}: reinclusion did not publish its hidden-subtree boundary`,
      () => ({ batches: batches.length, stats: target.stats() }),
    );

    fs.rmSync(heldDirectory, { recursive: true });
    await waitFor(
      () => {
        const stats = target.stats();
        return stats.watchedDirectories === 2 && stats.deferredDirectories === 1;
      },
      `cycle ${cycle}: deleting watched topology did not promote one deferred watch`,
      () => target.stats(),
    );

    await disposeIdempotently(holder, `cycle ${cycle}: holder`);
    await waitFor(
      () => {
        const stats = target.stats();
        return stats.watchedDirectories === 3 && stats.deferredDirectories === 0;
      },
      `cycle ${cycle}: holder disposal did not complete deferred promotion`,
      () => ({ runtime: engine.runtimeStats(), target: target.stats() }),
    );
    assertRuntimeBounded(engine, cycle, {
      nativeWatches: NATIVE_WATCH_BUDGET,
      deferredInterests: 0,
      subscriptions: 1,
    });

    fs.writeFileSync(callbackTrigger, "throw once\n");
    await waitFor(
      () => callbackThrew && target.stats().callbackErrors === 1n,
      `cycle ${cycle}: intentional callback exception was not accounted`,
      () => ({ callbackThrew, stats: target.stats() }),
    );
    const continuedPath = path.join(hiddenNested, "continued-after-callback-error.txt");
    const continuedBatchIndex = batches.length;
    fs.writeFileSync(continuedPath, "continued\n");
    await waitForPath(
      batches,
      continuedBatchIndex,
      continuedPath,
      `cycle ${cycle}: delivery stopped after the callback exception`,
    );

    fs.rmSync(hiddenDirectory, { recursive: true });
    await waitFor(
      () => target.stats().watchedDirectories === 1,
      `cycle ${cycle}: deleting a watched subtree did not return its watches`,
      () => target.stats(),
    );

    const movedTree = path.join(targetRoot, "moved-tree");
    const movedBatchIndex = batches.length;
    fs.renameSync(incomingTree, movedTree);
    await waitFor(
      () => target.stats().watchedDirectories === 3,
      `cycle ${cycle}: moved-in nested topology was not watched`,
      () => target.stats(),
    );
    await waitForPath(
      batches,
      movedBatchIndex,
      movedTree,
      `cycle ${cycle}: moved-in topology was not invalidated`,
    );
    const movedSentinel = path.join(movedTree, "nested", "after-move.txt");
    const movedSentinelBatchIndex = batches.length;
    fs.writeFileSync(movedSentinel, "moved\n");
    await waitForPath(
      batches,
      movedSentinelBatchIndex,
      movedSentinel,
      `cycle ${cycle}: moved-in nested sentinel was not delivered`,
    );

    const renamedTree = path.join(targetRoot, "renamed-tree");
    const renameBatchIndex = batches.length;
    fs.renameSync(movedTree, renamedTree);
    await waitFor(
      () => batches.slice(renameBatchIndex).some((batch) =>
        batch.invalidatedPaths.includes(movedTree) ||
        batch.invalidatedPaths.includes(renamedTree)),
      `cycle ${cycle}: in-root rename was not invalidated`,
      () => ({ batches: batches.length, stats: target.stats() }),
    );
    const renamedSentinel = path.join(renamedTree, "nested", "after-rename.txt");
    const renamedSentinelBatchIndex = batches.length;
    fs.writeFileSync(renamedSentinel, "renamed\n");
    await waitForPath(
      batches,
      renamedSentinelBatchIndex,
      renamedSentinel,
      `cycle ${cycle}: delivery did not follow the renamed topology`,
    );

    const pressureBatchIndex = batches.length;
    const pressurePaths = Array.from({ length: PRESSURE_PATH_COUNT }, (_, index) =>
      path.join(targetRoot, `ordinary-pressure-${String(index).padStart(2, "0")}.txt`));
    for (const pressurePath of pressurePaths) {
      fs.writeFileSync(pressurePath, `cycle ${cycle}\n`);
    }
    await waitFor(
      () => {
        const delivered = new Set(
          batches.slice(pressureBatchIndex).flatMap((batch) => batch.invalidatedPaths),
        );
        return pressurePaths.every((pressurePath) => delivered.has(pressurePath));
      },
      `cycle ${cycle}: ordinary bounded path pressure was not fully delivered`,
      () => ({
        delivered: new Set(
          batches.slice(pressureBatchIndex).flatMap((batch) => batch.invalidatedPaths),
        ).size,
        batches: batches.length - pressureBatchIndex,
        stats: target.stats(),
      }),
    );

    const reconciliationBatchIndex = batches.length;
    const reconciliation = await target.reconcile();
    assert.deepEqual(reconciliation, {
      exclusionGeneration: 2n,
      coverage: { state: "complete" },
    });
    await waitFor(
      () => batches.slice(reconciliationBatchIndex).some((batch) =>
        batch.exclusionGeneration === reconciliation.exclusionGeneration &&
        batch.invalidatedPaths.length === 1 &&
        batch.invalidatedPaths[0] === targetRoot &&
        batch.coverage.state === "complete"),
      `cycle ${cycle}: reconciliation did not publish its complete root boundary`,
      () => ({
        batches: batches.length - reconciliationBatchIndex,
        reconciliation,
        stats: target.stats(),
      }),
    );

    fs.rmSync(renamedTree, { recursive: true });
    await waitFor(
      () => target.stats().watchedDirectories === 1,
      `cycle ${cycle}: renamed-tree deletion did not release native watches`,
      () => target.stats(),
    );

    const statsBeforeDisposal = target.stats();
    assert.equal(statsBeforeDisposal.callbackErrors, 1n);
    assert.equal(statsBeforeDisposal.batchesDropped, 0n);
    assert.equal(statsBeforeDisposal.overflowEvents, 0n);
    assert.ok(statsBeforeDisposal.batchesDelivered > 0n);
    assertBatchesRemainBoundedAndCertain(batches, cycle);

    await disposeIdempotently(target, `cycle ${cycle}: target`);
    assert.deepEqual(pickCoverageStats(target.stats()), {
      watchedDirectories: 0,
      deferredDirectories: 0,
    });
    assert.equal(target.stats().disposed, true);
    const callbackCountAfterDisposal = batches.length;
    fs.writeFileSync(path.join(targetRoot, "after-joined-disposal.txt"), "after\n");
    await delay(POST_DISPOSAL_QUIET_MS);
    assert.equal(
      batches.length,
      callbackCountAfterDisposal,
      `cycle ${cycle}: callback entered after the disposal promise resolved`,
    );
  } finally {
    await Promise.allSettled([holder?.dispose(), target?.dispose()]);
    fs.rmSync(parent, { recursive: true, force: true });
    emergencyRoot = undefined;
  }
}

function subscriptionOptions() {
  return {
    batchWindowMs: 10,
    maxBatchPaths: MAX_BATCH_PATHS,
    outputQueueCapacity: 32,
  };
}

async function disposeIdempotently(subscription, label) {
  const first = subscription.dispose();
  const second = subscription.dispose();
  await Promise.all([first, second]);
  await subscription.dispose();
  assert.equal(subscription.stats().disposed, true, `${label}: disposal did not join`);
}

function assertRuntimeBounded(engine, cycle, expected) {
  const runtime = engine.runtimeStats();
  assert.equal(runtime.active, true, `cycle ${cycle}: runtime is unexpectedly inactive`);
  assert.equal(runtime.inotifyInstances, 1, `cycle ${cycle}: expected one inotify instance`);
  assert.equal(runtime.workerThreads, 1, `cycle ${cycle}: expected one worker thread`);
  assert.equal(runtime.nativeWatchBudget, NATIVE_WATCH_BUDGET);
  assert.ok(
    runtime.nativeWatches <= NATIVE_WATCH_BUDGET,
    `cycle ${cycle}: runtime exceeded native-watch budget: ${JSON.stringify(runtime)}`,
  );
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(runtime[key], value, `cycle ${cycle}: unexpected runtime ${key}`);
  }
}

function assertBatchesRemainBoundedAndCertain(batches, cycle) {
  assert.ok(batches.length > 0, `cycle ${cycle}: no callbacks entered`);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    assert.ok(
      batch.invalidatedPathBytes.length <= MAX_BATCH_PATHS,
      `cycle ${cycle}: batch ${index} exceeded maxBatchPaths`,
    );
    assert.notEqual(
      batch.coverage.state,
      "uncertain",
      `cycle ${cycle}: unexpected uncertainty in ordinary soak batch ${index}: ` +
        JSON.stringify(batch.coverage),
    );
    if (index > 0) {
      assert.ok(
        batch.sequence > batches[index - 1].sequence,
        `cycle ${cycle}: callback sequences were not strictly increasing`,
      );
    }
  }
}

async function waitForPath(batches, startIndex, expectedPath, message) {
  await waitFor(
    () => batches.slice(startIndex).some((batch) =>
      batch.invalidatedPaths.includes(expectedPath)),
    message,
    () => ({ expectedPath, batches: batches.length - startIndex }),
  );
}

async function waitFor(predicate, message, diagnostic) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!predicate() && Date.now() < deadline) await delay(POLL_INTERVAL_MS);
  assert.ok(
    predicate(),
    `${message}; diagnostic=${formatDiagnostic(diagnostic())}`,
  );
}

function pickCoverageStats(stats) {
  return {
    watchedDirectories: stats.watchedDirectories,
    deferredDirectories: stats.deferredDirectories,
  };
}

function readProcResources() {
  try {
    return {
      fileDescriptors: fs.readdirSync("/proc/self/fd").length,
      tasks: fs.readdirSync("/proc/self/task").length,
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES") return null;
    throw error;
  }
}

function assertProcResourcesNearBaseline(baseline, cycle, taskTolerance) {
  if (baseline === null) return null;
  const current = readProcResources();
  assert.ok(
    current.fileDescriptors <= baseline.fileDescriptors + FD_TOLERANCE,
    `${cycleLabel(cycle)}: file descriptors did not return near baseline ` +
      `(baseline=${baseline.fileDescriptors}, current=${current.fileDescriptors}, ` +
      `tolerance=${FD_TOLERANCE})`,
  );
  assert.ok(
    current.tasks <= baseline.tasks + taskTolerance,
    `${cycleLabel(cycle)}: process tasks did not return near baseline ` +
      `(baseline=${baseline.tasks}, current=${current.tasks}, ` +
      `tolerance=${taskTolerance})`,
  );
  return current;
}

function cycleLabel(cycle) {
  return cycle === "final" ? "final resource check" : `cycle ${cycle}`;
}

function formatDiagnostic(value) {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === "bigint" ? `${nested}n` : nested);
}
