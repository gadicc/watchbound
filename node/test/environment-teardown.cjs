"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const { isDeepStrictEqual } = require("node:util");
const { Worker } = require("node:worker_threads");
const binding = require("../index.js");

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
  assert.ok(predicate(), typeof message === "function" ? message() : message);
}

function waitForWorkerMessage(worker, expectedType, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`worker did not report ${expectedType} within ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (message) => {
      if (message?.type === "failure") {
        cleanup();
        reject(new Error(`worker setup failed (${message.code ?? message.name}): ${message.message}`));
      } else if (message?.type === expectedType) {
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

// Regression seam: the ordinary lifecycle suite always explicitly disposed its
// subscription in the same Node environment, so it could not detect a cleanup
// hook that failed to release a live subscription during environment teardown.
test("destroying a Node environment releases its live native subscription", { timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-env-teardown-"));
  const workerChange = path.join(root, "worker-change.txt");
  const freshChange = path.join(root, "fresh-change.txt");
  const observer = binding.createEngine();
  let worker;
  let freshSubscription;

  try {
    assert.deepEqual(normalizedRuntimeStats(observer), ZERO_RUNTIME_STATS);

    worker = new Worker(path.join(__dirname, "fixtures", "environment-teardown-worker.cjs"), {
      workerData: { root, expectedPath: workerChange },
    });
    const ready = await waitForWorkerMessage(worker, "ready");
    assert.deepEqual(ready.initialCoverage, { state: "complete" });

    const active = normalizedRuntimeStats(observer);
    assert.equal(active.active, true);
    assert.equal(active.inotifyInstances, 1);
    assert.equal(active.workerThreads, 1);
    assert.ok(active.nativeWatches >= 1);
    assert.equal(active.subscriptions, 1);

    const workerObserved = waitForWorkerMessage(worker, "change-observed");
    fs.writeFileSync(workerChange, "worker");
    await workerObserved;

    // Environment teardown is a best-effort safety path. Unlike public
    // dispose(), it does not promise that JavaScript callback work is joined.
    await terminateWorker(worker);
    worker = undefined;
    await waitFor(
      () => isDeepStrictEqual(normalizedRuntimeStats(observer), ZERO_RUNTIME_STATS),
      () => `worker teardown left process runtime resources active: ${JSON.stringify(normalizedRuntimeStats(observer))}`,
    );

    const freshBatches = [];
    const freshEngine = binding.createEngine();
    freshSubscription = await freshEngine.subscribe(root, { batchWindowMs: 8 }, (batch) => {
      freshBatches.push(batch);
    });
    fs.writeFileSync(freshChange, "fresh");
    await waitFor(
      () => freshBatches.some((batch) =>
        batch.invalidatedPaths.some((value) => value.equals(Buffer.from(freshChange)))),
      "fresh subscription did not observe a change after environment teardown",
    );

    await freshSubscription.dispose();
    freshSubscription = undefined;
    await waitFor(
      () => isDeepStrictEqual(normalizedRuntimeStats(freshEngine), ZERO_RUNTIME_STATS),
      () => `fresh joined disposal left process runtime resources active: ${JSON.stringify(normalizedRuntimeStats(freshEngine))}`,
    );
  } finally {
    await freshSubscription?.dispose();
    if (worker) await terminateWorker(worker).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
