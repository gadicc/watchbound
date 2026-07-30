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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-dispose-pending-"));
  let active;
  let pending;
  const blocker = binding.__watchboundTestOnlyCreateThreadpoolBlocker();
  let blocked;

  try {
    active = await binding.subscribe(root, { batchWindowMs: 8 }, () => {});
    blocked = blocker.block();
    await waitFor(() => blocker.started, "the sole libuv worker never entered the blocker");

    let disposalSettled = false;
    const disposal = active.dispose().finally(() => {
      disposalSettled = true;
    });
    const pendingPromise = binding.subscribe(root, { batchWindowMs: 8 }, () => {});
    let pendingSettled = false;
    pendingPromise.finally(() => {
      pendingSettled = true;
    });

    await immediate();
    await waitFor(
      () => disposalSettled,
      "disposal waited behind the occupied libuv worker",
    );
    assert.equal(
      pendingSettled,
      false,
      "pending establishment bypassed the occupied libuv worker",
    );
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherThreads === 1
        && diagnostics.activeThreadsafeFunctions === 1;
    }, "the pending registration did not retain the shared dispatcher");

    blocker.release();
    await blocked;
    await disposal;
    active = undefined;
    pending = await pendingPromise;

    await pending.dispose();
    pending = undefined;
    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherEnvironments === 0
        && diagnostics.dispatcherThreads === 0
        && diagnostics.registrations === 0
        && diagnostics.outstandingCallbacks === 0
        && diagnostics.cleanupCoordinatorThreads === 0
        && diagnostics.cleanupRequests === 0
        && diagnostics.activeThreadsafeFunctions === 0;
    }, "dispose/pending sequencing did not restore the Node delivery baseline");
  } finally {
    blocker.release();
    await blocked?.catch(() => {});
    await active?.dispose();
    await pending?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
