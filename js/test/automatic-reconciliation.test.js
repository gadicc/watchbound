import assert from "node:assert/strict";
import test from "node:test";

import {
  createAutomaticReconciliationPolicy,
  normalizeAutomaticReconciliation,
} from "../automatic-reconciliation.js";

const complete = Object.freeze({ state: "complete" });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createClock() {
  let nextId = 1;
  const timers = new Map();
  const delays = [];
  return {
    delays,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      delays.push(delayMs);
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    get pending() {
      return timers.size;
    },
    runNext() {
      const entry = timers.entries().next().value;
      assert.ok(entry, "expected a pending policy timer");
      const [id, callback] = entry;
      timers.delete(id);
      callback();
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test("automatic reconciliation is disabled by default and validates finite bounds", () => {
  assert.equal(normalizeAutomaticReconciliation(undefined), null);
  assert.equal(normalizeAutomaticReconciliation(false), null);
  assert.deepEqual(normalizeAutomaticReconciliation(true), {
    maxAttempts: 3,
    initialDelayMs: 25,
    maxDelayMs: 1_000,
  });
  assert.throws(
    () => normalizeAutomaticReconciliation({ maxAttempts: 17 }),
    /maxAttempts.*16/,
  );
  assert.throws(
    () => normalizeAutomaticReconciliation({ initialDelayMs: 9 }),
    /initialDelayMs/,
  );
  assert.throws(
    () => normalizeAutomaticReconciliation({ initialDelayMs: 20, maxDelayMs: 10 }),
    /maxDelayMs.*initialDelayMs/,
  );
});

for (const reason of [
  "event-overflow",
  "topology-race",
  "consumer-backpressure",
]) {
  test(`automatic policy reconciles recoverable ${reason}`, async () => {
    const clock = createClock();
    const calls = [];
    const policy = createAutomaticReconciliationPolicy(
      { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 20 },
      async () => {
        calls.push(reason);
        return { exclusionGeneration: 7n, coverage: complete };
      },
      clock,
    );

    policy.observe({ state: "uncertain", reason });
    policy.observe({ state: "uncertain", reason });
    assert.deepEqual(policy.status(), {
      state: "scheduled",
      reason,
      attempt: 1,
      delayMs: 5,
    });
    assert.equal(clock.pending, 1);
    clock.runNext();
    await flush();

    assert.deepEqual(calls, [reason]);
    assert.deepEqual(policy.status(), {
      state: "recovered",
      reason,
      attempts: 1,
      exclusionGeneration: 7n,
      coverage: complete,
    });
  });
}

test("root replacement cancels pending recovery and is never credited", async () => {
  const clock = createClock();
  let calls = 0;
  const policy = createAutomaticReconciliationPolicy(
    { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 20 },
    async () => {
      calls += 1;
      return { exclusionGeneration: 0n, coverage: complete };
    },
    clock,
  );

  policy.observe({ state: "uncertain", reason: "event-overflow" });
  policy.observe({ state: "uncertain", reason: "root-replaced" });
  assert.equal(clock.pending, 0);
  assert.deepEqual(policy.status(), { state: "blocked", reason: "root-replaced" });
  policy.observe({ state: "uncertain", reason: "consumer-backpressure" });
  await flush();
  assert.equal(calls, 0);
});

test("loss during reconciliation coalesces to one later non-overlapping attempt", async () => {
  const clock = createClock();
  const first = deferred();
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const policy = createAutomaticReconciliationPolicy(
    { maxAttempts: 3, initialDelayMs: 4, maxDelayMs: 16 },
    async () => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 1) await first.promise;
      active -= 1;
      return { exclusionGeneration: 2n, coverage: complete };
    },
    clock,
  );

  policy.observe({ state: "uncertain", reason: "topology-race" });
  clock.runNext();
  await flush();
  assert.equal(calls, 1);
  policy.observe({ state: "uncertain", reason: "event-overflow" });
  policy.observe({ state: "uncertain", reason: "consumer-backpressure" });
  assert.equal(clock.pending, 0);
  first.resolve();
  await flush();
  assert.equal(clock.pending, 1);
  assert.equal(policy.status().attempt, 2);
  clock.runNext();
  await flush();

  assert.equal(calls, 2);
  assert.equal(maximumActive, 1);
  assert.equal(policy.status().state, "recovered");
});

test("a recoverable loss delivered after root enqueue starts a new bounded cycle", async () => {
  const clock = createClock();
  let calls = 0;
  const policy = createAutomaticReconciliationPolicy(
    { maxAttempts: 2, initialDelayMs: 3, maxDelayMs: 6 },
    async () => ({ exclusionGeneration: 0n, coverage: complete, call: ++calls }),
    clock,
  );

  policy.observe({ state: "uncertain", reason: "consumer-backpressure" });
  clock.runNext();
  await flush();
  assert.equal(policy.status().state, "recovered");

  policy.observe({ state: "uncertain", reason: "event-overflow" });
  assert.deepEqual(policy.status(), {
    state: "scheduled",
    reason: "event-overflow",
    attempt: 1,
    delayMs: 3,
  });
  clock.runNext();
  await flush();
  assert.equal(calls, 2);
});

test("retry backoff is exponential, capped, and exhaustion remains terminal", async () => {
  const clock = createClock();
  let calls = 0;
  const policy = createAutomaticReconciliationPolicy(
    { maxAttempts: 4, initialDelayMs: 10, maxDelayMs: 25 },
    async () => {
      calls += 1;
      throw new Error("topology transaction is busy");
    },
    clock,
  );

  policy.observe({ state: "uncertain", reason: "event-overflow" });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    clock.runNext();
    await flush();
  }
  assert.deepEqual(clock.delays, [10, 20, 25, 25]);
  assert.deepEqual(policy.status(), {
    state: "exhausted",
    reason: "event-overflow",
    attempts: 4,
    error: "topology transaction is busy",
  });
  policy.observe({ state: "uncertain", reason: "event-overflow" });
  assert.equal(clock.pending, 0, "sticky uncertainty restarted an exhausted policy");
  assert.equal(calls, 4);
});

test("non-complete reconciliation results are terminal and remain explicit", async () => {
  const clock = createClock();
  const coverage = {
    state: "partial",
    reason: "resource-limit",
    watchedDirectories: 4,
    deferredDirectories: 2,
  };
  const policy = createAutomaticReconciliationPolicy(
    { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 4 },
    async () => ({ exclusionGeneration: 9n, coverage }),
    clock,
  );

  policy.observe({ state: "uncertain", reason: "topology-race" });
  clock.runNext();
  await flush();
  assert.deepEqual(policy.status(), {
    state: "incomplete",
    reason: "topology-race",
    attempts: 1,
    exclusionGeneration: 9n,
    coverage,
  });
  assert.equal(clock.pending, 0);
});

test("disposal cancels timers, joins an active attempt, and prevents later starts", async () => {
  const clock = createClock();
  const activeAttempt = deferred();
  const nativeDisposal = deferred();
  let calls = 0;
  const policy = createAutomaticReconciliationPolicy(
    { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 20 },
    async () => {
      calls += 1;
      await activeAttempt.promise;
      throw new Error("disposed during reconciliation");
    },
    clock,
  );

  policy.observe({ state: "uncertain", reason: "event-overflow" });
  clock.runNext();
  await flush();
  const disposal = policy.dispose(() => nativeDisposal.promise);
  assert.deepEqual(policy.status(), { state: "disposing" });
  policy.observe({ state: "uncertain", reason: "consumer-backpressure" });
  activeAttempt.resolve();
  nativeDisposal.resolve();
  await disposal;
  assert.deepEqual(policy.status(), { state: "disposed" });
  assert.equal(calls, 1);
  assert.equal(clock.pending, 0);

  await policy.dispose(() => {
    throw new Error("idempotent disposal called native twice");
  });
  policy.observe({ state: "uncertain", reason: "topology-race" });
  assert.equal(clock.pending, 0);
});

test("disposal cancels a not-yet-started timer", async () => {
  const clock = createClock();
  let calls = 0;
  const policy = createAutomaticReconciliationPolicy(
    { maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 20 },
    async () => {
      calls += 1;
      return { exclusionGeneration: 0n, coverage: complete };
    },
    clock,
  );
  policy.observe({ state: "uncertain", reason: "consumer-backpressure" });
  await policy.dispose(async () => {});
  assert.equal(clock.pending, 0);
  assert.equal(calls, 0);
  assert.deepEqual(policy.status(), { state: "disposed" });
});
