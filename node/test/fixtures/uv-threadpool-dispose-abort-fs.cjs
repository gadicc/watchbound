"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const binding = require("../../index.js");

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}

async function main() {
  assert.equal(process.env.UV_THREADPOOL_SIZE, "1");
  const { subscribe } = await import("../../../js/index.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-dispose-fs-"));
  const readTarget = path.join(root, "callback-read.txt");
  const changeTarget = path.join(root, "change.txt");
  let subscription;
  let callbackEntered = false;

  try {
    fs.writeFileSync(readTarget, "read after abort");
    subscription = await subscribe(
      root,
      async (_batch, context) => {
        callbackEntered = true;
        if (!context.signal.aborted) {
          await new Promise((resolve) => {
            context.signal.addEventListener("abort", resolve, { once: true });
          });
        }
        // fs.promises uses libuv. A blocking DisposeTask on the sole worker
        // therefore deadlocks with the callback acknowledgement it awaits.
        await fs.promises.readFile(readTarget);
      },
      { batchWindowMs: 1 },
    );
    fs.writeFileSync(changeTarget, "change");
    await waitFor(() => callbackEntered, "callback did not enter before disposal");

    let timeout;
    try {
      await Promise.race([
        subscription.dispose(),
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("joined disposal deadlocked the sole libuv worker")),
            3_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    subscription = undefined;

    await waitFor(() => {
      const diagnostics = binding.deliveryDiagnostics();
      return diagnostics.dispatcherEnvironments === 0
        && diagnostics.dispatcherThreads === 0
        && diagnostics.registrations === 0
        && diagnostics.outstandingCallbacks === 0
        && diagnostics.cleanupCoordinatorThreads === 0
        && diagnostics.cleanupRequests === 0
        && diagnostics.activeThreadsafeFunctions === 0;
    }, "joined disposal did not restore the Node delivery baseline");
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
