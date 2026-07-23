"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const { promisify } = require("node:util");
const binding = require("../index.js");

const execFileAsync = promisify(execFile);

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}

function liveDeliveryResources(diagnostics) {
  return {
    dispatcherEnvironments: diagnostics.dispatcherEnvironments,
    dispatcherThreads: diagnostics.dispatcherThreads,
    registrations: diagnostics.registrations,
    outstandingCallbacks: diagnostics.outstandingCallbacks,
    cleanupCoordinatorThreads: diagnostics.cleanupCoordinatorThreads,
    cleanupRequests: diagnostics.cleanupRequests,
    activeThreadsafeFunctions: diagnostics.activeThreadsafeFunctions,
  };
}

test("raw establishment cancellation is single-bind and commits provisionally", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-cancel-"));
  let provisional;
  let committed;
  let provisionalCallbacks = 0;
  try {
    const alreadyCancelled = binding.createEstablishmentCancellation();
    const generationsBefore = binding.deliveryDiagnostics().environmentGenerations;
    alreadyCancelled.cancel();
    alreadyCancelled.cancel();
    assert.throws(
      () => binding.subscribe(root, {}, () => {}, alreadyCancelled),
      (error) => {
        assert.equal(error.name, "WatchboundError");
        assert.equal(error.code, "WATCHBOUND_OPERATION_CANCELLED");
        assert.equal(error.operation, "subscribe");
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(
      binding.deliveryDiagnostics().environmentGenerations,
      generationsBefore,
      "an already-cancelled raw attempt allocated an environment",
    );

    const cancelledBeforeCompute = binding.createEstablishmentCancellation();
    const deliveryBeforeQueuedCancellation = binding.deliveryDiagnostics();
    const cancelledPromise = binding.subscribe(root, {}, () => {}, cancelledBeforeCompute);
    cancelledBeforeCompute.cancel();
    await assert.rejects(cancelledPromise, (error) => {
      assert.equal(error.name, "WatchboundError");
      assert.equal(error.code, "WATCHBOUND_OPERATION_CANCELLED");
      assert.equal(error.operation, "subscribe");
      assert.equal(error.retryable, false);
      return true;
    });
    const deliveryAfterQueuedCancellation = binding.deliveryDiagnostics();
    assert.deepEqual(
      liveDeliveryResources(deliveryAfterQueuedCancellation),
      liveDeliveryResources(deliveryBeforeQueuedCancellation),
      "queued cancellation resolved before its Node delivery resources were joined",
    );
    assert.ok(
      deliveryAfterQueuedCancellation.environmentGenerations
        >= deliveryBeforeQueuedCancellation.environmentGenerations
        && deliveryAfterQueuedCancellation.environmentGenerations
          <= deliveryBeforeQueuedCancellation.environmentGenerations + 1n,
      "one queued cancellation allocated more than one environment generation",
    );

    const provisionalToken = binding.createEstablishmentCancellation();
    provisional = await binding.subscribe(root, {}, () => {
      provisionalCallbacks += 1;
    }, provisionalToken);
    provisionalToken.cancel();
    assert.equal(provisionalToken.commitPublicSuccess(), false);
    assert.throws(
      () => binding.subscribe(root, {}, () => {}, provisionalToken),
      (error) => {
        assert.equal(error.name, "WatchboundError");
        assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
        assert.equal(error.operation, "subscribe");
        return true;
      },
    );
    await provisional.dispose();
    provisional = undefined;
    const cancellationObserver = binding.createEngine();
    await waitFor(() => {
      const runtime = cancellationObserver.runtimeStats();
      const delivery = binding.deliveryDiagnostics();
      return runtime.active === false
        && runtime.inotifyInstances === 0
        && runtime.workerThreads === 0
        && runtime.nativeWatches === 0
        && runtime.deferredInterests === 0
        && runtime.subscriptions === 0
        && delivery.dispatcherEnvironments === 0
        && delivery.dispatcherThreads === 0
        && delivery.registrations === 0
        && delivery.outstandingCallbacks === 0
        && delivery.cleanupCoordinatorThreads === 0
        && delivery.cleanupRequests === 0
        && delivery.activeThreadsafeFunctions === 0;
    }, "provisional cancellation did not restore the exact native baseline");

    let callbacks = 0;
    const committedToken = binding.createEstablishmentCancellation();
    committed = await binding.subscribe(root, { batchWindowMs: 8 }, () => {
      callbacks += 1;
    }, committedToken);
    assert.equal(committedToken.commitPublicSuccess(), true);
    assert.equal(committedToken.commitPublicSuccess(), true);
    committedToken.cancel();
    fs.writeFileSync(path.join(root, "after-public-commit.txt"), "change");
    await waitFor(
      () => callbacks > 0,
      "cancellation after public commit stopped the established subscription",
    );
    assert.equal(
      provisionalCallbacks,
      0,
      "a callback entered after provisional cancellation completed",
    );
  } finally {
    await provisional?.dispose();
    await committed?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one environment shares one fair delivery dispatcher", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-dispatcher-"));
  const subscriptions = [];
  const callbackCounts = Array.from({ length: 12 }, () => 0);
  try {
    for (let index = 0; index < callbackCounts.length; index += 1) {
      subscriptions.push(await binding.subscribe(
        root,
        { batchWindowMs: 8, outputQueueCapacity: 2 },
        () => {
          callbackCounts[index] += 1;
        },
      ));
    }
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherThreads === 1
        && diagnostics.dispatcherEnvironments === 1
        && diagnostics.registrations === callbackCounts.length;
    }, "same-environment subscriptions did not converge on one dispatcher");

    fs.writeFileSync(path.join(root, "shared-change.txt"), "change");
    await waitFor(
      () => callbackCounts.every((count) => count > 0),
      "the shared dispatcher skipped a live peer",
    );

    const retired = subscriptions.splice(0, 6);
    await Promise.all(retired.map((subscription) => subscription.dispose()));
    assert.equal(
      binding.deliveryDiagnostics().activeThreadsafeFunctions,
      subscriptions.length,
      "joined disposal resolved before retired callback bridges finalized",
    );
    const retiredCounts = callbackCounts.slice(0, 6);
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherThreads === 1
        && diagnostics.registrations === subscriptions.length
        && diagnostics.cleanupCoordinatorThreads === 0
        && diagnostics.activeThreadsafeFunctions === subscriptions.length;
    }, "retiring a subset disturbed the shared environment services");

    for (let wave = 0; wave < 2; wave += 1) {
      const waveCounts = Array.from({ length: 4 }, () => 0);
      const waveSubscriptions = [];
      for (let index = 0; index < waveCounts.length; index += 1) {
        waveSubscriptions.push(await binding.subscribe(
          root,
          { batchWindowMs: 8, outputQueueCapacity: 2 },
          () => {
            waveCounts[index] += 1;
          },
        ));
      }
      await waitFor(() => {
        const diagnostics = binding.deliveryDiagnostics();
        return diagnostics.dispatcherThreads === 1
          && diagnostics.registrations === subscriptions.length + waveSubscriptions.length
          && diagnostics.cleanupCoordinatorThreads === 0
          && diagnostics.activeThreadsafeFunctions
            === subscriptions.length + waveSubscriptions.length;
      }, `churn wave ${wave} grew per-subscription environment services`);

      const stableBefore = callbackCounts.slice(6);
      fs.writeFileSync(path.join(root, `churn-${wave}.txt`), "change");
      await waitFor(
        () => waveCounts.every((count) => count > 0)
          && callbackCounts.slice(6).every((count, index) => count > stableBefore[index]),
        `churn wave ${wave} starved an old or newly admitted subscription`,
      );
      assert.deepEqual(
        callbackCounts.slice(0, 6),
        retiredCounts,
        `retired subscriptions received churn wave ${wave}`,
      );

      await Promise.all(waveSubscriptions.map((subscription) => subscription.dispose()));
      assert.equal(
        binding.deliveryDiagnostics().activeThreadsafeFunctions,
        subscriptions.length,
        `joined churn disposal ${wave} resolved before callback bridges finalized`,
      );
      await waitFor(() => {
        const diagnostics = binding.deliveryDiagnostics();
        return diagnostics.dispatcherThreads === 1
          && diagnostics.registrations === subscriptions.length
          && diagnostics.cleanupCoordinatorThreads === 0
          && diagnostics.activeThreadsafeFunctions === subscriptions.length;
      }, `disposing churn wave ${wave} disturbed stable peers`);
    }
  } finally {
    await Promise.all(subscriptions.map((subscription) => subscription.dispose()));
    fs.rmSync(root, { recursive: true, force: true });
  }

  await waitFor(() => {
    const diagnostics = binding.deliveryDiagnostics();
    return diagnostics.dispatcherThreads === 0
      && diagnostics.dispatcherEnvironments === 0
      && diagnostics.registrations === 0
      && diagnostics.outstandingCallbacks === 0
      && diagnostics.cleanupCoordinatorThreads === 0
      && diagnostics.cleanupRequests === 0
      && diagnostics.activeThreadsafeFunctions === 0;
  }, "joined disposal did not restore the Node delivery baseline");
});

test("queued cancellation needs no second libuv worker", { timeout: 15_000 }, async () => {
  await execFileAsync(
    process.execPath,
    [path.join(__dirname, "fixtures", "uv-threadpool-cancellation.cjs")],
    {
      env: {
        ...process.env,
        UV_THREADPOOL_SIZE: "1",
      },
      timeout: 10_000,
    },
  );
});

test("last-active disposal does not wait behind a pending establishment", { timeout: 15_000 }, async () => {
  await execFileAsync(
    process.execPath,
    [path.join(__dirname, "fixtures", "uv-threadpool-dispose-with-pending.cjs")],
    {
      env: {
        ...process.env,
        UV_THREADPOOL_SIZE: "1",
      },
      timeout: 10_000,
    },
  );
});

test("native bridge catches callback exceptions and remains usable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-error-"));
  let subscription;
  try {
    let callbacks = 0;
    let firstBatchRootState;
    subscription = await binding.subscribe(root, { batchWindowMs: 8 }, (batch) => {
      callbacks += 1;
      firstBatchRootState ??= batch.rootState;
      if (callbacks === 1) throw new Error("intentional callback failure");
    });
    const initialRootState = subscription.initialRootState;
    assert.deepEqual(initialRootState, subscription.rootState);
    assert.equal(initialRootState.generation, 0n);
    assert.equal(initialRootState.attachment, "attached");
    assert.equal(initialRootState.lossEvidence, undefined);

    fs.writeFileSync(path.join(root, "first.txt"), "first");
    await waitFor(() => callbacks === 1, "first callback did not run");
    assert.deepEqual(firstBatchRootState, initialRootState);
    await waitFor(
      () => subscription.stats().callbackErrors === 1n,
      "callback failure was not accounted",
    );
    fs.writeFileSync(path.join(root, "second.txt"), "second");
    await waitFor(() => callbacks >= 2, "bridge stopped after a callback exception");
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native exclusion replacement preserves byte prefixes and generation boundaries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-exclusions-"));
  let subscription;
  try {
    const batches = [];
    const relative = Buffer.from([0x68, 0x69, 0x64, 0x64, 0x65, 0x6e, 0xff]);
    const directory = Buffer.concat([Buffer.from(`${root}${path.sep}`), relative]);
    fs.mkdirSync(directory);
    subscription = await binding.subscribe(root, { batchWindowMs: 8 }, (batch) => {
      batches.push(batch);
    });
    assert.equal(subscription.exclusionGeneration, 0n);
    assert.equal(binding.capabilities().dynamicExclusions, true);

    const coverage = await subscription.replaceExclusions(1n, [relative]);
    assert.deepEqual(coverage, { state: "complete" });
    assert.equal(subscription.exclusionGeneration, 1n);
    fs.writeFileSync(Buffer.concat([directory, Buffer.from(`${path.sep}ignored`)]), "value");
    await delay(30);
    assert.equal(batches.length, 0);

    await subscription.replaceExclusions(2n, []);
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.some((value) => value.equals(directory))),
      "re-included byte path was not invalidated",
    );
    assert.ok(batches.every((batch) => typeof batch.exclusionGeneration === "bigint"));
    assert.equal(batches.at(-1).exclusionGeneration, 2n);
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native reconciliation commits coverage, generation, and a root invalidation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-reconcile-"));
  let subscription;
  try {
    const batches = [];
    subscription = await binding.subscribe(root, { batchWindowMs: 8 }, (batch) => {
      batches.push(batch);
    });
    await subscription.replaceExclusions(4n, [Buffer.from("hidden")]);
    fs.mkdirSync(path.join(root, "created", "deep"), { recursive: true });

    const result = await subscription.reconcile();
    assert.deepEqual(result, {
      exclusionGeneration: 4n,
      coverage: { state: "complete" },
    });
    assert.equal(binding.capabilities().reconciliation, true);
    await waitFor(
      () => batches.some((batch) =>
        batch.invalidatedPaths.some((value) => value.equals(Buffer.from(root)))),
      "reconciliation root invalidation was not delivered",
    );
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native root state and explicit replacement recovery preserve one subscription", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-recovery-"));
  const root = path.join(parent, "root");
  const moved = path.join(parent, "moved");
  fs.mkdirSync(path.join(root, "old", "deep"), { recursive: true });
  let subscription;
  try {
    const batches = [];
    subscription = await binding.subscribe(root, { batchWindowMs: 8 }, (batch) => {
      batches.push(batch);
    });
    const original = subscription.rootState;
    assert.deepEqual(subscription.initialRootState, original);
    assert.equal(original.generation, 0n);
    assert.equal(original.attachment, "attached");
    assert.equal(original.lossEvidence, undefined);
    assert.equal(typeof original.identity.device, "bigint");
    assert.equal(typeof original.identity.inode, "bigint");

    fs.renameSync(root, moved);
    fs.mkdirSync(path.join(root, "new", "deep"), { recursive: true });
    await waitFor(
      () => batches.some((batch) => batch.rootState.attachment === "lost"),
      "root loss state was not delivered",
    );
    assert.equal(subscription.rootState.attachment, "lost");

    const refused = await subscription.recoverRoot("original-only");
    assert.equal(refused.attachment, "not-attached");
    assert.equal(refused.reason, "replacement-not-accepted");
    assert.notDeepEqual(refused.candidateIdentity, original.identity);

    const recovered = await subscription.recoverRoot("accept-replacement");
    assert.equal(recovered.attachment, "replacement-adopted");
    assert.equal(recovered.reason, undefined);
    assert.equal(recovered.currentRootState.generation, 1n);
    assert.equal(recovered.currentRootState.attachment, "attached");
    assert.equal(recovered.exclusionGeneration, 0n);
    assert.deepEqual(recovered.coverage, { state: "complete" });
    assert.equal(typeof recovered.boundarySequence, "bigint");
    assert.deepEqual(subscription.initialRootState, original);
    await waitFor(
      () => batches.some((batch) => batch.sequence === recovered.boundarySequence),
      "root recovery boundary was not delivered",
    );

    const changed = path.join(root, "new", "deep", "after.txt");
    fs.writeFileSync(changed, "after");
    await waitFor(
      () => batches.some((batch) =>
        batch.invalidatedPaths.some((value) => value.equals(Buffer.from(changed)))),
      "recovered subscription did not deliver a deep change",
    );
    assert.equal(binding.capabilities().rootReplacementRecovery, true);
  } finally {
    await subscription?.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("native root recovery rejects an unknown identity policy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-policy-"));
  const subscription = await binding.subscribe(root, {}, () => {});
  try {
    assert.throws(
      () => subscription.recoverRoot("automatic"),
      (error) => {
        assert.equal(error.name, "WatchboundError");
        assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
        assert.equal(error.operation, "recover-root");
        assert.equal(error.retryable, false);
        assert.equal(error.retryAfter, undefined);
        assert.match(error.message, /identityPolicy/);
        return true;
      },
    );
    assert.throws(
      () => subscription.replaceExclusions(-1n, []),
      (error) => {
        assert.equal(error.name, "WatchboundError");
        assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
        assert.equal(error.operation, "replace-exclusions");
        assert.equal(error.retryable, false);
        assert.equal(error.retryAfter, undefined);
        assert.match(error.message, /generation/);
        return true;
      },
    );
  } finally {
    await subscription.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent native dispose calls join once and resolve together", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-dispose-"));
  const subscription = await binding.subscribe(root, {}, () => {});
  try {
    await Promise.all([
      subscription.dispose(),
      subscription.dispose(),
      subscription.dispose(),
    ]);
    assert.equal(subscription.stats().disposed, true);
  } finally {
    await subscription.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native binding reports partial coverage at a caller watch limit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-limit-"));
  let subscription;
  try {
    for (let index = 0; index < 5; index += 1) {
      fs.mkdirSync(path.join(root, `dir-${index}`, "nested"), { recursive: true });
    }
    subscription = await binding.subscribe(root, { watchLimit: 3 }, () => {});
    assert.deepEqual(subscription.initialCoverage, {
      state: "partial",
      reason: "resource-limit",
      watchedDirectories: 3,
      deferredDirectories: 8,
    });
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native engines own process budget requests without acquiring resources", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-engine-"));
  const firstRoot = path.join(parent, "first");
  const secondRoot = path.join(parent, "second");
  const unboundedRoot = path.join(parent, "unbounded");
  fs.mkdirSync(path.join(firstRoot, "one", "two"), { recursive: true });
  fs.mkdirSync(secondRoot);
  fs.mkdirSync(unboundedRoot);
  const firstEngine = binding.createEngine({ nativeWatchBudget: 2 });
  const sameEngine = binding.createEngine({ nativeWatchBudget: 2 });
  const conflictingEngine = binding.createEngine({ nativeWatchBudget: 3 });
  const unboundedEngine = binding.createEngine({ nativeWatchBudget: null });
  let first;
  let second;
  let unbounded;
  let reconfigured;
  try {
    assert.equal(firstEngine.nativeWatchBudget, 2);
    assert.equal(sameEngine.nativeWatchBudget, 2);
    assert.equal(conflictingEngine.nativeWatchBudget, 3);
    assert.equal(unboundedEngine.nativeWatchBudget ?? null, null);
    const inactiveStats = firstEngine.runtimeStats();
    assert.deepEqual({
      ...inactiveStats,
      nativeWatchBudget: inactiveStats.nativeWatchBudget ?? null,
    }, {
      active: false,
      inotifyInstances: 0,
      workerThreads: 0,
      nativeWatches: 0,
      nativeWatchBudget: null,
      deferredInterests: 0,
      subscriptions: 0,
    });

    first = await firstEngine.subscribe(firstRoot, {}, () => {});
    assert.deepEqual(first.initialCoverage, {
      state: "partial",
      reason: "resource-limit",
      watchedDirectories: 2,
      deferredDirectories: 1,
    });
    second = await sameEngine.subscribe(secondRoot, {}, () => {});
    const activeStats = firstEngine.runtimeStats();
    assert.deepEqual({
      ...activeStats,
      nativeWatchBudget: activeStats.nativeWatchBudget ?? null,
    }, {
      active: true,
      inotifyInstances: 1,
      workerThreads: 1,
      nativeWatches: 2,
      nativeWatchBudget: 2,
      deferredInterests: 2,
      subscriptions: 2,
    });

    await assert.rejects(
      conflictingEngine.subscribe(unboundedRoot, {}, () => {}),
      (error) => {
        assert.equal(error.code, "WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT");
        assert.equal(error.operation, "subscribe");
        assert.equal(error.retryAfter, "runtime-disposed");
        return true;
      },
    );
    await assert.rejects(
      binding.subscribe(unboundedRoot, {}, () => {}),
      (error) => {
        assert.equal(error.code, "WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT");
        assert.equal(error.operation, "subscribe");
        return true;
      },
    );

    await first.dispose();
    first = undefined;
    await second.dispose();
    second = undefined;
    assert.equal(firstEngine.runtimeStats().active, false);

    unbounded = await binding.subscribe(unboundedRoot, {}, () => {});
    assert.equal(unboundedEngine.runtimeStats().active, true);
    assert.equal(unboundedEngine.runtimeStats().nativeWatchBudget ?? null, null);
    await unbounded.dispose();
    unbounded = undefined;

    reconfigured = await conflictingEngine.subscribe(secondRoot, {}, () => {});
    assert.equal(conflictingEngine.runtimeStats().nativeWatchBudget, 3);
  } finally {
    await first?.dispose();
    await second?.dispose();
    await unbounded?.dispose();
    await reconfigured?.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("native engine validation and capability metadata are machine-readable", () => {
  for (const value of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32]) {
    assert.throws(
      () => binding.createEngine({ nativeWatchBudget: value }),
      (error) => {
        assert.equal(error.name, "WatchboundError");
        assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
        assert.equal(error.operation, "create-engine");
        assert.equal(error.retryable, false);
        assert.match(error.message, /nativeWatchBudget/);
        return true;
      },
    );
  }

  assert.equal(binding.createEngine().nativeWatchBudget ?? null, null);
  const metadata = binding.bindingMetadata();
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.bindingApiVersion, 2);
  assert.equal(metadata.nativeVersion, metadata.engineVersion);
  assert.equal(metadata.nodeApiVersion, 6);
  assert.match(metadata.targetTriple, /linux/);
  assert.equal(metadata.buildProfile, "release");

  const capabilities = binding.capabilities();
  assert.equal(capabilities.schemaVersion, 2);
  assert.equal(capabilities.cancellableEstablishment, true);
  assert.equal(capabilities.sharedNodeDelivery, true);
  assert.equal(capabilities.nativeCallbackQueueCapacity, 1);
  assert.equal(capabilities.deliveryDispatcherScope, "node-environment");
  assert.equal(capabilities.deliveryAdmission, "single-credit");
  assert.equal(capabilities.deliveryDispatcherWorkQuantum, 64);
  assert.equal(capabilities.deliveryDispatcherPollMilliseconds, 5);
  assert.equal(capabilities.processNativeWatchBudget, true);
  assert.equal(capabilities.sharedNativeWatches, true);
  assert.deepEqual({
    ...capabilities.subscriptionDefaults,
    watchLimit: capabilities.subscriptionDefaults.watchLimit ?? null,
  }, {
    watchLimit: null,
    batchWindowMs: 10,
    maxBatchPaths: 1_024,
    outputQueueCapacity: 64,
  });
  assert.equal(capabilities.positiveIntegerMinimum, 1);
  assert.equal(capabilities.positiveIntegerMaximum, 2 ** 32 - 1);
});

test("native binding rejects non-positive, fractional, and overflowing options", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-options-"));
  try {
    const invalidValues = [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32];
    for (const option of [
      "watchLimit",
      "batchWindowMs",
      "maxBatchPaths",
      "outputQueueCapacity",
    ]) {
      for (const value of invalidValues) {
        let acceptedSubscription;
        let rejection;
        try {
          acceptedSubscription = await binding.subscribe(root, { [option]: value }, () => {});
        } catch (error) {
          rejection = error;
        } finally {
          await acceptedSubscription?.dispose();
        }
        assert.ok(rejection, `${option} unexpectedly accepted ${String(value)}`);
        assert.equal(rejection.name, "WatchboundError");
        assert.equal(rejection.code, "WATCHBOUND_INVALID_ARGUMENT");
        assert.equal(rejection.operation, "subscribe");
        assert.equal(rejection.retryable, false);
        assert.match(rejection.message, new RegExp(option));
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native binding reports unavailable roots without collapsing the system cause", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-missing-root-"));
  const missing = path.join(parent, "missing");
  const deliveryBeforeFailure = binding.deliveryDiagnostics();
  try {
    await assert.rejects(
      binding.subscribe(missing, {}, () => {}),
      (error) => {
        assert.equal(error.name, "WatchboundError");
        assert.equal(error.code, "WATCHBOUND_ROOT_UNAVAILABLE");
        assert.equal(error.operation, "subscribe");
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfter, "filesystem-state-changes");
        assert.equal(error.systemCause?.domain, "os");
        assert.equal(typeof error.systemCause?.message, "string");
        return true;
      },
    );
    assert.deepEqual(
      liveDeliveryResources(binding.deliveryDiagnostics()),
      liveDeliveryResources(deliveryBeforeFailure),
      "ordinary establishment failure resolved before its Node delivery resources were joined",
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("native binding rejects work begun after joined disposal with a stable lifecycle code", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-closed-"));
  const subscription = await binding.subscribe(root, {}, () => {});
  try {
    await subscription.dispose();
    await assert.rejects(
      subscription.reconcile(),
      (error) => {
        assert.equal(error.name, "WatchboundError");
        assert.equal(error.code, "WATCHBOUND_SUBSCRIPTION_CLOSED");
        assert.equal(error.operation, "reconcile");
        assert.equal(error.retryable, false);
        assert.equal(error.retryAfter, undefined);
        return true;
      },
    );
  } finally {
    await subscription.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native binding resolves a relative root before asynchronous setup", async () => {
  const previousCwd = process.cwd();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-relative-"));
  const originalParent = path.join(parent, "original");
  const decoyParent = path.join(parent, "decoy");
  const relativeRoot = "watched";
  const originalRoot = path.join(originalParent, relativeRoot);
  fs.mkdirSync(originalRoot, { recursive: true });
  fs.mkdirSync(path.join(decoyParent, relativeRoot), { recursive: true });
  let subscription;
  try {
    const batches = [];
    process.chdir(originalParent);
    const subscriptionPromise = binding.subscribe(relativeRoot, { batchWindowMs: 8 }, (batch) => {
      batches.push(batch);
    });
    process.chdir(decoyParent);
    subscription = await subscriptionPromise;
    process.chdir(previousCwd);

    const changed = path.join(originalRoot, "changed.txt");
    fs.writeFileSync(changed, "change");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.some((value) => value.equals(Buffer.from(changed)))),
      "resolved root did not remain attached to the original cwd",
    );
  } finally {
    process.chdir(previousCwd);
    await subscription?.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
