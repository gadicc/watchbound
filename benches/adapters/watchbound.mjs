import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const subscriptionOptions = Object.freeze({
  batchWindowMs: 10,
  maxBatchPaths: 1_024,
  outputQueueCapacity: 64,
});
const publicSubscriptionOperations = Object.freeze({
  reconcile: reconcileExistingSubscription,
});

export const id = "watchbound";

function jsonCounter(value) {
  if (typeof value === "bigint") return value.toString();
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

export function advertisesReconciliation(wrapperCapabilities, operations) {
  return (
    wrapperCapabilities?.reconciliation === true &&
    typeof operations?.reconcile === "function"
  );
}

export async function reconcileExistingSubscription(subscription) {
  if (typeof subscription?.reconcile !== "function") {
    throw new TypeError("The public subscription does not expose reconciliation");
  }
  const result = await subscription.reconcile();
  const exclusionGeneration = jsonCounter(result?.exclusionGeneration);
  if (exclusionGeneration == null || result?.coverage == null) {
    throw new TypeError("The public reconciliation result is incomplete");
  }
  return {
    exclusionGeneration,
    coverage: result.coverage,
  };
}

export async function loadAdapter() {
  let implementation;
  try {
    implementation = await import("../../js/index.js");
  } catch (error) {
    return {
      id,
      available: false,
      reason: "Could not load the local Watchbound Node-API proof; run pnpm build:node first",
      error: { code: error?.code ?? null, message: error?.message ?? String(error) },
    };
  }

  const nativeArtifact = loadedNativeArtifactIdentity();
  if (nativeArtifact.error) {
    return {
      id,
      available: false,
      reason: "Could not identify exactly one loaded Watchbound native artifact",
      nativeArtifact,
    };
  }
  const metadata = {
    id,
    label: "Watchbound Rust/Node-API feasibility prototype",
    engineVersion: "0.0.0",
    binding: "napi-rs 3.10.5 / Node-API 6",
    nativeArtifact,
    build: {
      expectedProfile: "release",
      command: "pnpm --dir node build",
      nativeLibraryOverride: process.env.NAPI_RS_NATIVE_LIBRARY_PATH ?? null,
    },
    subscriptionOptions,
  };
  const nativeCapabilities = implementation.capabilities;
  const capabilities = {
    platform: "linux",
    recursiveDirectoryTree: nativeCapabilities.recursive,
    directoryOnlyKernelWatches: true,
    publicWatchCount: true,
    nativeEventBatching: true,
    movedInSubtreeDiscovery: nativeCapabilities.movedInTreeDiscovery,
    rootReplacementRecovery: nativeCapabilities.rootReplacementRecovery,
    staticExclusions: false,
    dynamicExclusions: {
      supported: nativeCapabilities.dynamicExclusions,
      atomic: nativeCapabilities.dynamicExclusions,
      reason: nativeCapabilities.dynamicExclusions
        ? null
        : "Generation-based atomic exclusions are unavailable",
    },
    explicitCoverage: true,
    explicitWatchLimits: nativeCapabilities.explicitWatchLimits,
    overflowReporting: nativeCapabilities.overflowReporting,
    supervisedOverflow: process.platform === "linux",
    consumerBackpressureReporting: true,
    reconciliation: advertisesReconciliation(
      nativeCapabilities,
      publicSubscriptionOperations,
    ),
  };

  return {
    id,
    available: true,
    metadata,
    capabilities,
    async subscribe({
      root,
      onBatch,
      maxWatches = 65_536,
      batchWindowMs = subscriptionOptions.batchWindowMs,
      maxBatchPaths = subscriptionOptions.maxBatchPaths,
      outputQueueCapacity = subscriptionOptions.outputQueueCapacity,
    }) {
      const subscription = await implementation.subscribe(
        path.resolve(root),
        (batch) => {
          onBatch({
            sequence: jsonCounter(batch.sequence),
            paths: batch.invalidatedPaths,
            details: batch.invalidatedPaths.map((changedPath) => ({
              path: changedPath,
              type: null,
            })),
            invalidated:
              batch.pathEncodingCollapsed || batch.coverage.state === "uncertain",
            rawEventCount: batch.invalidatedPaths.length,
            coverage: batch.coverage,
            exclusionGeneration: jsonCounter(batch.exclusionGeneration),
          });
        },
        {
          watchLimit: maxWatches,
          batchWindowMs,
          maxBatchPaths,
          outputQueueCapacity,
        },
      );

      if (
        capabilities.reconciliation &&
        !advertisesReconciliation(nativeCapabilities, subscription)
      ) {
        await subscription.dispose();
        throw new TypeError(
          "Watchbound advertised reconciliation but the public subscription method is unavailable",
        );
      }

      let exclusionGeneration = 0n;
      const operationEvidence = {
        publicSubscriptionCreations: 1,
        reconciliationCalls: 0,
        reconciliationCallsOnOriginalSubscription: 0,
        disposalRequests: 0,
      };
      return {
        coverage: subscription.initialCoverage,
        operationEvidence: () => ({ ...operationEvidence }),
        get exclusionGeneration() {
          return jsonCounter(subscription.exclusionGeneration);
        },
        dispose() {
          operationEvidence.disposalRequests += 1;
          return subscription.dispose();
        },
        async updateExclusions(relativeDirectories) {
          exclusionGeneration += 1n;
          return subscription.replaceExclusions(
            exclusionGeneration,
            relativeDirectories,
          );
        },
        reconcile() {
          operationEvidence.reconciliationCalls += 1;
          operationEvidence.reconciliationCallsOnOriginalSubscription += 1;
          return reconcileExistingSubscription(subscription);
        },
        async stats() {
          const stats = subscription.stats();
          return {
            directoryWatches: stats.watchedDirectories,
            deferredDirectories: stats.deferredDirectories,
            rawEvents: Number(stats.rawEvents),
            batchesDelivered: Number(stats.batchesDelivered),
            batchesDropped: Number(stats.batchesDropped),
            topologyScans: Number(stats.topologyScans),
            overflowEvents: Number(stats.overflowEvents),
            callbackErrors: Number(stats.callbackErrors),
            bridgeDeliveryErrors: Number(stats.bridgeDeliveryErrors),
            disposed: stats.disposed,
          };
        },
      };
    },
  };
}

function loadedNativeArtifactIdentity() {
  const candidates = Object.entries(require.cache)
    .filter(([filename, module]) =>
      path.extname(filename) === ".node" &&
      typeof module?.exports?.capabilities === "function"
    )
    .map(([filename]) => fs.realpathSync(filename))
    .sort();
  if (candidates.length === 0) {
    return {
      path: null,
      sha256: null,
      error: "The loaded native Node-API module was not present in require.cache",
    };
  }
  if (candidates.length !== 1) {
    return {
      path: null,
      sha256: null,
      candidates,
      candidateCount: candidates.length,
      error: "More than one loaded native module exported the Watchbound capabilities function",
    };
  }
  const artifactPath = candidates[0];
  const stat = fs.statSync(artifactPath);
  return {
    path: artifactPath,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex"),
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    candidateCount: candidates.length,
  };
}
