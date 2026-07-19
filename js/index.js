import nativeBinding from "../node/index.js";
import path from "node:path";

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const callbackHolders = new WeakMap();

export const capabilities = Object.freeze(nativeBinding.capabilities());

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

  // Preserve every caller-supplied component for the engine's symlink-ancestry
  // validation. path.resolve(root) would erase `symlink/..` before native code
  // can reject it. The normalized spelling is used only after validation for
  // the wrapper's absolute string invalidations.
  const absoluteRoot = path.isAbsolute(root)
    ? root
    : `${process.cwd()}${path.sep}${root}`;
  const resolvedRoot = path.resolve(absoluteRoot);
  const callbackHolder = { onBatch };
  const weakCallbackHolder = new WeakRef(callbackHolder);
  const nativeSubscription = await nativeBinding.subscribe(
    absoluteRoot,
    options,
    createNativeCallback(weakCallbackHolder, resolvedRoot),
  );
  let disposePromise;
  let subscription;
  subscription = Object.freeze({
    initialCoverage: nativeSubscription.initialCoverage,
    get exclusionGeneration() {
      return nativeSubscription.exclusionGeneration;
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
    dispose: () =>
      (disposePromise ??= nativeSubscription
        .dispose()
        .finally(() => callbackHolders.delete(subscription))),
  });
  callbackHolders.set(subscription, callbackHolder);
  return subscription;
}

function createNativeCallback(weakCallbackHolder, resolvedRoot) {
  return (nativeBatch) => {
    const holder = weakCallbackHolder.deref();
    if (holder) holder.onBatch(normalizeBatch(resolvedRoot, nativeBatch));
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
    coverage: batch.coverage,
  });
}
