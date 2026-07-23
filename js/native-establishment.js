import {
  invalidArgumentError,
  invokeWatchbound,
  operationCancelledError,
} from "./errors.js";

const MAX_NATIVE_INTEGER_OPTION = 4_294_967_295;
const nativeIntegerOptionNames = Object.freeze([
  "watchLimit",
  "batchWindowMs",
  "maxBatchPaths",
  "outputQueueCapacity",
]);

/**
 * Establish a native subscription while keeping cancellation provisional until
 * the wrapper commits public success. This module is internal to the package;
 * its explicit dependencies also provide a deterministic fake-native test
 * seam without exporting test controls from the public entry point.
 */
export async function establishNativeSubscription({
  nativeEngine,
  root,
  options,
  callback,
  buildSubscription,
}) {
  validateNativeIntegerOptions(options);
  let signal;
  let nativeOptions;
  try {
    ({ signal, ...nativeOptions } = options);
  } catch {
    throw invalidArgumentError(
      "subscribe",
      "subscription option properties could not be read",
    );
  }
  const signalAccess = validateAbortSignal(signal);

  if (signalAccess === null) {
    const nativeSubscription = await invokeWatchbound(
      "subscribe",
      () => nativeEngine.subscribe(root, nativeOptions, callback),
    );
    return buildOrDispose(nativeSubscription, buildSubscription);
  }
  if (signalAccess.aborted()) {
    throw operationCancelledError();
  }

  const token = invokeWatchbound(
    "subscribe",
    () => nativeEngine.createEstablishmentCancellation(),
  );
  let cancellationRequested = false;
  const requestCancellation = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    invokeWatchbound("subscribe", () => token.cancel());
  };
  const onAbort = requestCancellation;
  let listenerAddAttempted = false;
  let listenerRemoved = false;

  try {
    listenerAddAttempted = true;
    try {
      signalAccess.add(onAbort);
    } catch {
      requestCancellation();
      throw invalidArgumentError(
        "subscribe",
        "signal.addEventListener could not register the abort listener",
      );
    }

    // JavaScript execution cannot normally interleave between the first check
    // and listener registration. This second check also closes re-entrant or
    // compatible-object behavior at that boundary.
    if (signalAccess.aborted()) {
      requestCancellation();
    }

    const nativeSubscription = await invokeWatchbound(
      "subscribe",
      () => nativeEngine.subscribe(root, nativeOptions, callback, token),
    );

    try {
      try {
        signalAccess.remove(onAbort);
        listenerRemoved = true;
      } catch {
        requestCancellation();
        throw invalidArgumentError(
          "subscribe",
          "signal.removeEventListener could not remove the abort listener",
        );
      }
      if (signalAccess.aborted()) {
        requestCancellation();
      }

      const committed = invokeWatchbound(
        "subscribe",
        () => token.commitPublicSuccess(),
      );
      if (typeof committed !== "boolean") {
        return invokeWatchbound("subscribe", () => {
          throw new TypeError(
            "native establishment commit must return a boolean",
          );
        });
      }
      if (!committed) {
        throw operationCancelledError();
      }
    } catch (error) {
      await disposeProvisional(nativeSubscription);
      throw error;
    }
    return buildOrDispose(nativeSubscription, buildSubscription);
  } finally {
    if (listenerAddAttempted && !listenerRemoved) {
      try {
        signalAccess.remove(onAbort);
      } catch {
        // A native failure or joined cancellation is already authoritative.
        // Strict validation and the success path separately reject a broken
        // removal method without replacing an existing terminal result here.
      }
    }
  }
}

function validateNativeIntegerOptions(options) {
  for (const name of nativeIntegerOptionNames) {
    let value;
    try {
      value = options[name];
    } catch {
      throw invalidArgumentError(
        "subscribe",
        `${name} could not be read`,
      );
    }
    if (value == null) continue;
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > MAX_NATIVE_INTEGER_OPTION
    ) {
      throw invalidArgumentError(
        "subscribe",
        `${name} must be a finite positive integer no greater than ${MAX_NATIVE_INTEGER_OPTION}`,
      );
    }
  }
}

function validateAbortSignal(signal) {
  if (signal === undefined) return null;
  if (
    signal === null ||
    (typeof signal !== "object" && typeof signal !== "function")
  ) {
    throw invalidArgumentError(
      "subscribe",
      "signal must be an AbortSignal-compatible object",
    );
  }

  let aborted;
  let addEventListener;
  let removeEventListener;
  try {
    aborted = signal.aborted;
    addEventListener = signal.addEventListener;
    removeEventListener = signal.removeEventListener;
  } catch {
    throw invalidArgumentError(
      "subscribe",
      "signal properties could not be read",
    );
  }
  if (
    typeof aborted !== "boolean" ||
    typeof addEventListener !== "function" ||
    typeof removeEventListener !== "function"
  ) {
    throw invalidArgumentError(
      "subscribe",
      "signal must expose boolean aborted and callable addEventListener/removeEventListener",
    );
  }

  return {
    aborted() {
      let current;
      try {
        current = signal.aborted;
      } catch {
        throw invalidArgumentError(
          "subscribe",
          "signal.aborted could not be read",
        );
      }
      if (typeof current !== "boolean") {
        throw invalidArgumentError(
          "subscribe",
          "signal.aborted must remain boolean",
        );
      }
      return current;
    },
    add(listener) {
      addEventListener.call(signal, "abort", listener, { once: true });
    },
    remove(listener) {
      removeEventListener.call(signal, "abort", listener);
    },
  };
}

async function buildOrDispose(nativeSubscription, buildSubscription) {
  try {
    return buildSubscription(nativeSubscription);
  } catch (error) {
    await disposeProvisional(nativeSubscription);
    return invokeWatchbound("subscribe", () => {
      throw error;
    });
  }
}

function disposeProvisional(nativeSubscription) {
  return invokeWatchbound(
    "dispose",
    () => nativeSubscription.dispose(),
  );
}
