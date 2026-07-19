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
        assert.match(rejection.message, new RegExp(option));
      }
    }
  } finally {
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
