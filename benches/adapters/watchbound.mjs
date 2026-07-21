import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  WATCHBOUND_ADAPTER_LABEL,
  WATCHBOUND_BUILD_COMMAND,
} from "../lib/watchbound-identity.mjs";

const require = createRequire(import.meta.url);
const subscriptionOptions = Object.freeze({
  batchWindowMs: 10,
  maxBatchPaths: 1_024,
  outputQueueCapacity: 64,
});
const publicSubscriptionOperations = Object.freeze({
  reconcile: reconcileExistingSubscription,
  recoverRoot: recoverExistingSubscriptionRoot,
});

export const id = "watchbound";

function jsonCounter(value) {
  if (typeof value === "bigint") return value.toString();
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

export function advertisesReconciliation(wrapperCapabilities, operations) {
  const features = wrapperCapabilities?.features ?? wrapperCapabilities;
  return (
    features?.reconciliation === true &&
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

export async function recoverExistingSubscriptionRoot(subscription, identityPolicy) {
  if (typeof subscription?.recoverRoot !== "function") {
    throw new TypeError("The public subscription does not expose root recovery");
  }
  return jsonRootRecoveryResult(
    await subscription.recoverRoot({ identityPolicy }),
  );
}

function jsonRootIdentity(identity) {
  if (identity == null) return null;
  return {
    device: jsonCounter(identity.device),
    inode: jsonCounter(identity.inode),
  };
}

function jsonRootState(state) {
  if (state == null) return null;
  return {
    generation: jsonCounter(state.generation),
    identity: jsonRootIdentity(state.identity),
    attachment: state.attachment,
    lossEvidence: state.lossEvidence ?? null,
  };
}

function jsonRootRecoveryResult(result) {
  return {
    attachment: result?.attachment ?? null,
    reason: result?.reason ?? null,
    previousRootState: jsonRootState(result?.previousRootState),
    candidateIdentity: jsonRootIdentity(result?.candidateIdentity),
    currentRootState: jsonRootState(result?.currentRootState),
    exclusionGeneration: jsonCounter(result?.exclusionGeneration),
    coverage: result?.coverage ?? null,
    boundarySequence: jsonCounter(result?.boundarySequence),
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
      reason: "Could not load the local Watchbound native binding; run pnpm build:node first",
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
  const metadata = createAdapterMetadata(implementation, nativeArtifact);
  const nativeCapabilities = implementation.capabilities;
  const nativeFeatures = nativeCapabilities.features;
  const capabilities = {
    platform: "linux",
    recursiveDirectoryTree: nativeFeatures.recursive,
    directoryOnlyKernelWatches: true,
    publicWatchCount: true,
    nativeEventBatching: true,
    movedInSubtreeDiscovery: nativeFeatures.movedInTreeDiscovery,
    rootReplacementRecovery:
      nativeFeatures.rootReplacementRecovery === true &&
      typeof publicSubscriptionOperations.recoverRoot === "function",
    staticExclusions: false,
    dynamicExclusions: {
      supported: nativeFeatures.dynamicExclusions,
      atomic: nativeFeatures.dynamicExclusions,
      reason: nativeFeatures.dynamicExclusions
        ? null
        : "Generation-based atomic exclusions are unavailable",
    },
    explicitCoverage: true,
    explicitWatchLimits: nativeFeatures.explicitWatchLimits,
    overflowReporting: nativeFeatures.overflowReporting,
    supervisedOverflow: process.platform === "linux",
    consumerBackpressureReporting: true,
    reconciliation: advertisesReconciliation(
      nativeCapabilities,
      publicSubscriptionOperations,
    ),
    automaticReconciliation:
      nativeFeatures.automaticReconciliation === true,
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
      automaticReconciliation = false,
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
            rootState: jsonRootState(batch.rootState),
          });
        },
        {
          watchLimit: maxWatches,
          batchWindowMs,
          maxBatchPaths,
          outputQueueCapacity,
          automaticReconciliation,
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
      if (
        capabilities.rootReplacementRecovery &&
        typeof subscription.recoverRoot !== "function"
      ) {
        await subscription.dispose();
        throw new TypeError(
          "Watchbound advertised root replacement recovery but the public subscription method is unavailable",
        );
      }

      let exclusionGeneration = 0n;
      const operationEvidence = {
        publicSubscriptionCreations: 1,
        automaticReconciliationEnabled: automaticReconciliation !== false,
        reconciliationCalls: 0,
        reconciliationCallsOnOriginalSubscription: 0,
        rootRecoveryCalls: 0,
        rootRecoveryCallsOnOriginalSubscription: 0,
        disposalRequests: 0,
      };
      return {
        coverage: subscription.initialCoverage,
        operationEvidence: () => ({ ...operationEvidence }),
        get exclusionGeneration() {
          return jsonCounter(subscription.exclusionGeneration);
        },
        get automaticReconciliation() {
          const status = subscription.automaticReconciliation;
          return {
            ...status,
            ...(status.exclusionGeneration === undefined
              ? {}
              : { exclusionGeneration: jsonCounter(status.exclusionGeneration) }),
          };
        },
        get rootState() {
          return jsonRootState(subscription.rootState);
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
        recoverRoot(identityPolicy) {
          operationEvidence.rootRecoveryCalls += 1;
          operationEvidence.rootRecoveryCallsOnOriginalSubscription += 1;
          return recoverExistingSubscriptionRoot(subscription, identityPolicy);
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

export function createAdapterMetadata(implementation, nativeArtifact) {
  return {
    id,
    label: WATCHBOUND_ADAPTER_LABEL,
    engineVersion: implementation.capabilities.versions.engine,
    binding:
      `napi-rs / Node-API ${implementation.capabilities.build.nodeApi}`,
    nativeArtifact,
    build: {
      expectedProfile: implementation.capabilities.build.profile,
      targetTriple: implementation.capabilities.build.targetTriple,
      command: WATCHBOUND_BUILD_COMMAND,
      nativeLibraryOverride: null,
    },
    subscriptionOptions,
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
