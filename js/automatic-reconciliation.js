import {
  WatchboundError,
  WatchboundErrorCode,
  invalidArgumentError,
  isWatchboundError,
} from "./errors.js";

const DEFAULTS = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 25,
  maxDelayMs: 1_000,
});

const LIMITS = Object.freeze({
  maxAttempts: 16,
  maxDelayMs: 60_000,
});

const recoverableReasons = new Set([
  "event-overflow",
  "topology-race",
  "consumer-backpressure",
]);

const reconciliationRetryCodes = new Set([
  WatchboundErrorCode.TOPOLOGY_TRANSACTION_CONFLICT,
  WatchboundErrorCode.CONSUMER_BACKPRESSURE,
]);

const reasonPriority = Object.freeze({
  "consumer-backpressure": 1,
  "topology-race": 2,
  "event-overflow": 3,
  "root-replaced": 4,
});

const systemClock = Object.freeze({
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer),
});

export function normalizeAutomaticReconciliation(value) {
  if (value === undefined || value === false) return null;
  if (value === true) return { ...DEFAULTS };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArgumentError(
      "subscribe",
      "automaticReconciliation must be true, false, or an options object",
    );
  }

  const maxAttempts = value.maxAttempts ?? DEFAULTS.maxAttempts;
  const initialDelayMs = value.initialDelayMs ?? DEFAULTS.initialDelayMs;
  const maxDelayMs = value.maxDelayMs ?? DEFAULTS.maxDelayMs;
  requireBoundedInteger("maxAttempts", maxAttempts, 1, LIMITS.maxAttempts);
  requireBoundedInteger("initialDelayMs", initialDelayMs, 10, LIMITS.maxDelayMs);
  requireBoundedInteger("maxDelayMs", maxDelayMs, 10, LIMITS.maxDelayMs);
  if (maxDelayMs < initialDelayMs) {
    throw invalidArgumentError(
      "subscribe",
      "automaticReconciliation maxDelayMs must be at least initialDelayMs",
    );
  }
  return { maxAttempts, initialDelayMs, maxDelayMs };
}

export function createAutomaticReconciliationPolicy(
  config,
  reconcile,
  clock = systemClock,
) {
  let currentStatus = frozenStatus({ state: "idle" });
  let lifecycle = "active";
  let timer = null;
  let activePromise = null;
  let rootRecoveryPromise = null;
  let rootRecoveryObservation = null;
  let disposalPromise = null;
  let attempts = 0;
  let pendingLoss = false;
  let cycleReason = null;
  let cycleActive = false;
  let terminalLatch = false;

  function status() {
    return currentStatus;
  }

  function setStatus(value) {
    currentStatus = frozenStatus(value);
  }

  function observe(observation) {
    const coverage = observation?.coverage ?? observation;
    const rootState = observation?.rootState;
    if (lifecycle !== "active" || !coverage || coverage.state !== "uncertain") return;
    if (rootRecoveryPromise !== null) {
      rootRecoveryObservation = strongerRootRecoveryObservation(
        rootRecoveryObservation,
        { coverage, rootState },
      );
      return;
    }
    if (coverage.reason === "root-replaced") {
      terminalLatch = true;
      pendingLoss = false;
      cycleReason = "root-replaced";
      cancelTimer();
      setStatus({ state: "blocked", reason: "root-replaced" });
      return;
    }
    if (!recoverableReasons.has(coverage.reason) || terminalLatch) return;

    if (!cycleActive) {
      cycleActive = true;
      attempts = 0;
      cycleReason = coverage.reason;
    } else {
      cycleReason = strongerReason(cycleReason, coverage.reason);
    }
    pendingLoss = true;
    if (timer === null && activePromise === null) scheduleAttempt();
  }

  function scheduleAttempt() {
    if (lifecycle !== "active" || timer !== null || activePromise !== null) return;
    if (attempts >= config.maxAttempts) {
      exhaust("reconciliation did not restore recoverable coverage");
      return;
    }
    const attempt = attempts + 1;
    const delayMs = Math.min(
      config.initialDelayMs * (2 ** (attempt - 1)),
      config.maxDelayMs,
    );
    setStatus({ state: "scheduled", reason: cycleReason, attempt, delayMs });
    timer = clock.setTimeout(() => {
      timer = null;
      if (lifecycle !== "active") return;
      activePromise = runAttempt();
    }, delayMs);
  }

  async function runAttempt() {
    attempts += 1;
    pendingLoss = false;
    setStatus({
      state: "reconciling",
      reason: cycleReason,
      attempt: attempts,
    });
    try {
      const result = await reconcile();
      if (lifecycle !== "active") return;
      if (cycleReason === "root-replaced") {
        setStatus({ state: "blocked", reason: "root-replaced" });
        return;
      }
      if (pendingLoss) return;

      const coverage = result?.coverage;
      if (coverage?.state === "complete") {
        cycleActive = false;
        setStatus({
          state: "recovered",
          reason: cycleReason,
          attempts,
          exclusionGeneration: result.exclusionGeneration,
          coverage,
        });
        return;
      }
      if (coverage?.state === "uncertain" && coverage.reason === "root-replaced") {
        terminalLatch = true;
        cycleReason = "root-replaced";
        setStatus({ state: "blocked", reason: "root-replaced" });
        return;
      }
      if (coverage?.state === "uncertain" && recoverableReasons.has(coverage.reason)) {
        cycleReason = strongerReason(cycleReason, coverage.reason);
        pendingLoss = true;
        return;
      }

      cycleActive = false;
      setStatus({
        state: "incomplete",
        reason: cycleReason,
        attempts,
        exclusionGeneration: result?.exclusionGeneration,
        coverage,
      });
    } catch (error) {
      if (lifecycle !== "active") return;
      if (
        cycleReason === "root-replaced" ||
        error?.code === WatchboundErrorCode.ROOT_STATE_CONFLICT
      ) {
        terminalLatch = true;
        pendingLoss = false;
        cycleReason = "root-replaced";
        setStatus({ state: "blocked", reason: "root-replaced" });
        return;
      }
      if (
        !isWatchboundError(error) ||
        !reconciliationRetryCodes.has(error.code)
      ) {
        exhaust(errorMessage(error));
        return;
      }
      pendingLoss = true;
      if (attempts >= config.maxAttempts) exhaust(errorMessage(error));
    } finally {
      activePromise = null;
      if (lifecycle === "active" && pendingLoss && !terminalLatch) scheduleAttempt();
    }
  }

  function exhaust(message) {
    terminalLatch = true;
    pendingLoss = false;
    setStatus({
      state: "exhausted",
      reason: cycleReason,
      attempts,
      error: boundedMessage(message),
    });
  }

  function cancelTimer() {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  }

  function recoverRoot(identityPolicy, nativeRecover) {
    if (lifecycle !== "active") {
      return Promise.reject(
        new WatchboundError("subscription is disposing or disposed", {
          code: WatchboundErrorCode.SUBSCRIPTION_CLOSED,
          operation: "recover-root",
        }),
      );
    }
    if (rootRecoveryPromise !== null) {
      return Promise.reject(
        new WatchboundError("a root recovery is already in progress", {
          code: WatchboundErrorCode.TOPOLOGY_TRANSACTION_CONFLICT,
          operation: "recover-root",
        }),
      );
    }
    const previous = {
      status: currentStatus,
      terminalLatch,
      cycleActive,
      attempts,
      pendingLoss,
      cycleReason,
    };
    cancelTimer();
    pendingLoss = false;
    rootRecoveryObservation = null;
    setStatus({ state: "recovering-root", identityPolicy });

    rootRecoveryPromise = (async () => {
      try {
        const result = await nativeRecover();
        rootRecoveryPromise = null;
        if (lifecycle === "active") finishRootRecovery(result);
        return result;
      } catch (error) {
        rootRecoveryPromise = null;
        if (lifecycle === "active") {
          const observedRootLoss =
            rootRecoveryObservation?.coverage.reason === "root-replaced";
          if (previous.status.state === "blocked" || observedRootLoss) {
            terminalLatch = true;
            cycleActive = false;
            cycleReason = "root-replaced";
            setStatus({ state: "blocked", reason: "root-replaced" });
          } else {
            terminalLatch = previous.terminalLatch;
            cycleActive = previous.cycleActive;
            attempts = previous.attempts;
            pendingLoss = previous.pendingLoss;
            cycleReason = previous.cycleReason;
            if (previous.status.state === "scheduled" && pendingLoss) {
              setStatus({ state: "idle" });
              scheduleAttempt();
            } else {
              setStatus(previous.status);
            }
            if (rootRecoveryObservation) observe(rootRecoveryObservation);
          }
        }
        throw error;
      } finally {
        rootRecoveryPromise = null;
        rootRecoveryObservation = null;
      }
    })();
    return rootRecoveryPromise;
  }

  function finishRootRecovery(result) {
    const attached =
      result?.attachment !== "not-attached" &&
      result?.currentRootState?.attachment === "attached";
    if (!attached) {
      terminalLatch = true;
      cycleActive = false;
      cycleReason = "root-replaced";
      setStatus({ state: "blocked", reason: "root-replaced" });
      return;
    }

    const currentGeneration = result.currentRootState?.generation;
    const relevantObservation =
      rootRecoveryObservation !== null &&
      (rootRecoveryObservation.rootState?.generation === undefined ||
        currentGeneration === undefined ||
        rootRecoveryObservation.rootState.generation >= currentGeneration)
        ? rootRecoveryObservation
        : null;
    if (relevantObservation?.coverage.reason === "root-replaced") {
      terminalLatch = true;
      cycleActive = false;
      cycleReason = "root-replaced";
      setStatus({ state: "blocked", reason: "root-replaced" });
      return;
    }

    terminalLatch = false;
    cycleActive = false;
    attempts = 0;
    pendingLoss = false;
    cycleReason = null;
    setStatus({ state: "idle" });
    observe(result.coverage);
    if (relevantObservation) observe(relevantObservation);
  }

  function dispose(nativeDispose) {
    if (disposalPromise) return disposalPromise;
    lifecycle = "disposing";
    pendingLoss = false;
    cancelTimer();
    setStatus({ state: "disposing" });

    let nativeDisposal;
    try {
      nativeDisposal = Promise.resolve(nativeDispose());
    } catch (error) {
      nativeDisposal = Promise.reject(error);
    }
    const activeAtDisposal = activePromise;
    const rootRecoveryAtDisposal = rootRecoveryPromise;
    disposalPromise = (async () => {
      const [nativeResult] = await Promise.allSettled([
        nativeDisposal,
        activeAtDisposal,
        rootRecoveryAtDisposal,
      ]);
      lifecycle = "disposed";
      setStatus({ state: "disposed" });
      if (nativeResult.status === "rejected") throw nativeResult.reason;
    })();
    return disposalPromise;
  }

  return Object.freeze({ status, observe, recoverRoot, dispose });
}

function requireBoundedInteger(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidArgumentError(
      "subscribe",
      `automaticReconciliation ${name} must be an integer from ${minimum} through ${maximum}`,
    );
  }
}

function strongerReason(current, candidate) {
  return reasonPriority[candidate] > reasonPriority[current] ? candidate : current;
}

function strongerRootRecoveryObservation(current, candidate) {
  if (current === null) return candidate;
  const currentGeneration = current.rootState?.generation;
  const candidateGeneration = candidate.rootState?.generation;
  if (currentGeneration !== undefined && candidateGeneration !== undefined) {
    if (candidateGeneration > currentGeneration) return candidate;
    if (candidateGeneration < currentGeneration) return current;
  }
  return reasonPriority[candidate.coverage.reason] > reasonPriority[current.coverage.reason]
    ? candidate
    : current;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function boundedMessage(value) {
  return String(value).slice(0, 1_024);
}

function frozenStatus(value) {
  const status = { ...value };
  if (status.coverage && typeof status.coverage === "object") {
    status.coverage = Object.freeze({ ...status.coverage });
  }
  return Object.freeze(status);
}
