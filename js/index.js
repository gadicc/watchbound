import nativeBinding from "../node/index.js";
import path from "node:path";
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

export {
  WatchboundError,
  WatchboundErrorCode,
  WatchboundRetryAfter,
  isWatchboundError,
  normalizeWatchboundError,
};

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const callbackHolders = new WeakMap();

export const capabilities = Object.freeze({
  ...invokeWatchbound("create-engine", () => nativeBinding.capabilities()),
  automaticReconciliation: true,
});

const automaticReconciliationDisabled = Object.freeze({ state: "disabled" });

/**
 * Subscribe to one recursive directory root.
 *
 * The native boundary preserves exact Linux path bytes. This wrapper also
 * provides string invalidations: if a child path is not valid UTF-8, it
 * conservatively collapses that invalidation to the representable root.
 */
export async function subscribe(root, onBatch, options = {}) {
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
    options.automaticReconciliation,
  );
  const { automaticReconciliation: _automaticReconciliation, ...nativeOptions } = options;

  // Preserve every caller-supplied component for the engine's symlink-ancestry
  // validation. path.resolve(root) would erase `symlink/..` before native code
  // can reject it. The normalized spelling is used only after validation for
  // the wrapper's absolute string invalidations.
  const absoluteRoot = path.isAbsolute(root)
    ? root
    : `${process.cwd()}${path.sep}${root}`;
  const resolvedRoot = path.resolve(absoluteRoot);
  const callbackHolder = { onBatch, observeCoverage: null };
  const weakCallbackHolder = new WeakRef(callbackHolder);
  const nativeSubscription = await invokeWatchbound(
    "subscribe",
    () => nativeBinding.subscribe(
      absoluteRoot,
      nativeOptions,
      createNativeCallback(weakCallbackHolder, resolvedRoot),
    ),
  );
  const automaticPolicy = automaticConfig === null
    ? null
    : createAutomaticReconciliationPolicy(
        automaticConfig,
        () => invokeWatchbound("reconcile", () => nativeSubscription.reconcile()),
      );
  callbackHolder.observeCoverage = automaticPolicy?.observe ?? null;
  let disposePromise;
  let subscription;
  subscription = Object.freeze({
    initialCoverage: nativeSubscription.initialCoverage,
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
}

function createNativeCallback(weakCallbackHolder, resolvedRoot) {
  return (nativeBatch) => {
    const holder = weakCallbackHolder.deref();
    if (holder) {
      const batch = invokeWatchbound(
        "deliver-batch",
        () => normalizeBatch(resolvedRoot, nativeBatch),
      );
      holder.observeCoverage?.(batch);
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
