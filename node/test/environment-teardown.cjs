"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const { isDeepStrictEqual, promisify } = require("node:util");
const { Worker } = require("node:worker_threads");
const binding = require("../index.js");

const execFileAsync = promisify(execFile);

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
      workerData: {
        root,
        expectedPath: workerChange,
        holdDeliveryCompletion: true,
      },
    });
    const ready = await waitForWorkerMessage(worker, "ready");
    assert.deepEqual(ready.initialCoverage, { state: "complete" });

    const active = normalizedRuntimeStats(observer);
    assert.equal(active.active, true);
    assert.equal(active.inotifyInstances, 1);
    assert.equal(active.workerThreads, 1);
    assert.ok(active.nativeWatches >= 1);
    assert.equal(active.subscriptions, 1);
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherEnvironments === 1
        && diagnostics.dispatcherThreads === 1
        && diagnostics.registrations === 1;
    }, "worker subscription did not own exactly one environment dispatcher");

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
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherEnvironments === 0
        && diagnostics.dispatcherThreads === 0
        && diagnostics.registrations === 0
        && diagnostics.cleanupCoordinatorThreads === 0
        && diagnostics.cleanupRequests === 0
        && diagnostics.activeThreadsafeFunctions === 0;
    }, "worker teardown left Node delivery resources active");

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
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherThreads === 0
        && diagnostics.registrations === 0
        && diagnostics.outstandingCallbacks === 0
        && diagnostics.activeThreadsafeFunctions === 0;
    }, "fresh joined disposal left Node delivery resources active");
  } finally {
    await freshSubscription?.dispose();
    if (worker) await terminateWorker(worker).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("environment teardown aborts a pending explicit-disposal Promise bridge", {
  timeout: 20_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-env-dispose-"));
  const workerChange = path.join(root, "worker-change.txt");
  const observer = binding.createEngine();
  let worker;

  try {
    worker = new Worker(path.join(__dirname, "fixtures", "environment-teardown-worker.cjs"), {
      workerData: {
        root,
        expectedPath: workerChange,
        holdDeliveryCompletion: true,
        startExplicitDispose: true,
      },
    });
    await waitForWorkerMessage(worker, "ready");
    const disposalStarted = waitForWorkerMessage(worker, "dispose-started");
    fs.writeFileSync(workerChange, "worker");
    await disposalStarted;

    await terminateWorker(worker);
    worker = undefined;
    await waitFor(
      () => isDeepStrictEqual(normalizedRuntimeStats(observer), ZERO_RUNTIME_STATS),
      () => `pending dispose teardown left runtime resources active: ${JSON.stringify(normalizedRuntimeStats(observer))}`,
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
    }, "pending dispose teardown left Node delivery resources active");
  } finally {
    if (worker) await terminateWorker(worker).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("independent Worker environments isolate blocked callbacks and teardown", { timeout: 20_000 }, async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-worker-isolation-"));
  const rootA = path.join(parent, "a");
  const rootB = path.join(parent, "b");
  fs.mkdirSync(rootA);
  fs.mkdirSync(rootB);
  const blockBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const blockControl = new Int32Array(blockBuffer);
  const fixture = path.join(__dirname, "fixtures", "delivery-worker.cjs");
  let workerA;
  let workerB;

  try {
    workerA = new Worker(fixture, {
      workerData: {
        root: rootA,
        label: "a",
        blockControl: blockBuffer,
      },
    });
    workerB = new Worker(fixture, {
      workerData: {
        root: rootB,
        label: "b",
      },
    });
    await Promise.all([
      waitForWorkerMessage(workerA, "ready"),
      waitForWorkerMessage(workerB, "ready"),
    ]);
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherEnvironments === 2
        && diagnostics.dispatcherThreads === 2
        && diagnostics.registrations === 2
        && diagnostics.activeThreadsafeFunctions === 2;
    }, "two Worker environments did not receive isolated dispatchers");

    const callbackEntered = waitForWorkerMessage(workerA, "callback-entered");
    const observedA = waitForWorkerMessage(workerA, "observed");
    fs.writeFileSync(path.join(rootA, "block.txt"), "a");
    await callbackEntered;
    assert.equal(Atomics.load(blockControl, 0), 0, "Worker A was not held in its callback");

    const observedB = waitForWorkerMessage(workerB, "observed");
    fs.writeFileSync(path.join(rootB, "while-a-blocked.txt"), "b");
    await observedB;
    assert.equal(
      Atomics.load(blockControl, 0),
      0,
      "Worker A unblocked before Worker B independently delivered",
    );

    Atomics.store(blockControl, 0, 1);
    Atomics.notify(blockControl, 0);
    await observedA;

    await terminateWorker(workerA);
    workerA = undefined;
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherEnvironments === 1
        && diagnostics.dispatcherThreads === 1
        && diagnostics.registrations === 1
        && diagnostics.activeThreadsafeFunctions === 1;
    }, "tearing down Worker A disturbed Worker B's delivery environment");

    const observedBAfterTeardown = waitForWorkerMessage(workerB, "observed");
    fs.writeFileSync(path.join(rootB, "after-a-teardown.txt"), "b2");
    await observedBAfterTeardown;

    const disposedB = waitForWorkerMessage(workerB, "disposed");
    workerB.postMessage({ type: "dispose" });
    await disposedB;
    await terminateWorker(workerB);
    workerB = undefined;
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherEnvironments === 0
        && diagnostics.dispatcherThreads === 0
        && diagnostics.registrations === 0
        && diagnostics.outstandingCallbacks === 0
        && diagnostics.cleanupCoordinatorThreads === 0
        && diagnostics.cleanupRequests === 0
        && diagnostics.activeThreadsafeFunctions === 0;
    }, "Worker isolation test did not restore the Node delivery baseline");
  } finally {
    Atomics.store(blockControl, 0, 1);
    Atomics.notify(blockControl, 0);
    if (workerA) await terminateWorker(workerA).catch(() => {});
    if (workerB) await terminateWorker(workerB).catch(() => {});
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("tearing down a Worker cancels queued establishment and permits a fresh subscription", { timeout: 20_000 }, async () => {
  await execFileAsync(
    process.execPath,
    [path.join(__dirname, "fixtures", "uv-threadpool-worker-teardown.cjs")],
    {
      env: {
        ...process.env,
        UV_THREADPOOL_SIZE: "1",
      },
      timeout: 15_000,
    },
  );
});
