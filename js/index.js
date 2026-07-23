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
  };
  const weakCallbackHolder = new WeakRef(callbackHolder);
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
          const encoded = invokeWatchbound(
            "replace-exclusions",
            () => prefixes.map((prefix) => {
              if (typeof prefix === "string") return Buffer.from(prefix);
              if (prefix instanceof Uint8Array) return Buffer.from(prefix);
              throw invalidArgumentError(
                "replace-exclusions",
                "each exclusion prefix must be a string or Uint8Array",
              );
            }),
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
        dispose: () =>
          (disposePromise ??= (automaticPolicy
            ? automaticPolicy.dispose(() => invokeWatchbound(
                "dispose",
                () => nativeSubscription.dispose(),
              ))
            : invokeWatchbound("dispose", () => nativeSubscription.dispose())
          ).finally(() => callbackHolders.delete(subscription))),
      });
      callbackHolders.set(subscription, callbackHolder);
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
  try {
    const nativeOptions = {};
    for (const key of Reflect.ownKeys(options)) {
      if (key === "automaticReconciliation") continue;
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor?.enumerable) continue;
      Object.defineProperty(nativeOptions, key, {
        value: options[key],
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    return nativeOptions;
  } catch {
    throw invalidArgumentError(
      "subscribe",
      "subscription option properties could not be read",
    );
  }
}

function createNativeCallback(weakCallbackHolder, resolvedRoot) {
  return (nativeBatch) => {
    const holder = weakCallbackHolder.deref();
    if (holder) {
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
      holder.onBatch(batch);
    }
  };
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
