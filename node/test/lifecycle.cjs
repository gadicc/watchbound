"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const binding = require("../index.js");

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}

test("native bridge catches callback exceptions and remains usable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-error-"));
  let subscription;
  try {
    let callbacks = 0;
    subscription = await binding.subscribe(root, { batchWindowMs: 8 }, () => {
      callbacks += 1;
      if (callbacks === 1) throw new Error("intentional callback failure");
    });

    fs.writeFileSync(path.join(root, "first.txt"), "first");
    await waitFor(() => callbacks === 1, "first callback did not run");
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
