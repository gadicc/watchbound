"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { isDeepStrictEqual } = require("node:util");
const { Worker } = require("node:worker_threads");
const binding = require("../../index.js");

const ZERO_RUNTIME_STATS = {
  active: false,
  inotifyInstances: 0,
  workerThreads: 0,
  nativeWatches: 0,
  nativeWatchBudget: null,
  deferredInterests: 0,
  subscriptions: 0,
};

function normalizedRuntimeStats(engine) {
  const stats = engine.runtimeStats();
  return {
    ...stats,
    nativeWatchBudget: stats.nativeWatchBudget ?? null,
  };
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}

function waitForWorkerMessage(worker, expectedType, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`worker did not report ${expectedType} within ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (message?.type === expectedType) {
        cleanup();
        resolve(message);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`worker exited with code ${code} before reporting ${expectedType}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}

async function terminateWorker(worker, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`worker environment teardown exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    worker.terminate().then(
      (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function main() {
  assert.equal(process.env.UV_THREADPOOL_SIZE, "1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-pending-env-"));
  const observer = binding.createEngine();
  const blocker = binding.__watchboundTestOnlyCreateThreadpoolBlocker();
  const blocked = blocker.block();
  let worker;
  let freshSubscription;

  try {
    await waitFor(() => blocker.started, "the sole libuv worker never entered the blocker");
    worker = new Worker(path.join(__dirname, "pending-establishment-worker.cjs"), {
      workerData: { root },
    });
    await waitForWorkerMessage(worker, "queued");
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherEnvironments === 1
        && diagnostics.dispatcherThreads === 1
        && diagnostics.registrations === 0
        && diagnostics.activeThreadsafeFunctions === 1;
    }, "queued Worker establishment did not publish its pending environment resources");

    const termination = terminateWorker(worker);
    // Node does not enter the environment cleanup hook until its queued async
    // work can advance. Initiate teardown first, then release the deterministic
    // pool blocker; Watchbound cleanup itself must not require a JavaScript
    // callback or a second libuv worker.
    blocker.release();
    await blocked;
    await termination;
    worker = undefined;

    await waitFor(
      () => isDeepStrictEqual(normalizedRuntimeStats(observer), ZERO_RUNTIME_STATS),
      `pending Worker teardown left process runtime resources active: ${JSON.stringify(normalizedRuntimeStats(observer))}`,
    );
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherEnvironments === 0
        && diagnostics.dispatcherThreads === 0
        && diagnostics.registrations === 0
        && diagnostics.outstandingCallbacks === 0
        && diagnostics.cleanupCoordinatorThreads === 0
        && diagnostics.cleanupRequests === 0
        && diagnostics.activeThreadsafeFunctions === 0;
    }, "pending Worker teardown left Node delivery resources active");

    let callbacks = 0;
    freshSubscription = await binding.subscribe(root, { batchWindowMs: 8 }, () => {
      callbacks += 1;
    });
    fs.writeFileSync(path.join(root, "fresh-after-pending-teardown.txt"), "fresh");
    await waitFor(
      () => callbacks > 0,
      "fresh subscription did not deliver after pending Worker teardown",
    );
    await freshSubscription.dispose();
    freshSubscription = undefined;
    await waitFor(
      () => isDeepStrictEqual(normalizedRuntimeStats(observer), ZERO_RUNTIME_STATS),
      "fresh subscription did not restore the runtime baseline",
    );
  } finally {
    blocker.release();
    await blocked.catch(() => {});
    await freshSubscription?.dispose();
    if (worker) await terminateWorker(worker).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
