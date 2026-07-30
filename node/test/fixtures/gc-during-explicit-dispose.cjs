"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const binding = require("../../index.js");

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    global.gc();
    await delay(10);
  }
  assert.ok(predicate(), message);
}

async function main() {
  assert.equal(typeof global.gc, "function");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-dispose-gc-"));
  let subscription;
  let deliveryId;
  let disposal;
  let deliveryCompleted = false;

  try {
    subscription = await binding.subscribe(
      root,
      { batchWindowMs: 1 },
      (_batch, currentDeliveryId) => {
        deliveryId = currentDeliveryId;
        // Private binding seam: retain completion ownership until the fixture
        // explicitly acknowledges this delivery below.
        return true;
      },
    );
    fs.writeFileSync(path.join(root, "change.txt"), "change");
    await waitFor(() => deliveryId !== undefined, "delivery callback did not enter");

    let receiverFinalized = false;
    const finalizationRegistry = new FinalizationRegistry(() => {
      receiverFinalized = true;
    });
    finalizationRegistry.register(subscription, undefined);

    let disposalSettled = false;
    disposal = subscription.dispose().finally(() => {
      disposalSettled = true;
    });
    subscription = undefined;

    await waitFor(
      () => receiverFinalized,
      "native subscription receiver was not finalized during disposal",
    );
    await delay(50);
    assert.equal(
      disposalSettled,
      false,
      "receiver GC abandoned a callback already owned by explicit disposal",
    );
    assert.equal(binding.deliveryDiagnostics().outstandingCallbacks, 1);

    assert.equal(binding.completeDelivery(deliveryId, false, false), true);
    deliveryCompleted = true;
    await disposal;
    assert.deepEqual(
      {
        dispatcherEnvironments: binding.deliveryDiagnostics().dispatcherEnvironments,
        dispatcherThreads: binding.deliveryDiagnostics().dispatcherThreads,
        registrations: binding.deliveryDiagnostics().registrations,
        outstandingCallbacks: binding.deliveryDiagnostics().outstandingCallbacks,
        cleanupCoordinatorThreads:
          binding.deliveryDiagnostics().cleanupCoordinatorThreads,
        cleanupRequests: binding.deliveryDiagnostics().cleanupRequests,
        activeThreadsafeFunctions:
          binding.deliveryDiagnostics().activeThreadsafeFunctions,
      },
      {
        dispatcherEnvironments: 0,
        dispatcherThreads: 0,
        registrations: 0,
        outstandingCallbacks: 0,
        cleanupCoordinatorThreads: 0,
        cleanupRequests: 0,
        activeThreadsafeFunctions: 0,
      },
    );
  } finally {
    if (deliveryId !== undefined && !deliveryCompleted) {
      binding.completeDelivery(deliveryId, false, false);
    }
    await disposal?.catch(() => {});
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
