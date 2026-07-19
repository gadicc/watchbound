import path from "node:path";
import { nowMs, sleep } from "./metrics.mjs";

function normalizedPath(root, value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return path.resolve(root, value);
}

export function createRecorder(root) {
  const batches = [];

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
      paths,
      details,
      invalidated: Boolean(batch?.invalidated),
      rawEventCount: Number.isInteger(batch?.rawEventCount)
        ? batch.rawEventCount
        : paths.length,
      error: batch?.error
        ? { code: batch.error.code ?? null, message: batch.error.message ?? String(batch.error) }
        : null,
      coverage: batch?.coverage ?? null,
    });
  }

  function checkpoint(referenceAtMs = nowMs()) {
    return { batchIndex: batches.length, atMs: referenceAtMs };
  }

  function selected(checkpointValue) {
    return batches.slice(checkpointValue.batchIndex);
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
    pathCountSince,
    waitForQuiet,
    summary,
    get batchCount() {
      return batches.length;
    },
  };
}
