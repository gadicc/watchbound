export function initializeObservedState(holder, initialCoverage, initialRootState) {
  holder.observedState ??= createObservedState(
    0n,
    0n,
    initialRootState,
    initialCoverage,
  );
  return holder.observedState;
}

export function recordObservedBatch(holder, batch) {
  holder.observedState = createObservedState(
    batch.sequence,
    batch.exclusionGeneration,
    batch.rootState,
    batch.coverage,
  );
  return holder.observedState;
}

function createObservedState(sequence, exclusionGeneration, rootState, coverage) {
  return Object.freeze({
    sequence,
    exclusionGeneration,
    rootState,
    coverage,
  });
}
