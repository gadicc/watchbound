import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { capabilities, createEngine, subscribe } from "../index.js";

function observedProjection(batch, initialCoverage, initialRootState) {
  return batch === undefined
    ? {
        sequence: 0n,
        exclusionGeneration: 0n,
        rootState: initialRootState,
        coverage: initialCoverage,
      }
    : {
        sequence: batch.sequence,
        exclusionGeneration: batch.exclusionGeneration,
        rootState: batch.rootState,
        coverage: batch.coverage,
      };
}

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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

    assert.equal(capabilities.features.recursive, true);
    assert.equal(capabilities.features.dynamicExclusions, true);
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
    assert.equal(batches[0].pathEncoding, "complete");
    assert.equal(batches[0].pathEncodingCollapsed, false);
    await Promise.all([subscription.dispose(), subscription.dispose()]);
    assert.equal(subscription.stats().disposed, true);
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolve-physical roots stay anchored across alias mutation at the native boundary", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-symlink-root-"));
  const physical = path.join(parent, "physical");
  const alternate = path.join(parent, "alternate");
  const aliases = path.join(parent, "aliases");
  const alternateAliases = path.join(parent, "alternate-aliases");
  const outer = path.join(parent, "outer");
  const moved = path.join(parent, "moved");
  fs.mkdirSync(path.join(physical, "nested"), { recursive: true });
  fs.mkdirSync(path.join(physical, "repo", "visible"), { recursive: true });
  fs.mkdirSync(path.join(physical, "repo", "hidden", "deep"), { recursive: true });
  fs.mkdirSync(path.join(physical, "repo", ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(alternate, "nested"), { recursive: true });
  fs.mkdirSync(path.join(alternate, "repo", "visible"), { recursive: true });
  fs.mkdirSync(aliases);
  fs.mkdirSync(alternateAliases);
  fs.symlinkSync(path.join(physical, "nested"), path.join(aliases, "inner"));
  fs.symlinkSync(path.join(alternate, "nested"), path.join(alternateAliases, "inner"));
  fs.symlinkSync(aliases, outer);
  const lexicalRoot = `${outer}${path.sep}inner${path.sep}..${path.sep}repo`;
  const physicalRoot = path.join(physical, "repo");
  const alternateRoot = path.join(alternate, "repo");
  const batches = [];
  const engine = createEngine({ nativeWatchBudget: 8 });
  let subscription;
  try {
    await assert.rejects(
      engine.subscribe(lexicalRoot, () => {}, { rootPathPolicy: "strict" }),
      (error) => error.code === "WATCHBOUND_INVALID_ARGUMENT" && !error.retryable,
    );
    subscription = await engine.subscribe(lexicalRoot, (batch) => batches.push(batch), {
      rootPathPolicy: "resolve-physical",
      initialExclusions: ["hidden"],
      observedExcludedPaths: [".git"],
      batchWindowMs: 5,
    });
    assert.equal(subscription.resolvedRoot.policy, "resolve-physical");
    assert.equal(subscription.resolvedRoot.lexicalPath, lexicalRoot);
    assert.equal(subscription.resolvedRoot.physicalPath, physicalRoot);
    assert.equal(subscription.resolvedRoot.pathForm, "physical");
    assert.equal(subscription.resolvedRoot.aliasTracking, "establishment-snapshot");
    assert.deepEqual(subscription.resolvedRoot.identity, subscription.initialRootState.identity);
    assert.deepEqual(
      Buffer.from(subscription.resolvedRoot.lexicalPathBytes),
      Buffer.from(lexicalRoot),
    );
    assert.deepEqual(
      Buffer.from(subscription.resolvedRoot.physicalPathBytes),
      Buffer.from(physicalRoot),
    );

    const hidden = path.join(physicalRoot, "hidden", "deep", "ignored");
    fs.writeFileSync(hidden, "ignored");
    const visible = path.join(physicalRoot, "visible", "delivered");
    fs.writeFileSync(visible, "delivered");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(visible)),
      "the canonical physical path was not delivered",
    );
    assert.ok(batches.every((batch) => !batch.invalidatedPaths.includes(hidden)));
    assert.ok(batches.every((batch) => batch.invalidatedPaths.every(
      (invalidated) => invalidated === physicalRoot || invalidated.startsWith(`${physicalRoot}/`),
    )));

    fs.rmSync(path.join(physicalRoot, ".git"), { recursive: true });
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(path.join(physicalRoot, ".git"))),
      "the observed boundary was not projected into the physical namespace",
    );
    await assert.rejects(
      subscription.replaceExclusions(1n, ["../escape"]),
      (error) => error.code === "WATCHBOUND_INVALID_ARGUMENT" && !error.retryable,
    );
    assert.equal(subscription.exclusionGeneration, 0n);

    fs.unlinkSync(outer);
    const whileMissing = path.join(physicalRoot, "visible", "alias-missing");
    fs.writeFileSync(whileMissing, "change");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(whileMissing)),
      "removing the lexical ancestor detached physical coverage",
    );
    fs.symlinkSync(alternateAliases, outer);
    const ignoredRetarget = path.join(alternateRoot, "visible", "not-covered");
    fs.writeFileSync(ignoredRetarget, "ignored");
    const stillCovered = path.join(physicalRoot, "visible", "still-covered");
    fs.writeFileSync(stillCovered, "change");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(stillCovered)),
      "retargeting the lexical ancestor moved physical coverage",
    );
    assert.ok(batches.every((batch) => !batch.invalidatedPaths.includes(ignoredRetarget)));
    assert.equal(subscription.rootState.attachment, "attached");
    await assert.rejects(
      subscription.recoverRoot({ identityPolicy: "accept-replacement" }),
      (error) => error.code === "WATCHBOUND_ROOT_STATE_CONFLICT" && error.retryable,
    );

    fs.renameSync(physicalRoot, moved);
    await waitFor(
      () => subscription.rootState.attachment === "lost",
      "the captured physical root loss was not observed",
    );
    const missing = await subscription.recoverRoot({
      identityPolicy: "accept-replacement",
    });
    assert.equal(missing.attachment, "not-attached");
    assert.equal(missing.reason, "candidate-missing");
    assert.equal(missing.candidateIdentity, undefined);
    fs.renameSync(moved, physicalRoot);
    const restored = await subscription.recoverRoot({ identityPolicy: "original-only" });
    assert.equal(restored.attachment, "original-restored");
    assert.equal(restored.currentRootState.attachment, "attached");
  } finally {
    await subscription?.dispose();
    if (subscription !== undefined) assert.equal(subscription.stats().disposed, true);
    await waitFor(
      () => engine.runtimeStats().nativeWatches === 0,
      "resolved-root disposal leaked native watches",
    );
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("non-UTF-8 physical roots expose bytes-only invalidations across alias retargeting", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-byte-root-"));
  const physicalRoot = Buffer.concat([
    Buffer.from(`${parent}${path.sep}physical-`),
    Buffer.from([0xff]),
  ]);
  const alias = path.join(parent, "alias");
  const alternate = path.join(parent, "alternate");
  fs.mkdirSync(physicalRoot);
  fs.mkdirSync(alternate);
  fs.symlinkSync(physicalRoot, alias);
  const engine = createEngine({ nativeWatchBudget: 4 });
  const batches = [];
  let subscription;
  try {
    subscription = await engine.subscribe(alias, (batch) => batches.push(batch), {
      rootPathPolicy: "resolve-physical",
      batchWindowMs: 5,
    });
    assert.equal(subscription.resolvedRoot.physicalPath, null);
    assert.ok(
      Buffer.from(subscription.resolvedRoot.physicalPathBytes).equals(physicalRoot),
    );

    fs.unlinkSync(alias);
    fs.symlinkSync(alternate, alias);
    const exactChild = Buffer.concat([
      physicalRoot,
      Buffer.from(`${path.sep}child-`),
      Buffer.from([0xfe]),
    ]);
    fs.writeFileSync(exactChild, "physical");
    await waitFor(
      () => batches.some((batch) =>
        batch.invalidatedPathBytes.some((bytes) =>
          Buffer.from(bytes).equals(exactChild))),
      "the exact physical child bytes were not delivered",
    );

    const matching = batches.find((batch) =>
      batch.invalidatedPathBytes.some((bytes) => Buffer.from(bytes).equals(exactChild)));
    assert.equal(matching.pathEncoding, "bytes-only");
    assert.equal(matching.pathEncodingCollapsed, true);
    assert.deepEqual(matching.invalidatedPaths, []);
    assert.ok(!matching.invalidatedPaths.includes(alias));
    assert.equal(subscription.rootState.attachment, "attached");

    const alternateChild = path.join(alternate, "not-covered");
    fs.writeFileSync(alternateChild, "alternate");
    await waitForQuiet(() => batches.length);
    assert.ok(batches.every((batch) =>
      !batch.invalidatedPaths.includes(alias) &&
      !batch.invalidatedPaths.includes(alternateChild)));
  } finally {
    await subscription?.dispose();
    await waitFor(
      () => engine.runtimeStats().nativeWatches === 0,
      "bytes-only root disposal leaked native watches",
    );
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("promise-like callbacks are serialized and async rejections are counted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-async-callback-"));
  const firstRelease = deferred();
  const firstEntered = deferred();
  const entered = [];
  const completed = [];
  const unhandled = [];
  let active = 0;
  let maxActive = 0;
  let stableContext;
  let subscription;
  const onUnhandledRejection = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    subscription = await subscribe(root, async (batch, context) => {
      assert.equal(Object.isFrozen(context), true);
      assert.equal(context.signal instanceof AbortSignal, true);
      assert.equal(typeof context.stop, "function");
      stableContext ??= context;
      assert.equal(context, stableContext);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const ordinal = entered.push(batch.sequence);
      if (ordinal === 1) {
        firstEntered.resolve();
        await firstRelease.promise;
      }
      active -= 1;
      completed.push(batch.sequence);
      if (ordinal === 2) throw new Error("intentional async callback failure");
    }, { batchWindowMs: 5, outputQueueCapacity: 4 });

    fs.writeFileSync(path.join(root, "first.txt"), "first");
    await firstEntered.promise;
    fs.writeFileSync(path.join(root, "second.txt"), "second");
    await delay(75);
    assert.equal(entered.length, 1, "a later callback overlapped the pending callback");

    firstRelease.resolve();
    await waitFor(() => entered.length >= 2, "the callback following settlement did not run");
    await waitFor(
      () => subscription.stats().callbackErrors === 1n,
      "async callback rejection was not counted",
    );
    await delay(25);
    assert.equal(maxActive, 1);
    assert.deepEqual(completed, entered);
    assert.deepEqual(unhandled, []);
  } finally {
    firstRelease.resolve();
    await subscription?.dispose();
    process.off("unhandledRejection", onUnhandledRejection);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a pending async callback does not block a same-environment peer", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-async-peer-"));
  const firstRoot = path.join(parent, "first");
  const peerRoot = path.join(parent, "peer");
  fs.mkdirSync(firstRoot);
  fs.mkdirSync(peerRoot);
  const release = deferred();
  const entered = deferred();
  const peerObserved = deferred();
  let first;
  let peer;
  try {
    first = await subscribe(firstRoot, async () => {
      entered.resolve();
      await release.promise;
    }, { batchWindowMs: 5 });
    peer = await subscribe(peerRoot, () => {
      peerObserved.resolve();
    }, { batchWindowMs: 5 });

    fs.writeFileSync(path.join(firstRoot, "first.txt"), "first");
    await entered.promise;
    fs.writeFileSync(path.join(peerRoot, "peer.txt"), "peer");
    await Promise.race([
      peerObserved.promise,
      delay(3_000).then(() => {
        assert.fail("a pending async callback blocked its same-environment peer");
      }),
    ]);
  } finally {
    release.resolve();
    await Promise.all([first?.dispose(), peer?.dispose()]);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("dispose aborts callback context and joins pending callback completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-callback-dispose-"));
  const entered = deferred();
  let callbackCompleted = false;
  let callbackContext;
  let subscription;
  try {
    subscription = await subscribe(root, async (_batch, context) => {
      callbackContext = context;
      entered.resolve();
      if (!context.signal.aborted) {
        await new Promise((resolve) => {
          context.signal.addEventListener("abort", resolve, { once: true });
        });
      }
      callbackCompleted = true;
    }, { batchWindowMs: 5 });

    fs.writeFileSync(path.join(root, "changed.txt"), "change");
    await entered.promise;
    const disposal = subscription.dispose();
    assert.equal(callbackContext.signal.aborted, true);
    await disposal;
    assert.equal(callbackCompleted, true);
    assert.equal(subscription.stats().disposed, true);
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("callback context is stable and stop requests idempotent disposal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-callback-stop-"));
  const contexts = [];
  let subscription;
  try {
    subscription = await subscribe(root, (_batch, context) => {
      contexts.push(context);
      context.stop();
      context.stop();
    }, { batchWindowMs: 5 });

    fs.writeFileSync(path.join(root, "changed.txt"), "change");
    await waitFor(() => contexts.length === 1, "the stopping callback did not run");
    await waitFor(() => subscription.stats().disposed, "callback stop did not dispose");
    assert.equal(contexts[0].signal.aborted, true);
    await subscription.dispose();

    fs.writeFileSync(path.join(root, "after-stop.txt"), "after");
    await delay(50);
    assert.equal(contexts.length, 1);
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("observedState mirrors only the initial baseline or the last entered callback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-observed-state-"));
  let subscription;
  try {
    const batches = [];
    const observedInsideCallbacks = [];
    let callbackCount = 0;
    subscription = await subscribe(root, (batch) => {
      observedInsideCallbacks.push(subscription.observedState);
      batches.push(batch);
      callbackCount += 1;
      if (callbackCount === 1) throw new Error("intentional observed-state callback failure");
    }, { batchWindowMs: 8 });

    assert.deepEqual(
      subscription.observedState,
      observedProjection(
        undefined,
        subscription.initialCoverage,
        subscription.initialRootState,
      ),
    );
    assert.equal(Object.isFrozen(subscription.observedState), true);
    assert.equal(Object.isFrozen(subscription.observedState.coverage), true);
    assert.equal(Object.isFrozen(subscription.observedState.rootState), true);
    assert.equal(Object.isFrozen(subscription.observedState.rootState.identity), true);

    const changed = path.join(root, "changed.txt");
    fs.writeFileSync(changed, "change");
    await waitFor(() => batches.length > 0, "observed-state callback did not run");
    await waitFor(
      () => subscription.stats().callbackErrors === 1n,
      "throwing observed-state callback was not accounted",
    );

    const lastBatch = batches.at(-1);
    assert.deepEqual(
      observedInsideCallbacks.at(-1),
      observedProjection(lastBatch, subscription.initialCoverage, subscription.initialRootState),
      "observedState was not advanced before the user callback began",
    );
    assert.deepEqual(
      subscription.observedState,
      observedProjection(lastBatch, subscription.initialCoverage, subscription.initialRootState),
    );

    fs.writeFileSync(path.join(root, "after-callback-error.txt"), "change");
    await waitFor(() => batches.length > 1, "delivery stopped after callback failure");
    assert.deepEqual(
      subscription.observedState,
      observedProjection(
        batches.at(-1),
        subscription.initialCoverage,
        subscription.initialRootState,
      ),
    );
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
    assert.throws(() => subscription.replaceExclusions(3n, null), /prefix array or exclusion-policy object/);
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper applies exact exclusions during initial establishment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-initial-exclusions-"));
  const visible = path.join(root, "visible");
  const hidden = path.join(root, "hidden");
  fs.mkdirSync(path.join(visible, "deep"), { recursive: true });
  fs.mkdirSync(path.join(hidden, "deep"), { recursive: true });
  let subscription;
  try {
    const batches = [];
    subscription = await subscribe(root, (batch) => batches.push(batch), {
      initialExclusions: ["hidden"],
      batchWindowMs: 8,
    });

    assert.equal(capabilities.features.initialExclusions, true);
    assert.equal(subscription.exclusionGeneration, 0n);
    assert.equal(subscription.stats().watchedDirectories, 3);
    fs.writeFileSync(path.join(hidden, "deep", "ignored"), "ignored");
    await delay(30);
    assert.equal(batches.length, 0);

    const changed = path.join(visible, "deep", "changed");
    fs.writeFileSync(changed, "changed");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(changed)),
      "visible change was not delivered after initial exclusion establishment",
    );
    assert.ok(batches.every((batch) => batch.exclusionGeneration === 0n));
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper prunes exact directory names and observes only an excluded boundary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-observed-exclusion-"));
  const git = path.join(root, ".git");
  fs.mkdirSync(path.join(git, "objects", "deep"), { recursive: true });
  fs.mkdirSync(path.join(root, "nested", ".git", "objects"), { recursive: true });
  let subscription;
  try {
    const batches = [];
    subscription = await subscribe(root, (batch) => batches.push(batch), {
      excludedDirectoryNames: [".git"],
      observedExcludedPaths: [".git"],
      batchWindowMs: 8,
    });
    assert.equal(capabilities.features.directoryNameExclusions, true);
    assert.equal(capabilities.features.observedExcludedPaths, true);
    assert.equal(subscription.stats().watchedDirectories, 2);

    fs.writeFileSync(path.join(git, "objects", "deep", "ignored"), "ignored");
    fs.writeFileSync(path.join(root, "nested", ".git", "objects", "ignored"), "ignored");
    await delay(40);
    assert.equal(batches.length, 0);

    fs.rmSync(git, { recursive: true });
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(git)),
      "observed excluded boundary deletion was not delivered",
    );
    assert.ok(
      batches.every((batch) =>
        batch.invalidatedPaths.every((changedPath) =>
          changedPath === git || !changedPath.startsWith(`${git}${path.sep}`))),
      "an excluded descendant leaked through boundary observation",
    );

    batches.length = 0;
    await subscription.replaceExclusions(1n, {
      prefixes: [],
      excludedDirectoryNames: [],
      observedExcludedPaths: [],
    });
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(root)),
      "removing a directory-name exclusion did not conservatively invalidate the root",
    );
    assert.ok(batches.every((batch) => batch.exclusionGeneration === 1n));
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper rejects malformed initial exclusions before establishment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-invalid-initial-exclusions-"));
  try {
    await assert.rejects(
      subscribe(root, () => {}, { initialExclusions: null }),
      /exclusion prefixes must be an array/u,
    );
    await assert.rejects(
      subscribe(root, () => {}, { initialExclusions: [42] }),
      /each exclusion prefix must be a string or Uint8Array/u,
    );
    await assert.rejects(
      subscribe(root, () => {}, { initialExclusions: ["../outside"] }),
      /normalized/u,
    );
    await assert.rejects(
      subscribe(root, () => {}, { excludedDirectoryNames: ["a/b"] }),
      /one non-empty normal path component/u,
    );
    await assert.rejects(
      subscribe(root, () => {}, { observedExcludedPaths: [""] }),
      /must not name the watched root/u,
    );
  } finally {
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
    assert.equal(capabilities.features.reconciliation, true);
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

    assert.equal(capabilities.features.automaticReconciliation, true);
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
      result.status === "rejected" &&
      result.reason.code === "WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT"
    );
    assert.ok(reconciliationConflict, "both concurrent reconciliation requests succeeded");
    assert.equal(reconciliationConflict.reason.name, "WatchboundError");
    assert.equal(reconciliationConflict.reason.operation, "reconcile");
    assert.equal(reconciliationConflict.reason.retryable, true);
    assert.equal(
      reconciliationConflict.reason.retryAfter,
      "topology-transaction-settles",
    );

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
    assert.equal(exclusionConflict.reason.code, "WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT");
    assert.ok(
      ["reconcile", "replace-exclusions"].includes(exclusionConflict.reason.operation),
    );
    assert.equal(exclusionConflict.reason.retryable, true);
    assert.equal(exclusionConflict.reason.retryAfter, "topology-transaction-settles");
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
    await assert.rejects(subscription.reconcile(), (error) => {
      assert.equal(error.name, "WatchboundError");
      assert.equal(error.code, "WATCHBOUND_ROOT_STATE_CONFLICT");
      assert.equal(error.operation, "reconcile");
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfter, "root-state-changes");
      return true;
    });
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
    assert.deepEqual(
      subscription.observedState,
      observedProjection(
        batches.at(-1),
        subscription.initialCoverage,
        subscription.initialRootState,
      ),
      "operation acknowledgement advanced observedState ahead of callback delivery",
    );
    if (subscription.observedState.sequence === recovered.boundarySequence) {
      assert.ok(
        batches.some((batch) => batch.sequence === recovered.boundarySequence),
        "observedState credited the recovery boundary before its callback",
      );
    }
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
    assert.deepEqual(
      subscription.observedState,
      observedProjection(
        batches.at(-1),
        subscription.initialCoverage,
        subscription.initialRootState,
      ),
    );

    const sentinel = path.join(root, "new", "deep", "sentinel.txt");
    fs.writeFileSync(sentinel, "sentinel");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(sentinel)),
      "post-recovery deep sentinel was not delivered",
    );
    assert.equal(capabilities.features.rootReplacementRecovery, true);
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
      assert.ok(
        [
          "WATCHBOUND_OPERATION_INTERRUPTED",
          "WATCHBOUND_SUBSCRIPTION_CLOSED",
        ].includes(reconciliationResult[0].reason.code),
      );
      assert.equal(reconciliationResult[0].reason.operation, "reconcile");
      assert.equal(reconciliationResult[0].reason.retryable, false);
    }
    assert.equal(subscription.stats().disposed, true);
    await subscription.dispose();

    const callbacksAtDisposal = callbackCount;
    fs.writeFileSync(path.join(root, "after-disposal.txt"), "after");
    await delay(50);
    assert.equal(callbackCount, callbacksAtDisposal, "callback began after disposal resolved");
    await assert.rejects(subscription.reconcile(), (error) => {
      assert.equal(error.code, "WATCHBOUND_SUBSCRIPTION_CLOSED");
      assert.equal(error.operation, "reconcile");
      assert.equal(error.retryable, false);
      return true;
    });
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper validates arguments before entering native code", async () => {
  await assert.rejects(subscribe("", () => {}), (error) => {
    assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
    assert.equal(error.operation, "subscribe");
    return true;
  });
  await assert.rejects(subscribe("/tmp", null), (error) => {
    assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
    assert.equal(error.operation, "subscribe");
    return true;
  });
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
    assert.ok(batches.some((batch) => batch.pathEncoding === "root-collapsed"));
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

test("callback cycles and retained pending promises do not defeat GC cleanup", async () => {
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

    let asyncCallbacks = 0;
    globalThis.retainedPending = new Promise(() => {});
    let asyncSubscription = await subscribe(
      ${JSON.stringify(root)},
      (_batch, context) => {
        asyncCallbacks += 1;
        globalThis.retainedContext = context;
        return globalThis.retainedPending;
      },
      { batchWindowMs: 5 },
    );
    fs.writeFileSync(path.join(${JSON.stringify(root)}, "async.txt"), "change");
    const asyncDeadline = Date.now() + 1_000;
    while (asyncCallbacks === 0 && Date.now() < asyncDeadline) await delay(10);
    if (asyncCallbacks === 0) throw new Error("pending callback did not enter");
    asyncSubscription = null;
    for (let index = 0; index < 60; index += 1) {
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
        reject(new Error("callback ownership kept the child process alive"));
      }, 5_000);
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
