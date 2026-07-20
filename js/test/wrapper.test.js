import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { capabilities, subscribe } from "../index.js";

async function waitFor(predicate, message, timeoutMs = 3_000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  let matched = await predicate();
  while (!matched && Date.now() < deadline) {
    await delay(intervalMs);
    matched = await predicate();
  }
  assert.ok(matched, message);
}

async function waitForQuiet(batchCount, quietMs = 75, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let previous = batchCount();
  while (Date.now() < deadline) {
    await delay(quietMs);
    const current = batchCount();
    if (current === previous) return;
    previous = current;
  }
  assert.fail("callbacks did not quiesce before the bounded deadline");
}

test("wrapper delivers string paths and idempotent disposal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-"));
  let subscription;
  try {
    const batches = [];
    subscription = await subscribe(root, (batch) => batches.push(batch), {
      batchWindowMs: 8,
    });
    const changed = path.join(root, "changed.txt");
    fs.writeFileSync(changed, "change");
    const deadline = Date.now() + 3_000;
    while (batches.length === 0 && Date.now() < deadline) await delay(10);

    assert.equal(capabilities.recursive, true);
    assert.equal(capabilities.dynamicExclusions, true);
    assert.equal(subscription.initialCoverage.state, "complete");
    assert.equal(subscription.exclusionGeneration, 0n);
    assert.deepEqual(subscription.automaticReconciliation, { state: "disabled" });
    assert.ok(batches.some((batch) => batch.invalidatedPaths.includes(changed)));
    assert.equal(typeof batches[0].sequence, "bigint");
    assert.equal(batches[0].exclusionGeneration, 0n);
    assert.equal(batches[0].rootState.generation, 0n);
    assert.equal(batches[0].rootState.attachment, "attached");
    assert.equal(typeof batches[0].rootState.identity.device, "bigint");
    assert.deepEqual(subscription.rootState, batches[0].rootState);
    assert.equal(batches[0].pathEncodingCollapsed, false);
    await Promise.all([subscription.dispose(), subscription.dispose()]);
    assert.equal(subscription.stats().disposed, true);
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper replaces exclusions atomically and validates its representation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-exclusions-"));
  const hidden = path.join(root, "hidden");
  fs.mkdirSync(hidden);
  let subscription;
  try {
    const batches = [];
    subscription = await subscribe(root, (batch) => batches.push(batch), {
      batchWindowMs: 8,
    });
    await assert.rejects(subscription.replaceExclusions(1n, ["../outside"]), /normalized/);
    assert.equal(subscription.exclusionGeneration, 0n);
    await subscription.replaceExclusions(1n, ["hidden"]);
    fs.writeFileSync(path.join(hidden, "ignored"), "value");
    await delay(30);
    assert.equal(batches.length, 0);

    await subscription.replaceExclusions(2n, []);
    const deadline = Date.now() + 3_000;
    while (batches.length === 0 && Date.now() < deadline) await delay(10);
    assert.ok(batches.some((batch) => batch.invalidatedPaths.includes(hidden)));
    assert.ok(batches.every((batch) => batch.exclusionGeneration === 2n));
    assert.equal(subscription.exclusionGeneration, 2n);
    assert.throws(() => subscription.replaceExclusions(3, []), /bigint/);
    assert.throws(() => subscription.replaceExclusions(3n, null), /array/);
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper reconciles in place under the committed exclusion generation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-reconcile-"));
  let subscription;
  try {
    const hidden = path.join(root, "hidden");
    fs.mkdirSync(path.join(hidden, "current", "deep"), { recursive: true });
    const batches = [];
    subscription = await subscribe(root, (batch) => batches.push(batch), {
      batchWindowMs: 8,
    });
    await subscription.replaceExclusions(2n, ["hidden"]);
    fs.mkdirSync(path.join(root, "created", "deep"), { recursive: true });
    fs.mkdirSync(path.join(hidden, "future", "deep"), { recursive: true });
    fs.writeFileSync(path.join(hidden, "current", "deep", "ignored.txt"), "ignored");
    fs.writeFileSync(path.join(hidden, "future", "deep", "ignored.txt"), "ignored");
    await delay(30);
    assert.ok(
      batches.every((batch) =>
        batch.invalidatedPaths.every((changedPath) => !changedPath.startsWith(hidden))),
      "current or future excluded prefixes leaked into a callback",
    );

    const result = await subscription.reconcile();
    assert.deepEqual(result, {
      exclusionGeneration: 2n,
      coverage: { state: "complete" },
    });
    assert.equal(capabilities.reconciliation, true);
    const deadline = Date.now() + 3_000;
    while (!batches.some((batch) => batch.invalidatedPaths.includes(root)) && Date.now() < deadline) {
      await delay(10);
    }
    const rootBatch = batches.find((batch) => batch.invalidatedPaths.includes(root));
    assert.ok(rootBatch, "reconciliation did not deliver a root invalidation");
    assert.equal(rootBatch.exclusionGeneration, 2n);
    assert.deepEqual(rootBatch.coverage, result.coverage);
    assert.equal(subscription.exclusionGeneration, 2n);

    const sentinel = path.join(root, "created", "deep", "sentinel.txt");
    fs.writeFileSync(sentinel, "after reconciliation");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(sentinel)),
      "deep change was not delivered after reconciliation",
    );
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper reconciles observable consumer backpressure on the same subscription", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-backpressure-reconcile-"));
  let subscription;
  try {
    const burstRoot = path.join(root, "burst");
    const deepRoot = path.join(root, "deep", "watched");
    fs.mkdirSync(burstRoot);
    fs.mkdirSync(deepRoot, { recursive: true });
    const targets = [];
    for (let index = 0; index < 64; index += 1) {
      const target = path.join(burstRoot, `file-${String(index).padStart(3, "0")}.txt`);
      fs.writeFileSync(target, "before\n");
      targets.push(target);
    }

    const batches = [];
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    let callbackWasBlocked = false;
    const uncertainIntervalMutation = path.join(deepRoot, "during-uncertainty.txt");
    subscription = await subscribe(
      root,
      (batch) => {
        if (!callbackWasBlocked) {
          callbackWasBlocked = true;
          for (let round = 0; round < 32; round += 1) {
            for (const target of targets) fs.appendFileSync(target, "pressure\n");
          }
          fs.writeFileSync(uncertainIntervalMutation, "created while callback was blocked");
          Atomics.wait(waitCell, 0, 0, 200);
        }
        batches.push(batch);
      },
      {
        batchWindowMs: 1,
        maxBatchPaths: 4_096,
        outputQueueCapacity: 2,
      },
    );

    assert.equal(subscription.exclusionGeneration, 0n);
    assert.deepEqual(subscription.automaticReconciliation, { state: "disabled" });
    for (const target of targets) fs.appendFileSync(target, "trigger\n");
    await waitFor(
      () => batches.some((batch) =>
        batch.coverage.state === "uncertain" &&
        batch.coverage.reason === "consumer-backpressure"),
      "consumer-backpressure uncertainty was not publicly observable",
      5_000,
    );
    await waitFor(
      () => subscription.stats().batchesDropped > 0n,
      "native output pressure did not drop a bounded batch",
    );
    await waitForQuiet(() => batches.length);

    const recoveryBatchIndex = batches.length;
    const reconcilePromise = subscription.reconcile();
    fs.appendFileSync(uncertainIntervalMutation, "\nmutated while reconciliation was requested");
    const result = await reconcilePromise;
    assert.deepEqual(result, {
      exclusionGeneration: 0n,
      coverage: { state: "complete" },
    });
    assert.equal(subscription.exclusionGeneration, 0n);

    await waitFor(
      () => batches.slice(recoveryBatchIndex).some((batch) =>
        batch.invalidatedPaths.includes(root) &&
        batch.exclusionGeneration === result.exclusionGeneration),
      "successful reconciliation did not deliver its committed root boundary",
    );
    await waitForQuiet(() => batches.length);
    const recoveryRootBatches = batches.slice(recoveryBatchIndex).filter((batch) =>
      batch.invalidatedPaths.includes(root));
    assert.equal(recoveryRootBatches.length, 1, "reconciliation emitted multiple recovery boundaries");
    assert.deepEqual(recoveryRootBatches[0].coverage, result.coverage);
    assert.equal(callbackWasBlocked, true);

    for (let index = 1; index < batches.length; index += 1) {
      assert.ok(
        batches[index].sequence > batches[index - 1].sequence,
        "subscription-local sequences were not strictly monotonic",
      );
      assert.equal(batches[index].exclusionGeneration, 0n);
    }

    const sentinel = path.join(deepRoot, "after-reconciliation.txt");
    const sentinelBatchIndex = batches.length;
    fs.writeFileSync(sentinel, "sentinel");
    await waitFor(
      () => batches.slice(sentinelBatchIndex).some((batch) =>
        batch.invalidatedPaths.includes(sentinel)),
      "post-reconciliation deep sentinel was not delivered",
    );
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper automatically reconciles consumer backpressure only when opted in", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-auto-reconcile-"));
  let subscription;
  try {
    const burstRoot = path.join(root, "burst");
    fs.mkdirSync(burstRoot);
    const targets = [];
    for (let index = 0; index < 64; index += 1) {
      const target = path.join(burstRoot, `file-${String(index).padStart(3, "0")}.txt`);
      fs.writeFileSync(target, "before\n");
      targets.push(target);
    }

    const batches = [];
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    let callbackWasBlocked = false;
    subscription = await subscribe(
      root,
      (batch) => {
        if (!callbackWasBlocked) {
          callbackWasBlocked = true;
          for (let round = 0; round < 32; round += 1) {
            for (const target of targets) fs.appendFileSync(target, "pressure\n");
          }
          Atomics.wait(waitCell, 0, 0, 200);
        }
        batches.push(batch);
      },
      {
        batchWindowMs: 1,
        maxBatchPaths: 4_096,
        outputQueueCapacity: 2,
        automaticReconciliation: {
          maxAttempts: 3,
          initialDelayMs: 10,
          maxDelayMs: 40,
        },
      },
    );

    assert.equal(capabilities.automaticReconciliation, true);
    for (const target of targets) fs.appendFileSync(target, "trigger\n");
    await waitFor(
      () => batches.some((batch) =>
        batch.coverage.state === "uncertain" &&
        batch.coverage.reason === "consumer-backpressure"),
      "consumer-backpressure uncertainty was not observed",
      5_000,
    );
    await waitFor(
      () => subscription.automaticReconciliation.state === "recovered",
      `automatic reconciliation did not recover: ${JSON.stringify(subscription.automaticReconciliation)}`,
      5_000,
    );
    const status = subscription.automaticReconciliation;
    assert.equal(status.reason, "consumer-backpressure");
    assert.equal(status.exclusionGeneration, 0n);
    assert.deepEqual(status.coverage, { state: "complete" });
    await waitFor(
      () => batches.some((batch) =>
        batch.invalidatedPaths.length === 1 &&
        batch.invalidatedPaths[0] === root &&
        batch.exclusionGeneration === status.exclusionGeneration &&
        batch.coverage.state === status.coverage.state),
      "automatic recovery root boundary was not delivered",
    );

    const sequences = batches.map((batch) => batch.sequence);
    assert.ok(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]));
    assert.ok(batches.every((batch) => batch.exclusionGeneration === 0n));
  } finally {
    await subscription?.dispose();
    if (subscription) {
      assert.deepEqual(subscription.automaticReconciliation, { state: "disposed" });
      assert.equal(subscription.stats().watchedDirectories, 0);
      assert.equal(subscription.stats().deferredDirectories, 0);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper rejects concurrent reconciliation and exclusion transactions explicitly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-reconcile-conflicts-"));
  let subscription;
  try {
    for (let index = 0; index < 768; index += 1) {
      fs.mkdirSync(path.join(root, "tree", `dir-${String(index).padStart(4, "0")}`), {
        recursive: true,
      });
    }
    subscription = await subscribe(root, () => {}, {
      batchWindowMs: 5,
      outputQueueCapacity: 16,
    });

    const concurrentReconciliations = await Promise.allSettled(
      Array.from({ length: 8 }, () => subscription.reconcile()),
    );
    assert.ok(
      concurrentReconciliations.some((result) => result.status === "fulfilled"),
      "every concurrent reconciliation request failed",
    );
    const reconciliationConflict = concurrentReconciliations.find((result) =>
      result.status === "rejected" && /topology transaction/i.test(result.reason.message)
    );
    assert.ok(reconciliationConflict, "both concurrent reconciliation requests succeeded");
    assert.match(reconciliationConflict.reason.message, /topology transaction/i);

    const conflictingTransactions = await Promise.allSettled([
      subscription.reconcile(),
      subscription.replaceExclusions(1n, ["tree"]),
    ]);
    assert.equal(
      conflictingTransactions.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const exclusionConflict = conflictingTransactions.find((result) => result.status === "rejected");
    assert.ok(exclusionConflict, "reconciliation and exclusion update both committed concurrently");
    assert.match(exclusionConflict.reason.message, /topology transaction/i);
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper does not report root-replaced uncertainty as recovered", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-reconcile-root-loss-"));
  const root = path.join(parent, "root");
  const movedRoot = path.join(parent, "moved-root");
  fs.mkdirSync(path.join(root, "deep"), { recursive: true });
  let subscription;
  try {
    const batches = [];
    subscription = await subscribe(root, (batch) => batches.push(batch), {
      batchWindowMs: 5,
      automaticReconciliation: {
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 40,
      },
    });
    fs.renameSync(root, movedRoot);
    await waitFor(
      () => batches.some((batch) =>
        batch.coverage.state === "uncertain" && batch.coverage.reason === "root-replaced"),
      "root replacement uncertainty was not publicly observable",
    );
    assert.deepEqual(subscription.automaticReconciliation, {
      state: "blocked",
      reason: "root-replaced",
    });
    await assert.rejects(
      subscription.reconcile(),
      /root-replaced|root identity changed/i,
    );
    assert.ok(batches.some((batch) =>
      batch.coverage.state === "uncertain" && batch.coverage.reason === "root-replaced"));
  } finally {
    await subscription?.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("wrapper explicitly recovers a replacement without automatic identity adoption", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-root-recovery-"));
  const root = path.join(parent, "root");
  const movedRoot = path.join(parent, "moved-root");
  fs.mkdirSync(path.join(root, "old", "deep"), { recursive: true });
  let subscription;
  try {
    const batches = [];
    subscription = await subscribe(root, (batch) => batches.push(batch), {
      batchWindowMs: 5,
      automaticReconciliation: true,
    });
    const original = subscription.rootState;
    fs.renameSync(root, movedRoot);
    fs.mkdirSync(path.join(root, "new", "deep"), { recursive: true });
    await waitFor(
      () => batches.some((batch) => batch.rootState.attachment === "lost"),
      "lost root state was not observable",
    );
    assert.deepEqual(subscription.automaticReconciliation, {
      state: "blocked",
      reason: "root-replaced",
    });

    const refused = await subscription.recoverRoot({ identityPolicy: "original-only" });
    assert.equal(refused.attachment, "not-attached");
    assert.equal(refused.reason, "replacement-not-accepted");
    assert.equal(refused.boundarySequence, null);
    assert.equal(subscription.rootState.attachment, "lost");
    assert.deepEqual(subscription.automaticReconciliation, {
      state: "blocked",
      reason: "root-replaced",
    });

    const recovered = await subscription.recoverRoot({
      identityPolicy: "accept-replacement",
    });
    assert.equal(recovered.attachment, "replacement-adopted");
    assert.notDeepEqual(recovered.currentRootState.identity, original.identity);
    assert.equal(recovered.currentRootState.generation, 1n);
    assert.equal(recovered.currentRootState.attachment, "attached");
    assert.equal(recovered.exclusionGeneration, 0n);
    assert.deepEqual(recovered.coverage, { state: "complete" });
    assert.equal(typeof recovered.boundarySequence, "bigint");
    assert.ok(Object.isFrozen(recovered));
    assert.ok(Object.isFrozen(recovered.currentRootState));
    assert.ok(Object.isFrozen(recovered.currentRootState.identity));
    assert.deepEqual(subscription.automaticReconciliation, { state: "idle" });
    await assert.rejects(
      subscription.recoverRoot({ identityPolicy: "accept-replacement" }),
      /root identity is still attached/i,
    );
    assert.deepEqual(subscription.automaticReconciliation, { state: "idle" });
    await waitFor(
      () => batches.some((batch) => batch.sequence === recovered.boundarySequence),
      "recovery boundary sequence was not delivered",
    );
    const boundary = batches.find((batch) => batch.sequence === recovered.boundarySequence);
    assert.deepEqual(boundary.invalidatedPaths, [root]);
    assert.deepEqual(boundary.rootState, recovered.currentRootState);
    assert.deepEqual(boundary.coverage, recovered.coverage);

    const sentinel = path.join(root, "new", "deep", "sentinel.txt");
    fs.writeFileSync(sentinel, "sentinel");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(sentinel)),
      "post-recovery deep sentinel was not delivered",
    );
    assert.equal(capabilities.rootReplacementRecovery, true);
    assert.throws(() => subscription.recoverRoot(null), /options must be an object/);
    assert.throws(
      () => subscription.recoverRoot({ identityPolicy: "automatic" }),
      /identityPolicy/,
    );
  } finally {
    await subscription?.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("wrapper joins disposal around reconciliation and rejects later work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-reconcile-dispose-"));
  let subscription;
  try {
    for (let index = 0; index < 768; index += 1) {
      fs.mkdirSync(path.join(root, `dir-${String(index).padStart(4, "0")}`));
    }
    let callbackCount = 0;
    subscription = await subscribe(root, () => {
      callbackCount += 1;
    }, { batchWindowMs: 5 });

    const topologyScansBeforeReconciliation = subscription.stats().topologyScans;
    let reconciliationSettled = false;
    const reconciliationRequest = subscription.reconcile().then(
      (value) => {
        reconciliationSettled = true;
        return value;
      },
      (error) => {
        reconciliationSettled = true;
        throw error;
      },
    );
    const reconciliation = Promise.allSettled([reconciliationRequest]);
    let reconciliationProgressObserved = false;
    await waitFor(
      () => {
        reconciliationProgressObserved =
          !reconciliationSettled &&
          subscription.stats().topologyScans > topologyScansBeforeReconciliation;
        return reconciliationProgressObserved || reconciliationSettled;
      },
      "reconciliation neither began scanning nor settled",
      3_000,
      1,
    );
    assert.equal(
      reconciliationProgressObserved,
      true,
      "reconciliation settled before active scan progress could overlap disposal",
    );
    const disposal = subscription.dispose();
    await Promise.all([disposal, subscription.dispose()]);
    const reconciliationResult = await reconciliation;
    if (reconciliationResult[0].status === "rejected") {
      assert.match(
        reconciliationResult[0].reason.message,
        /disposed|disposing|interrupted|no longer active/i,
      );
    }
    assert.equal(subscription.stats().disposed, true);
    await subscription.dispose();

    const callbacksAtDisposal = callbackCount;
    fs.writeFileSync(path.join(root, "after-disposal.txt"), "after");
    await delay(50);
    assert.equal(callbackCount, callbacksAtDisposal, "callback began after disposal resolved");
    await assert.rejects(
      subscription.reconcile(),
      /disposed|disposing|no longer active/i,
    );
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper validates arguments before entering native code", async () => {
  await assert.rejects(subscribe("", () => {}), /non-empty string/);
  await assert.rejects(subscribe("/tmp", null), /onBatch must be a function/);
});

test("wrapper preserves symlink parent-navigation components for native validation", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-symlink-parent-"));
  const target = path.join(parent, "target");
  const link = path.join(parent, "link");
  fs.mkdirSync(target);
  fs.symlinkSync(target, link);
  const candidate = `${link}${path.sep}..${path.sep}target`;
  let acceptedSubscription;
  let rejection;
  try {
    try {
      acceptedSubscription = await subscribe(candidate, () => {});
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection, "wrapper erased the symlink component before native validation");
    assert.match(rejection.message, /symbolic link/);
  } finally {
    await acceptedSubscription?.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("non-UTF-8 child paths preserve bytes and collapse the string invalidation to root", async () => {
  const previousCwd = process.cwd();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-bytes-"));
  const relativeRoot = "root";
  const root = path.join(parent, relativeRoot);
  fs.mkdirSync(root);
  let subscription;
  try {
    process.chdir(parent);
    const batches = [];
    subscription = await subscribe(relativeRoot, (batch) => batches.push(batch), {
      batchWindowMs: 8,
    });
    process.chdir(previousCwd);
    const exactPath = Buffer.concat([
      Buffer.from(`${root}${path.sep}`),
      Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74]),
    ]);
    fs.writeFileSync(exactPath, "bytes");
    const deadline = Date.now() + 3_000;
    while (batches.length === 0 && Date.now() < deadline) await delay(10);

    assert.ok(batches.some((batch) => batch.pathEncodingCollapsed));
    assert.ok(batches.some((batch) => batch.invalidatedPaths.includes(root)));
    assert.ok(
      batches.some((batch) =>
        batch.invalidatedPathBytes.some((bytes) => Buffer.from(bytes).equals(exactPath)),
      ),
    );
  } finally {
    process.chdir(previousCwd);
    await subscription?.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a callback that captures its subscription does not defeat GC cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-cycle-"));
  const wrapperUrl = new URL("../index.js", import.meta.url).href;
  const source = `
    import fs from "node:fs";
    import path from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    import { subscribe } from ${JSON.stringify(wrapperUrl)};
    let liveCallbacks = 0;
    const liveSubscription = await subscribe(
      ${JSON.stringify(root)},
      () => { liveCallbacks += 1; },
      { batchWindowMs: 5 },
    );
    for (let index = 0; index < 10; index += 1) global.gc();
    fs.writeFileSync(path.join(${JSON.stringify(root)}, "live.txt"), "change");
    const callbackDeadline = Date.now() + 1_000;
    while (liveCallbacks === 0 && Date.now() < callbackDeadline) await delay(10);
    if (liveCallbacks === 0) throw new Error("live subscription lost its callback holder");
    await liveSubscription.dispose();

    async function createSubscription() {
      const subscription = await subscribe(
        ${JSON.stringify(root)},
        () => subscription.stats(),
      );
      return subscription;
    }
    let subscription = await createSubscription();
    subscription = null;
    for (let index = 0; index < 40; index += 1) {
      global.gc();
      await delay(10);
    }
  `;
  const child = spawn(
    process.execPath,
    ["--expose-gc", "--input-type=module", "--eval", source],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("callback/subscription cycle kept the child process alive"));
      }, 3_000);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.deepEqual(result, { code: 0, signal: null }, stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
