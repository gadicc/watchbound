/* @ts-self-types="./index.d.ts" */

import nativeBinding from "@gadicc/watchbound-node";
import path from "node:path";
import {
  initializeObservedState,
  recordObservedBatch,
} from "./observed-state.js";
import {
  createAutomaticReconciliationPolicy,
  normalizeAutomaticReconciliation,
} from "./automatic-reconciliation.js";
import {
  WatchboundError,
  WatchboundErrorCode,
  WatchboundRetryAfter,
  invalidArgumentError,
  invokeWatchbound,
  isWatchboundError,
  normalizeWatchboundError,
} from "./errors.js";
import {
  WRAPPER_DELIVERY,
  WRAPPER_VERSION,
  buildCapabilities,
  normalizeRuntimeStats,
  qualifyRootCapabilities,
} from "./capabilities.js";
import { establishNativeSubscription } from "./native-establishment.js";
import {
  createSingleCreditDeliveryBuffer,
  normalizePathInvalidations,
} from "./path-delivery.js";

export {
  WatchboundError,
  WatchboundErrorCode,
  WatchboundRetryAfter,
  isWatchboundError,
  normalizeWatchboundError,
};

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const callbackHolders = new WeakMap();
const MAX_NATIVE_INTEGER_OPTION = 4_294_967_295;

nativeBinding.assertWrapperVersion(WRAPPER_VERSION, WRAPPER_DELIVERY);

export const capabilities = invokeWatchbound("create-engine", () =>
  buildCapabilities(
    nativeBinding.capabilities(),
    nativeBinding.bindingMetadata(),
    nativeBinding.nativeDeliveryMetadata(),
    nativeBinding.nativeTargetMatrix(),
  ));

export function qualifyRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw invalidArgumentError("qualify-root", "root must be a non-empty string");
  }
  return invokeWatchbound(
    "qualify-root",
    () => qualifyRootCapabilities(capabilities, root),
  );
}

const automaticReconciliationDisabled = Object.freeze({ state: "disabled" });
let defaultEngine;

export function createEngine(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalidArgumentError("create-engine", "engine options must be an object");
  }
  const nativeWatchBudget = options.nativeWatchBudget ?? null;
  if (
    nativeWatchBudget !== null &&
    (!Number.isSafeInteger(nativeWatchBudget) ||
      nativeWatchBudget < 1 ||
      nativeWatchBudget > MAX_NATIVE_INTEGER_OPTION)
  ) {
    throw invalidArgumentError(
      "create-engine",
      `nativeWatchBudget must be null or an integer from 1 through ${MAX_NATIVE_INTEGER_OPTION}`,
    );
  }

  const nativeEngine = invokeWatchbound(
    "create-engine",
    () => nativeBinding.createEngine(
      nativeWatchBudget === null ? {} : { nativeWatchBudget },
    ),
  );
  return Object.freeze({
    nativeWatchBudget,
    runtimeStats: () => invokeWatchbound(
      "create-engine",
      () => normalizeRuntimeStats(nativeEngine.runtimeStats()),
    ),
    subscribe: (root, onBatch, subscriptionOptions) =>
      subscribeWithEngine(nativeEngine, root, onBatch, subscriptionOptions),
  });
}

export function subscribe(root, onBatch, options = {}) {
  defaultEngine ??= createEngine();
  return defaultEngine.subscribe(root, onBatch, options);
}

/**
 * Subscribe to one recursive directory root.
 *
 * The native boundary preserves exact Linux path bytes. This wrapper also
 * provides string invalidations: if a child path is not valid UTF-8, it
 * conservatively collapses that invalidation to a representable physical root
 * or exposes a bytes-only batch when the physical root itself is not UTF-8.
 */
async function subscribeWithEngine(nativeEngine, root, onBatch, options = {}) {
  if (typeof root !== "string" || root.length === 0) {
    throw invalidArgumentError("subscribe", "root must be a non-empty string");
  }
  if (typeof onBatch !== "function") {
    throw invalidArgumentError("subscribe", "onBatch must be a function");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalidArgumentError("subscribe", "options must be an object");
  }

  const automaticConfig = normalizeAutomaticReconciliation(
    readSubscriptionOption(options, "automaticReconciliation"),
  );
  const nativeOptions = copyNativeSubscriptionOptions(options);

  // Preserve every caller-supplied component for the engine's symlink-ancestry
  // validation. path.resolve(root) would erase `symlink/..` before native code
  // can reject it. The normalized spelling is used only after validation for
  // the wrapper's absolute string invalidations.
  const absoluteRoot = path.isAbsolute(root)
    ? root
    : `${process.cwd()}${path.sep}${root}`;
  const callbackHolder = {
    onBatch,
    observeCoverage: undefined,
    observedState: null,
    abortController: new AbortController(),
    stopRequested: false,
    startDisposal: null,
    context: null,
    outputRoot: undefined,
    deliveryBuffer: null,
  };
  const weakCallbackHolder = new WeakRef(callbackHolder);
  callbackHolder.deliveryBuffer = createSingleCreditDeliveryBuffer({
    deliver(nativeBatch, deliveryId) {
      const holder = weakCallbackHolder.deref();
      if (holder === undefined) {
        nativeBinding.completeDelivery(deliveryId, false, true);
      } else {
        deliverNativeBatch(holder, nativeBatch, deliveryId);
      }
    },
    abandon(_nativeBatch, deliveryId) {
      try {
        nativeBinding.completeDelivery(deliveryId, false, true);
      } catch {
        // Provisional disposal remains responsible for joined native cleanup.
      }
    },
  });
  callbackHolder.context = Object.freeze({
    signal: callbackHolder.abortController.signal,
    stop: createCallbackStop(weakCallbackHolder),
  });
  return establishNativeSubscription({
    nativeEngine,
    root: absoluteRoot,
    options: nativeOptions,
    callback: createNativeCallback(weakCallbackHolder),
    prepareProvisionalDisposal() {
      callbackHolder.abortController.abort();
      callbackHolder.deliveryBuffer.close();
    },
    buildSubscription(nativeSubscription) {
      const automaticPolicy = automaticConfig === null
        ? null
        : createAutomaticReconciliationPolicy(
            automaticConfig,
            () => invokeWatchbound("reconcile", () => nativeSubscription.reconcile()),
          );
      callbackHolder.observeCoverage = automaticPolicy?.observe ?? null;
      const initialCoverage = normalizeCoverage(nativeSubscription.initialCoverage);
      const initialRootState = normalizeRootState(nativeSubscription.initialRootState);
      const resolvedRoot = normalizeResolvedRoot(nativeSubscription.resolvedRoot);
      callbackHolder.outputRoot = resolvedRoot.physicalPath;
      initializeObservedState(callbackHolder, initialCoverage, initialRootState);
      callbackHolder.deliveryBuffer.ready();
      let disposePromise;
      let subscription;
      const beginDispose = () => {
        callbackHolder.abortController.abort();
        return (disposePromise ??= (automaticPolicy
          ? automaticPolicy.dispose(() => invokeWatchbound(
              "dispose",
              () => nativeSubscription.dispose(),
            ))
          : invokeWatchbound("dispose", () => nativeSubscription.dispose())
        ).finally(() => callbackHolders.delete(subscription)));
      };
      callbackHolder.startDisposal = () => {
        void beginDispose().catch(() => {});
      };
      subscription = Object.freeze({
        resolvedRoot,
        initialCoverage,
        initialRootState,
        get observedState() {
          return callbackHolder.observedState;
        },
        get exclusionGeneration() {
          return nativeSubscription.exclusionGeneration;
        },
        get rootState() {
          return normalizeRootState(nativeSubscription.rootState);
        },
        get automaticReconciliation() {
          return automaticPolicy?.status() ?? automaticReconciliationDisabled;
        },
        stats: () => nativeSubscription.stats(),
        replaceExclusions: (generation, exclusions) => {
          if (typeof generation !== "bigint" || generation < 0n) {
            throw invalidArgumentError(
              "replace-exclusions",
              "generation must be a non-negative bigint",
            );
          }
          const encoded = encodeExclusionPolicy(exclusions, "replace-exclusions");
          return invokeWatchbound(
            "replace-exclusions",
            () => nativeSubscription.replaceExclusions(generation, encoded),
          );
        },
        reconcile: () => invokeWatchbound(
          "reconcile",
          () => nativeSubscription.reconcile(),
        ),
        recoverRoot: (recoveryOptions) => {
          const identityPolicy = validateRootRecoveryOptions(recoveryOptions);
          const recover = () => invokeWatchbound(
            "recover-root",
            async () => normalizeRootRecoveryResult(
              await nativeSubscription.recoverRoot(identityPolicy),
            ),
          );
          return automaticPolicy
            ? automaticPolicy.recoverRoot(identityPolicy, recover)
            : recover();
        },
        dispose: beginDispose,
      });
      callbackHolders.set(subscription, callbackHolder);
      if (callbackHolder.stopRequested) callbackHolder.startDisposal();
      return subscription;
    },
  });
}

function readSubscriptionOption(options, name) {
  try {
    return options[name];
  } catch {
    throw invalidArgumentError(
      "subscribe",
      `${name} could not be read`,
    );
  }
}

function copyNativeSubscriptionOptions(options) {
  let initialExclusions;
  let excludedDirectoryNames;
  let observedExcludedPaths;
  let hasInitialExclusions = false;
  let hasExcludedDirectoryNames = false;
  let hasObservedExcludedPaths = false;
  const nativeOptions = {};
  try {
    for (const key of Reflect.ownKeys(options)) {
      if (key === "automaticReconciliation") continue;
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor?.enumerable) continue;
      if (key === "initialExclusions") {
        initialExclusions = options[key];
        hasInitialExclusions = true;
        continue;
      }
      if (key === "excludedDirectoryNames") {
        excludedDirectoryNames = options[key];
        hasExcludedDirectoryNames = true;
        continue;
      }
      if (key === "observedExcludedPaths") {
        observedExcludedPaths = options[key];
        hasObservedExcludedPaths = true;
        continue;
      }
      Object.defineProperty(nativeOptions, key, {
        value: options[key],
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
  } catch {
    throw invalidArgumentError(
      "subscribe",
      "subscription option properties could not be read",
    );
  }
  if (hasInitialExclusions && initialExclusions !== undefined) {
    nativeOptions.initialExclusions = encodeExclusionPrefixes(
      initialExclusions,
      "subscribe",
    );
  }
  if (hasExcludedDirectoryNames && excludedDirectoryNames !== undefined) {
    nativeOptions.excludedDirectoryNames = encodePathInputs(
      excludedDirectoryNames,
      "subscribe",
      "excluded directory names",
    );
  }
  if (hasObservedExcludedPaths && observedExcludedPaths !== undefined) {
    nativeOptions.observedExcludedPaths = encodePathInputs(
      observedExcludedPaths,
      "subscribe",
      "observed excluded paths",
    );
  }
  return nativeOptions;
}

function encodeExclusionPrefixes(prefixes, operation) {
  return encodePathInputs(prefixes, operation, "exclusion prefixes");
}

function encodePathInputs(values, operation, label) {
  if (!Array.isArray(values)) {
    throw invalidArgumentError(
      operation,
      `${label} must be an array of strings or Uint8Array values`,
    );
  }
  return invokeWatchbound(
    operation,
    () => values.map((value) => {
      if (typeof value === "string") return Buffer.from(value);
      if (value instanceof Uint8Array) return Buffer.from(value);
      throw invalidArgumentError(
        operation,
        `each ${label === "exclusion prefixes" ? "exclusion prefix" : label.slice(0, -1)} must be a string or Uint8Array`,
      );
    }),
  );
}

function encodeExclusionPolicy(exclusions, operation) {
  if (Array.isArray(exclusions)) {
    return encodeExclusionPrefixes(exclusions, operation);
  }
  if (exclusions === null || typeof exclusions !== "object") {
    throw invalidArgumentError(
      operation,
      "exclusions must be a prefix array or exclusion-policy object",
    );
  }
  let prefixes;
  let excludedDirectoryNames;
  let observedExcludedPaths;
  try {
    prefixes = exclusions.prefixes;
    excludedDirectoryNames = exclusions.excludedDirectoryNames;
    observedExcludedPaths = exclusions.observedExcludedPaths;
  } catch {
    throw invalidArgumentError(operation, "exclusion policy properties could not be read");
  }
  return {
    prefixes: encodePathInputs(prefixes ?? [], operation, "exclusion prefixes"),
    excludedDirectoryNames: encodePathInputs(
      excludedDirectoryNames ?? [],
      operation,
      "excluded directory names",
    ),
    observedExcludedPaths: encodePathInputs(
      observedExcludedPaths ?? [],
      operation,
      "observed excluded paths",
    ),
  };
}

function createNativeCallback(weakCallbackHolder) {
  return (nativeBatch, deliveryId) => {
    const holder = weakCallbackHolder.deref();
    if (!holder) {
      nativeBinding.completeDelivery(deliveryId, false, true);
      return true;
    }
    holder.deliveryBuffer.accept(nativeBatch, deliveryId);
    // `true` is the private binding protocol marker that transfers exactly-once
    // completion ownership from the raw callback bridge to this wrapper.
    return true;
  };
}

function deliverNativeBatch(holder, nativeBatch, deliveryId) {
  let result;
  try {
    const batch = invokeWatchbound(
      "deliver-batch",
      () => normalizeBatch(holder.outputRoot, nativeBatch),
    );
    recordObservedBatch(holder, batch);
    holder.observeCoverage?.(batch);
    result = holder.onBatch(batch, holder.context);
  } catch {
    nativeBinding.completeDelivery(deliveryId, true, holder.stopRequested);
    return;
  }
  settleCallbackResult(holder, deliveryId, result);
}

function requestCallbackStop(holder) {
  if (holder.stopRequested) return;
  holder.stopRequested = true;
  holder.abortController.abort();
  holder.startDisposal?.();
}

function createCallbackStop(weakHolder) {
  return () => {
    const holder = weakHolder.deref();
    if (holder) requestCallbackStop(holder);
  };
}

function settleCallbackResult(holder, deliveryId, result) {
  if (
    (typeof result !== "object" || result === null) &&
    typeof result !== "function"
  ) {
    nativeBinding.completeDelivery(deliveryId, false, holder.stopRequested);
    return;
  }

  let then;
  try {
    then = result.then;
  } catch {
    nativeBinding.completeDelivery(deliveryId, true, holder.stopRequested);
    return;
  }
  if (typeof then !== "function") {
    nativeBinding.completeDelivery(deliveryId, false, holder.stopRequested);
    return;
  }

  const weakHolder = new WeakRef(holder);
  let settled = false;
  const complete = (callbackError) => {
    if (settled) return;
    settled = true;
    const currentHolder = weakHolder.deref();
    nativeBinding.completeDelivery(
      deliveryId,
      callbackError,
      currentHolder?.stopRequested ?? true,
    );
  };
  try {
    then.call(
      result,
      () => complete(false),
      () => complete(true),
    );
  } catch {
    complete(true);
  }
}

function normalizeBatch(root, batch) {
  const paths = normalizePathInvalidations(root, batch.invalidatedPaths);

  return Object.freeze({
    sequence: batch.sequence,
    exclusionGeneration: batch.exclusionGeneration,
    invalidatedPaths: paths.invalidatedPaths,
    invalidatedPathBytes: paths.invalidatedPathBytes,
    pathEncoding: paths.pathEncoding,
    pathEncodingCollapsed: paths.pathEncodingCollapsed,
    rootState: normalizeRootState(batch.rootState),
    coverage: normalizeCoverage(batch.coverage),
  });
}

function validateRootRecoveryOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalidArgumentError(
      "recover-root",
      "recoverRoot options must be an object",
    );
  }
  if (
    options.identityPolicy !== "original-only" &&
    options.identityPolicy !== "accept-replacement"
  ) {
    throw invalidArgumentError(
      "recover-root",
      'identityPolicy must be "original-only" or "accept-replacement"',
    );
  }
  return options.identityPolicy;
}

function normalizeRootRecoveryResult(result) {
  return Object.freeze({
    attachment: result.attachment,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    previousRootState: normalizeRootState(result.previousRootState),
    ...(result.candidateIdentity === undefined
      ? {}
      : { candidateIdentity: normalizeRootIdentity(result.candidateIdentity) }),
    currentRootState: normalizeRootState(result.currentRootState),
    exclusionGeneration: result.exclusionGeneration,
    coverage: normalizeCoverage(result.coverage),
    boundarySequence: result.boundarySequence ?? null,
  });
}

function normalizeRootState(state) {
  return Object.freeze({
    generation: state.generation,
    identity: normalizeRootIdentity(state.identity),
    attachment: state.attachment,
    ...(state.lossEvidence === undefined ? {} : { lossEvidence: state.lossEvidence }),
  });
}

function normalizeRootIdentity(identity) {
  return Object.freeze({ device: identity.device, inode: identity.inode });
}

function normalizeResolvedRoot(root) {
  const lexicalPathBytes = Uint8Array.from(root.lexicalPath);
  const physicalPathBytes = Uint8Array.from(root.physicalPath);
  let physicalPath = null;
  try {
    physicalPath = fatalUtf8Decoder.decode(physicalPathBytes);
  } catch {
    // Exact bytes remain authoritative when the canonical path is not UTF-8.
  }
  return Object.freeze({
    policy: root.policy,
    lexicalPath: fatalUtf8Decoder.decode(lexicalPathBytes),
    lexicalPathBytes,
    physicalPath,
    physicalPathBytes,
    pathForm: "physical",
    aliasTracking: "establishment-snapshot",
    identity: normalizeRootIdentity(root.identity),
  });
}

function normalizeCoverage(coverage) {
  return Object.freeze({ ...coverage });
}
