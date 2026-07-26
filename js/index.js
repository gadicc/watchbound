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
} from "./capabilities.js";
import { establishNativeSubscription } from "./native-establishment.js";

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
 * conservatively collapses that invalidation to the representable root.
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
  const resolvedRoot = path.resolve(absoluteRoot);
  const callbackHolder = {
    onBatch,
    observeCoverage: undefined,
    pendingCoverageObservation: null,
    observedState: null,
    abortController: new AbortController(),
    stopRequested: false,
    startDisposal: null,
    context: null,
  };
  const weakCallbackHolder = new WeakRef(callbackHolder);
  callbackHolder.context = Object.freeze({
    signal: callbackHolder.abortController.signal,
    stop: createCallbackStop(weakCallbackHolder),
  });
  return establishNativeSubscription({
    nativeEngine,
    root: absoluteRoot,
    options: nativeOptions,
    callback: createNativeCallback(weakCallbackHolder, resolvedRoot),
    buildSubscription(nativeSubscription) {
      const automaticPolicy = automaticConfig === null
        ? null
        : createAutomaticReconciliationPolicy(
            automaticConfig,
            () => invokeWatchbound("reconcile", () => nativeSubscription.reconcile()),
          );
      callbackHolder.observeCoverage = automaticPolicy?.observe ?? null;
      if (
        callbackHolder.observeCoverage !== null &&
        callbackHolder.pendingCoverageObservation !== null
      ) {
        callbackHolder.observeCoverage(callbackHolder.pendingCoverageObservation);
      }
      callbackHolder.pendingCoverageObservation = null;
      const initialCoverage = normalizeCoverage(nativeSubscription.initialCoverage);
      const initialRootState = normalizeRootState(nativeSubscription.initialRootState);
      initializeObservedState(callbackHolder, initialCoverage, initialRootState);
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
        replaceExclusions: (generation, prefixes) => {
          if (typeof generation !== "bigint" || generation < 0n) {
            throw invalidArgumentError(
              "replace-exclusions",
              "generation must be a non-negative bigint",
            );
          }
          if (!Array.isArray(prefixes)) {
            throw invalidArgumentError(
              "replace-exclusions",
              "prefixes must be an array of strings or Uint8Array values",
            );
          }
          const encoded = encodeExclusionPrefixes(
            prefixes,
            "replace-exclusions",
          );
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
  let hasInitialExclusions = false;
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
  return nativeOptions;
}

function encodeExclusionPrefixes(prefixes, operation) {
  if (!Array.isArray(prefixes)) {
    throw invalidArgumentError(
      operation,
      "exclusion prefixes must be an array of strings or Uint8Array values",
    );
  }
  return invokeWatchbound(
    operation,
    () => prefixes.map((prefix) => {
      if (typeof prefix === "string") return Buffer.from(prefix);
      if (prefix instanceof Uint8Array) return Buffer.from(prefix);
      throw invalidArgumentError(
        operation,
        "each exclusion prefix must be a string or Uint8Array",
      );
    }),
  );
}

function createNativeCallback(weakCallbackHolder, resolvedRoot) {
  return (nativeBatch, deliveryId) => {
    const holder = weakCallbackHolder.deref();
    if (!holder) {
      nativeBinding.completeDelivery(deliveryId, false, true);
      return true;
    }
    let result;
    try {
      const batch = invokeWatchbound(
        "deliver-batch",
        () => normalizeBatch(resolvedRoot, nativeBatch),
      );
      recordObservedBatch(holder, batch);
      if (holder.observeCoverage === undefined) {
        // Native delivery may enter JavaScript before the subscribe promise's
        // continuation constructs the public subscription. One latest batch is
        // enough because engine uncertainty and root loss are sticky until an
        // explicit recovery boundary.
        holder.pendingCoverageObservation = batch;
      } else {
        holder.observeCoverage?.(batch);
      }
      result = holder.onBatch(batch, holder.context);
    } catch {
      nativeBinding.completeDelivery(deliveryId, true, holder.stopRequested);
      return true;
    }
    settleCallbackResult(holder, deliveryId, result);
    // `true` is the private binding protocol marker that transfers exactly-once
    // completion ownership from the raw callback bridge to this wrapper.
    return true;
  };
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
  const invalidatedPathBytes = batch.invalidatedPaths.map((value) =>
    Uint8Array.from(value),
  );
  const invalidatedPaths = [];
  let pathEncodingCollapsed = false;
  for (const bytes of invalidatedPathBytes) {
    try {
      invalidatedPaths.push(fatalUtf8Decoder.decode(bytes));
    } catch {
      pathEncodingCollapsed = true;
    }
  }
  if (pathEncodingCollapsed && !invalidatedPaths.includes(root)) {
    invalidatedPaths.push(root);
  }

  return Object.freeze({
    sequence: batch.sequence,
    exclusionGeneration: batch.exclusionGeneration,
    invalidatedPaths: Object.freeze([...new Set(invalidatedPaths)]),
    invalidatedPathBytes: Object.freeze(invalidatedPathBytes),
    pathEncodingCollapsed,
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

function normalizeCoverage(coverage) {
  return Object.freeze({ ...coverage });
}
