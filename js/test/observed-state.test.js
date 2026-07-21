import assert from "node:assert/strict";
import test from "node:test";

import {
  initializeObservedState,
  recordObservedBatch,
} from "../observed-state.js";

const initialCoverage = Object.freeze({ state: "complete" });
const initialRootState = Object.freeze({
  generation: 0n,
  identity: Object.freeze({ device: 1n, inode: 2n }),
  attachment: "attached",
});

test("baseline initialization cannot overwrite a callback observed before subscribe resolves", () => {
  const holder = { observedState: null };
  const earlyBatch = Object.freeze({
    sequence: 1n,
    exclusionGeneration: 0n,
    rootState: initialRootState,
    coverage: initialCoverage,
  });

  const earlyObservedState = recordObservedBatch(holder, earlyBatch);
  const initialized = initializeObservedState(
    holder,
    initialCoverage,
    initialRootState,
  );

  assert.strictEqual(initialized, earlyObservedState);
  assert.strictEqual(holder.observedState, earlyObservedState);
  assert.equal(holder.observedState.sequence, 1n);
});

test("observed state keeps one frozen coherent projection", () => {
  const holder = { observedState: null };
  const baseline = initializeObservedState(holder, initialCoverage, initialRootState);
  assert.deepEqual(baseline, {
    sequence: 0n,
    exclusionGeneration: 0n,
    rootState: initialRootState,
    coverage: initialCoverage,
  });
  assert.equal(Object.isFrozen(baseline), true);

  const batch = Object.freeze({
    sequence: 4n,
    exclusionGeneration: 3n,
    rootState: Object.freeze({ ...initialRootState, generation: 1n }),
    coverage: Object.freeze({ state: "uncertain", reason: "root-replaced" }),
  });
  const observed = recordObservedBatch(holder, batch);
  assert.deepEqual(observed, {
    sequence: 4n,
    exclusionGeneration: 3n,
    rootState: batch.rootState,
    coverage: batch.coverage,
  });
  assert.equal(Object.isFrozen(observed), true);
  assert.strictEqual(holder.observedState, observed);
});
