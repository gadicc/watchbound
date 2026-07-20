import path from "node:path";
import { nowMs, sleep } from "./metrics.mjs";

function normalizedPath(root, value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return path.resolve(root, value);
}

function normalizedCounter(value) {
  if (typeof value === "bigint") return value.toString();
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)) {
    return BigInt(value).toString();
  }
  return null;
}

function coverageSnapshot(coverage) {
  return coverage == null ? null : { ...coverage };
}

function rootStateSnapshot(state) {
  if (state == null) return null;
  return {
    generation: normalizedCounter(state.generation),
    identity: state.identity == null
      ? null
      : {
          device: normalizedCounter(state.identity.device),
          inode: normalizedCounter(state.identity.inode),
        },
    attachment: state.attachment ?? null,
    lossEvidence: state.lossEvidence ?? null,
  };
}

export function createRecorder(root) {
  const batches = [];
  const resolvedRoot = path.resolve(root);

  function onBatch(batch) {
    const atMs = nowMs();
    const paths = (Array.isArray(batch?.paths) ? batch.paths : [])
      .map((value) => normalizedPath(root, value))
      .filter(Boolean);
    const details = (Array.isArray(batch?.details) ? batch.details : []).map((detail) => ({
      path: normalizedPath(root, detail?.path),
      type: detail?.type ?? null,
    }));
    batches.push({
      atMs,
      sequence: normalizedCounter(batch?.sequence),
      exclusionGeneration: normalizedCounter(batch?.exclusionGeneration),
      paths,
      details,
      invalidated: Boolean(batch?.invalidated),
      rawEventCount: Number.isInteger(batch?.rawEventCount)
        ? batch.rawEventCount
        : paths.length,
      error: batch?.error
        ? { code: batch.error.code ?? null, message: batch.error.message ?? String(batch.error) }
        : null,
      coverage: coverageSnapshot(batch?.coverage),
      rootState: rootStateSnapshot(batch?.rootState),
    });
  }

  function checkpoint(referenceAtMs = nowMs()) {
    return { batchIndex: batches.length, atMs: referenceAtMs };
  }

  function selected(checkpointValue) {
    return batches.slice(checkpointValue.batchIndex);
  }

  function evidence(batch) {
    return {
      atMs: batch.atMs,
      sequence: batch.sequence,
      exclusionGeneration: batch.exclusionGeneration,
      paths: [...batch.paths],
      details: batch.details.map((detail) => ({ ...detail })),
      invalidated: batch.invalidated,
      rawEventCount: batch.rawEventCount,
      error: batch.error == null ? null : { ...batch.error },
      coverage: coverageSnapshot(batch.coverage),
      rootState: rootStateSnapshot(batch.rootState),
    };
  }

  function batchesSince(checkpointValue) {
    return selected(checkpointValue).map(evidence);
  }

  function pathCountSince(checkpointValue, expectedPath) {
    const resolved = path.resolve(root, expectedPath);
    let count = 0;
    for (const batch of selected(checkpointValue)) {
      count += batch.paths.filter((candidate) => candidate === resolved).length;
    }
    return count;
  }

  async function waitForQuiet(quietMs, maximumMs = quietMs * 5) {
    const deadline = nowMs() + maximumMs;
    let observedLength = batches.length;
    while (nowMs() < deadline) {
      await sleep(quietMs);
      if (batches.length === observedLength) return true;
      observedLength = batches.length;
    }
    return false;
  }

  function summary(checkpointValue, expectedPaths = []) {
    const observed = selected(checkpointValue);
    const presentSequences = observed
      .map((batch) => batch.sequence)
      .filter((value) => value != null);
    const presentExclusionGenerations = observed
      .map((batch) => batch.exclusionGeneration)
      .filter((value) => value != null);
    const sequencesStrictlyMonotonic =
      presentSequences.length === observed.length &&
      presentSequences.every((value, index) =>
        index === 0 || BigInt(value) > BigInt(presentSequences[index - 1])
      );
    const rootBoundaries = observed
      .filter((batch) => batch.paths.includes(resolvedRoot))
      .map((batch) => ({
        atMs: batch.atMs,
        sequence: batch.sequence,
        exclusionGeneration: batch.exclusionGeneration,
        coverage: coverageSnapshot(batch.coverage),
      }));
    const resolvedExpected = [...new Set(expectedPaths.map((value) => path.resolve(root, value)))];
    const counts = new Map(resolvedExpected.map((value) => [value, 0]));
    const firstSeenAt = new Map(resolvedExpected.map((value) => [value, null]));
    const typedCounts = {};
    const coverageStates = [];
    const uncertainReasons = [];
    for (const batch of observed) {
      for (const observedPath of batch.paths) {
        if (counts.has(observedPath)) {
          counts.set(observedPath, counts.get(observedPath) + 1);
          if (firstSeenAt.get(observedPath) == null) firstSeenAt.set(observedPath, batch.atMs);
        }
      }
      for (const detail of batch.details) {
        const key = detail.type ?? "untyped";
        typedCounts[key] = (typedCounts[key] ?? 0) + 1;
      }
      if (typeof batch.coverage?.state === "string") {
        coverageStates.push(batch.coverage.state);
        if (batch.coverage.state === "uncertain" && typeof batch.coverage.reason === "string") {
          uncertainReasons.push(batch.coverage.reason);
        }
      }
    }

    const relevantBatches = observed.filter((batch) =>
      batch.paths.some((observedPath) => counts.has(observedPath)),
    );
    const missedPaths = resolvedExpected.filter((value) => counts.get(value) === 0);
    const firstSeenTimes = [...firstSeenAt.values()].filter((value) => value != null);
    const allExpectedAtMs = missedPaths.length === 0 && firstSeenTimes.length > 0
      ? Math.max(...firstSeenTimes)
      : null;
    const duplicateExpectedEvents = [...counts.values()].reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    );
    return {
      sequences: presentSequences,
      allSequencesPresent: presentSequences.length === observed.length,
      sequencesStrictlyMonotonic,
      exclusionGenerations: [...new Set(presentExclusionGenerations)],
      allExclusionGenerationsPresent:
        presentExclusionGenerations.length === observed.length,
      rootBoundaryCount: rootBoundaries.length,
      rootBoundaries,
      expectedPathCount: resolvedExpected.length,
      detectedPathCount: resolvedExpected.length - missedPaths.length,
      missedPathCount: missedPaths.length,
      missedPaths,
      duplicateExpectedEvents,
      callbackCount: observed.length,
      batchCount: observed.length,
      pathEventCount: observed.reduce((sum, batch) => sum + batch.paths.length, 0),
      rawEventCount: observed.reduce((sum, batch) => sum + batch.rawEventCount, 0),
      invalidationCount: observed.filter((batch) => batch.invalidated).length,
      asyncErrors: observed.map((batch) => batch.error).filter(Boolean),
      typedEventCounts: typedCounts,
      coverageStates: [...new Set(coverageStates)],
      uncertainReasons: [...new Set(uncertainReasons)],
      firstCallbackLatencyMs:
        observed.length > 0 ? observed[0].atMs - checkpointValue.atMs : null,
      finalCallbackLatencyMs:
        observed.length > 0 ? observed.at(-1).atMs - checkpointValue.atMs : null,
      firstExpectedLatencyMs:
        relevantBatches.length > 0 ? relevantBatches[0].atMs - checkpointValue.atMs : null,
      finalExpectedLatencyMs:
        allExpectedAtMs == null ? null : allExpectedAtMs - checkpointValue.atMs,
      allExpectedLatencyMs:
        allExpectedAtMs == null ? null : allExpectedAtMs - checkpointValue.atMs,
      lastExpectedCallbackLatencyMs:
        relevantBatches.length > 0 ? relevantBatches.at(-1).atMs - checkpointValue.atMs : null,
    };
  }

  return {
    onBatch,
    checkpoint,
    batchesSince,
    pathCountSince,
    waitForQuiet,
    summary,
    get batchCount() {
      return batches.length;
    },
  };
}
