import nativeBinding from "../node/index.js";
import path from "node:path";
import {
  createAutomaticReconciliationPolicy,
  normalizeAutomaticReconciliation,
} from "./automatic-reconciliation.js";

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const callbackHolders = new WeakMap();

export const capabilities = Object.freeze({
  ...nativeBinding.capabilities(),
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
    throw new TypeError("root must be a non-empty string");
  }
  if (typeof onBatch !== "function") {
    throw new TypeError("onBatch must be a function");
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
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
  const nativeSubscription = await nativeBinding.subscribe(
    absoluteRoot,
    nativeOptions,
    createNativeCallback(weakCallbackHolder, resolvedRoot),
  );
  const automaticPolicy = automaticConfig === null
    ? null
    : createAutomaticReconciliationPolicy(
        automaticConfig,
        () => nativeSubscription.reconcile(),
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
        throw new TypeError("generation must be a non-negative bigint");
      }
      if (!Array.isArray(prefixes)) {
        throw new TypeError("prefixes must be an array of strings or Uint8Array values");
      }
      const encoded = prefixes.map((prefix) => {
        if (typeof prefix === "string") return Buffer.from(prefix);
        if (prefix instanceof Uint8Array) return Buffer.from(prefix);
        throw new TypeError("each exclusion prefix must be a string or Uint8Array");
      });
      return nativeSubscription.replaceExclusions(generation, encoded);
    },
    reconcile: () => nativeSubscription.reconcile(),
    recoverRoot: (recoveryOptions) => {
      const identityPolicy = validateRootRecoveryOptions(recoveryOptions);
      const recover = async () => normalizeRootRecoveryResult(
        await nativeSubscription.recoverRoot(identityPolicy),
      );
      return automaticPolicy
        ? automaticPolicy.recoverRoot(identityPolicy, recover)
        : recover();
    },
    dispose: () =>
      (disposePromise ??= (automaticPolicy
        ? automaticPolicy.dispose(() => nativeSubscription.dispose())
        : nativeSubscription.dispose()
      ).finally(() => callbackHolders.delete(subscription))),
  });
  callbackHolders.set(subscription, callbackHolder);
  return subscription;
}

function createNativeCallback(weakCallbackHolder, resolvedRoot) {
  return (nativeBatch) => {
    const holder = weakCallbackHolder.deref();
    if (holder) {
      const batch = normalizeBatch(resolvedRoot, nativeBatch);
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
    throw new TypeError("recoverRoot options must be an object");
  }
  if (
    options.identityPolicy !== "original-only" &&
    options.identityPolicy !== "accept-replacement"
  ) {
    throw new TypeError(
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
