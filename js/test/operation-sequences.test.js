import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { createEngine } from "../index.js";

const SEEDS = [0x1357_9bdf, 0x2468_ace0, 0x5eed_c0de, 0xc001_d00d];
const STEPS_PER_SEED = 32;
const MAX_BATCH_PATHS = 8;
const WAIT_TIMEOUT_MS = 4_000;
const EXCLUSION_SETS = Object.freeze([
  Object.freeze([]),
  Object.freeze(["lane-0"]),
  Object.freeze(["lane-1/deep"]),
  Object.freeze(["lane-2"]),
  Object.freeze(["lane-0", "lane-2/deep"]),
]);

test("seeded operation sequences preserve truthful coverage, generations, and teardown", {
  timeout: 60_000,
}, async () => {
  const engine = createEngine();

  for (const seed of SEEDS) {
    await runSeed(engine, seed);
    assert.deepEqual(
      engine.runtimeStats(),
      inactiveRuntimeStats(),
      `seed ${formatSeed(seed)} left the shared runtime active`,
    );
  }
});

async function runSeed(engine, seed) {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), `watchbound-operation-sequence-${formatSeed(seed)}-`),
  );
  const root = path.join(parent, "root");
  const staging = path.join(parent, "staging");
  fs.mkdirSync(staging);
  for (let lane = 0; lane < 3; lane += 1) {
    fs.mkdirSync(path.join(root, `lane-${lane}`, "deep"), { recursive: true });
  }

  const random = xorshift32(seed);
  let exclusions = [...EXCLUSION_SETS[random(EXCLUSION_SETS.length)]];
  let generation = 0n;
  const exclusionsByGeneration = new Map([[generation, exclusions]]);
  const batches = [];
  const callbackFailures = [];
  let callbacksInFlight = 0;
  let maximumCallbacksInFlight = 0;
  let lastSequence = 0n;
  let lastDeliveredExclusionGeneration = 0n;
  let initialRootState = null;
  let subscription;

  try {
    subscription = await engine.subscribe(
      root,
      async (batch) => {
        callbacksInFlight += 1;
        const liveExclusionGenerationAtEntry =
          subscription?.exclusionGeneration ?? null;
        const liveRootStateAtEntry = subscription?.rootState ?? null;
        maximumCallbacksInFlight = Math.max(
          maximumCallbacksInFlight,
          callbacksInFlight,
        );
        try {
          await delay(Number(batch.sequence % 3n));
          assert.ok(
            batch.sequence > lastSequence,
            diagnostic(seed, "callback sequence did not increase", {
              sequence: batch.sequence,
              lastSequence,
            }),
          );
          lastSequence = batch.sequence;
          assert.notEqual(
            liveExclusionGenerationAtEntry,
            null,
            diagnostic(
              seed,
              "callback entered before live generation was available",
              {
                sequence: batch.sequence,
                batchGeneration: batch.exclusionGeneration,
              },
            ),
          );
          assert.ok(
            batch.exclusionGeneration >= lastDeliveredExclusionGeneration,
            diagnostic(seed, "delivered exclusion generation decreased", {
              sequence: batch.sequence,
              generation: batch.exclusionGeneration,
              lastDeliveredExclusionGeneration,
            }),
          );
          assert.ok(
            batch.exclusionGeneration <= liveExclusionGenerationAtEntry,
            diagnostic(
              seed,
              "batch exceeded the live committed generation at callback entry",
              {
                sequence: batch.sequence,
                generation: batch.exclusionGeneration,
                liveExclusionGenerationAtEntry,
              },
            ),
          );
          assert.notEqual(
            initialRootState,
            null,
            diagnostic(seed, "callback entered before initial root state was available", {
              sequence: batch.sequence,
            }),
          );
          assert.notEqual(
            liveRootStateAtEntry,
            null,
            diagnostic(seed, "callback entered before live root state was available", {
              sequence: batch.sequence,
            }),
          );
          assertStableRootState(
            batch.rootState,
            initialRootState,
            seed,
            "batch",
            batch.sequence,
          );
          assertStableRootState(
            liveRootStateAtEntry,
            initialRootState,
            seed,
            "live getter at callback entry",
            batch.sequence,
          );
          validateBatch(root, batch, exclusionsByGeneration, seed);
          lastDeliveredExclusionGeneration = batch.exclusionGeneration;
          batches.push(batch);
        } catch (error) {
          callbackFailures.push(error);
        } finally {
          callbacksInFlight -= 1;
        }
      },
      {
        initialExclusions: exclusions,
        batchWindowMs: 5,
        maxBatchPaths: MAX_BATCH_PATHS,
        outputQueueCapacity: 128,
      },
    );

    assert.deepEqual(subscription.initialCoverage, { state: "complete" });
    initialRootState = subscription.initialRootState;
    assert.equal(initialRootState.generation, 0n);
    assert.equal(initialRootState.attachment, "attached");
    assert.equal(subscription.exclusionGeneration, generation);
    assertExactWatchAccounting(
      engine,
      subscription,
      root,
      exclusions,
      seed,
      "initial",
    );

    for (let step = 0; step < STEPS_PER_SEED; step += 1) {
      if (step % 4 === 0 || random(7) === 0) {
        generation += 1n;
        exclusions = [...EXCLUSION_SETS[random(EXCLUSION_SETS.length)]];
        exclusionsByGeneration.set(generation, exclusions);
        const coverage = await subscription.replaceExclusions(
          generation,
          exclusions,
        );
        assert.deepEqual(
          coverage,
          { state: "complete" },
          diagnostic(seed, "exclusion replacement lost complete coverage", {
            step,
            generation,
            exclusions,
            coverage,
          }),
        );
      }

      const ordinaryBatchIndex = batches.length;
      const ordinaryTarget = deliverGuaranteedIncludedMutation({
        root,
        staging,
        seed,
        step,
      });
      await waitFor(
        () => batches.slice(ordinaryBatchIndex).some((batch) =>
          batch.invalidatedPaths.includes(ordinaryTarget)),
        diagnostic(
          seed,
          "included mutation did not enter JavaScript before reconciliation",
          {
            step,
            generation,
            ordinaryTarget,
            batches: batches.length - ordinaryBatchIndex,
            callbackFailures,
          },
        ),
      );
      const ordinaryBatch = batches.slice(ordinaryBatchIndex).find((batch) =>
        batch.invalidatedPaths.includes(ordinaryTarget));
      assert.ok(ordinaryBatch);
      assert.deepEqual(callbackFailures, []);

      mutateTopology({ root, staging, seed, step, random });
      const batchIndex = batches.length;
      const reconciliation = await subscription.reconcile();
      assert.deepEqual(
        reconciliation,
        {
          exclusionGeneration: generation,
          coverage: { state: "complete" },
        },
        diagnostic(seed, "reconciliation changed the model state", {
          step,
          generation,
          exclusions,
          reconciliation,
        }),
      );
      await waitFor(
        () => batches.slice(batchIndex).some((batch) =>
          batch.exclusionGeneration === generation &&
          batch.invalidatedPaths.length === 1 &&
          batch.invalidatedPaths[0] === root &&
          batch.coverage.state === "complete"),
        diagnostic(seed, "reconciliation boundary did not enter JavaScript", {
          step,
          generation,
          exclusions,
          batches: batches.length - batchIndex,
          callbackFailures,
        }),
      );
      const reconciliationBatch = batches.slice(batchIndex).find((batch) =>
        batch.exclusionGeneration === generation &&
        batch.invalidatedPaths.length === 1 &&
        batch.invalidatedPaths[0] === root &&
        batch.coverage.state === "complete");
      assert.ok(
        reconciliationBatch.sequence > ordinaryBatch.sequence,
        diagnostic(seed, "ordinary mutation was not distinct from reconciliation", {
          step,
          ordinarySequence: ordinaryBatch.sequence,
          reconciliationSequence: reconciliationBatch.sequence,
        }),
      );
      assert.deepEqual(callbackFailures, []);
      assertExactWatchAccounting(
        engine,
        subscription,
        root,
        exclusions,
        seed,
        `step ${step}`,
      );
    }

    await Promise.all([subscription.dispose(), subscription.dispose()]);
    await subscription.dispose();
    assert.equal(subscription.stats().disposed, true);
    assert.equal(maximumCallbacksInFlight, 1);
    assert.deepEqual(callbackFailures, []);
    assert.equal(callbacksInFlight, 0);
    const callbackCountAfterDisposal = batches.length;
    fs.writeFileSync(path.join(root, "after-disposal.txt"), "after\n");
    await delay(25);
    assert.equal(
      batches.length,
      callbackCountAfterDisposal,
      diagnostic(seed, "callback entered after joined disposal", {
        before: callbackCountAfterDisposal,
        after: batches.length,
      }),
    );
  } finally {
    await subscription?.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function deliverGuaranteedIncludedMutation({ root, staging, seed, step }) {
  const filename =
    `included-${formatSeed(seed)}-${String(step).padStart(2, "0")}.txt`;
  const prepared = path.join(staging, filename);
  const target = path.join(root, filename);
  fs.writeFileSync(prepared, `${seed}:${step}\n`);
  fs.renameSync(prepared, target);
  return target;
}

function mutateTopology({ root, staging, seed, step, random }) {
  const lane = path.join(root, `lane-${random(3)}`);
  const branch = path.join(lane, "deep", `branch-${random(4)}`);
  const action = random(5);

  if (action === 0) {
    fs.mkdirSync(branch, { recursive: true });
    fs.writeFileSync(path.join(branch, `created-${step}.txt`), `${seed}:${step}\n`);
    return;
  }
  if (action === 1) {
    fs.rmSync(branch, { recursive: true, force: true });
    return;
  }
  if (action === 2) {
    fs.mkdirSync(path.join(lane, "deep"), { recursive: true });
    fs.writeFileSync(
      path.join(lane, "deep", `changed-${step}.txt`),
      `${seed}:${step}\n`,
    );
    return;
  }
  if (action === 3) {
    const prepared = path.join(staging, `prepared-${step}`);
    const incoming = path.join(lane, `incoming-${random(3)}`);
    fs.rmSync(prepared, { recursive: true, force: true });
    fs.mkdirSync(path.join(prepared, "nested"), { recursive: true });
    fs.writeFileSync(path.join(prepared, "nested", "existing.txt"), "existing\n");
    fs.rmSync(incoming, { recursive: true, force: true });
    fs.mkdirSync(lane, { recursive: true });
    fs.renameSync(prepared, incoming);
    return;
  }

  const first = path.join(lane, "swap-a");
  const second = path.join(lane, "swap-b");
  const [source, destination] = fs.existsSync(first)
    ? [first, second]
    : [second, first];
  fs.mkdirSync(path.join(source, "nested"), { recursive: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(source, destination);
}

function assertStableRootState(actual, expected, seed, source, sequence) {
  assert.equal(
    actual.generation,
    expected.generation,
    diagnostic(seed, `${source} changed root generation`, {
      sequence,
      actual: actual.generation,
      expected: expected.generation,
    }),
  );
  assert.deepEqual(
    actual.identity,
    expected.identity,
    diagnostic(seed, `${source} changed root identity`, {
      sequence,
      actual: actual.identity,
      expected: expected.identity,
    }),
  );
  assert.equal(
    actual.attachment,
    "attached",
    diagnostic(seed, `${source} detached the stable root`, {
      sequence,
      actual,
    }),
  );
}

function validateBatch(root, batch, exclusionsByGeneration, seed) {
  const exclusions = exclusionsByGeneration.get(batch.exclusionGeneration);
  assert.ok(
    exclusions !== undefined,
    diagnostic(seed, "batch used an uncommitted exclusion generation", {
      generation: batch.exclusionGeneration,
    }),
  );
  if (batch.coverage.state === "uncertain") {
    assert.equal(
      batch.coverage.reason,
      "topology-race",
      diagnostic(seed, "operation sequence produced unapproved uncertainty", {
        sequence: batch.sequence,
        generation: batch.exclusionGeneration,
        coverage: batch.coverage,
        invalidatedPaths: batch.invalidatedPaths,
      }),
    );
    assert.ok(
      batch.invalidatedPaths.includes(root),
      diagnostic(seed, "topology uncertainty omitted the conservative root", {
        sequence: batch.sequence,
        invalidatedPaths: batch.invalidatedPaths,
      }),
    );
  } else {
    assert.equal(
      batch.coverage.state,
      "complete",
      diagnostic(seed, "batch reported unsupported coverage", {
        sequence: batch.sequence,
        generation: batch.exclusionGeneration,
        coverage: batch.coverage,
      }),
    );
  }
  assert.equal(batch.rootState.attachment, "attached");
  assert.ok(batch.invalidatedPathBytes.length <= MAX_BATCH_PATHS);

  for (const invalidatedPath of batch.invalidatedPaths) {
    const relative = path.relative(root, invalidatedPath);
    assert.ok(
      relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
        !relative.startsWith(`..${path.sep}`)),
      diagnostic(seed, "batch invalidated a path outside the root", {
        invalidatedPath,
        root,
      }),
    );
    if (relative === "") continue;
    assert.equal(
      exclusions.some((prefix) => isAtOrBelow(relative, prefix)),
      false,
      diagnostic(seed, "batch invalidated an excluded path", {
        generation: batch.exclusionGeneration,
        exclusions,
        invalidatedPath,
      }),
    );
  }
}

function assertExactWatchAccounting(
  engine,
  subscription,
  root,
  exclusions,
  seed,
  step,
) {
  const expected = countIncludedDirectories(root, exclusions);
  const subscriptionStats = subscription.stats();
  const runtimeStats = engine.runtimeStats();
  assert.equal(
    subscriptionStats.watchedDirectories,
    expected,
    diagnostic(seed, "subscription watch accounting diverged", {
      step,
      exclusions,
      expected,
      subscriptionStats,
    }),
  );
  assert.equal(subscriptionStats.deferredDirectories, 0);
  assert.equal(subscriptionStats.batchesDropped, 0n);
  assert.equal(subscriptionStats.overflowEvents, 0n);
  assert.equal(runtimeStats.nativeWatches, expected);
  assert.equal(runtimeStats.deferredInterests, 0);
  assert.equal(runtimeStats.subscriptions, 1);
}

function countIncludedDirectories(root, exclusions) {
  let count = 0;
  const visit = (directory, relative) => {
    if (relative !== "" && exclusions.some((prefix) =>
      isAtOrBelow(relative, prefix))) return;
    count += 1;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name), path.join(relative, entry.name));
      }
    }
  };
  visit(root, "");
  return count;
}

function isAtOrBelow(relative, prefix) {
  return relative === prefix || relative.startsWith(`${prefix}${path.sep}`);
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return (upperBound) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % upperBound;
  };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

function inactiveRuntimeStats() {
  return {
    active: false,
    inotifyInstances: 0,
    workerThreads: 0,
    nativeWatches: 0,
    nativeWatchBudget: null,
    deferredInterests: 0,
    subscriptions: 0,
  };
}

function formatSeed(seed) {
  return seed.toString(16).padStart(8, "0");
}

function diagnostic(seed, message, details) {
  return `${message}; seed=0x${formatSeed(seed)}; details=${JSON.stringify(
    details,
    (_key, value) => typeof value === "bigint" ? `${value}n` : value,
  )}`;
}
