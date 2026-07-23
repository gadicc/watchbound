"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setImmediate: immediate } = require("node:timers/promises");
const { setTimeout: delay } = require("node:timers/promises");
const binding = require("../../index.js");

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}

async function main() {
  assert.equal(process.env.UV_THREADPOOL_SIZE, "1");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-uv-one-"));
  const blocker = binding.__watchboundTestOnlyCreateThreadpoolBlocker();
  const blocked = blocker.block();
  try {
    await waitFor(() => blocker.started, "the sole libuv worker never entered the blocker");

    const token = binding.createEstablishmentCancellation();
    let settled = false;
    const subscriptionPromise = binding.subscribe(root, {}, () => {}, token);
    subscriptionPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    token.cancel();

    await immediate();
    await immediate();
    assert.equal(
      settled,
      false,
      "queued establishment settled while the only libuv worker was deterministically blocked",
    );
    const pendingDiagnostics = binding.deliveryDiagnostics();
    assert.deepEqual(
      {
        dispatcherThreads: pendingDiagnostics.dispatcherThreads,
        registrations: pendingDiagnostics.registrations,
        cleanupCoordinatorThreads: pendingDiagnostics.cleanupCoordinatorThreads,
        activeThreadsafeFunctions: pendingDiagnostics.activeThreadsafeFunctions,
      },
      {
        dispatcherThreads: 1,
        registrations: 0,
        cleanupCoordinatorThreads: 0,
        activeThreadsafeFunctions: 1,
      },
      "pending establishment did not use exactly one environment service thread",
    );

    blocker.release();
    await blocked;
    await assert.rejects(subscriptionPromise, (error) => {
      assert.equal(error.name, "WatchboundError");
      assert.equal(error.code, "WATCHBOUND_OPERATION_CANCELLED");
      assert.equal(error.operation, "subscribe");
      assert.equal(error.retryable, false);
      return true;
    });
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherThreads === 0
        && diagnostics.registrations === 0
        && diagnostics.outstandingCallbacks === 0
        && diagnostics.activeThreadsafeFunctions === 0;
    }, "queued cancellation did not restore the Node delivery baseline");
  } finally {
    blocker.release();
    await blocked.catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
