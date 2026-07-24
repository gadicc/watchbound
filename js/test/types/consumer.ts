import {
  WatchboundError,
  WatchboundErrorCode,
  WatchboundRetryAfter,
  capabilities,
  createEngine,
  isWatchboundError,
  normalizeWatchboundError,
  subscribe,
  type AutomaticReconciliationStatus,
  type BatchCallback,
  type BatchCallbackContext,
  type ChangeBatch,
  type Coverage,
  type Engine,
  type PartialReason,
  type RootRecoveryFailureReason,
  type RootRecoveryResult,
  type RuntimeStats,
  type Subscription,
  type UncertainReason,
  type WatchboundErrorCode as WatchboundErrorCodeType,
  type WatchboundOperation,
  type WatchboundRetryAfter as WatchboundRetryAfterType,
  type WatchboundSystemCause,
} from "watchbound";

function assertNever(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`);
}

function describePartialReason(reason: PartialReason): string {
  switch (reason) {
    case "resource-limit":
      return "resource limit";
    case "permission":
      return "permission";
    case "transient-error":
      return "transient error";
    default:
      return assertNever(reason);
  }
}

function describeUncertainReason(reason: UncertainReason): string {
  switch (reason) {
    case "event-overflow":
      return "overflow";
    case "root-replaced":
      return "root replaced";
    case "topology-race":
      return "topology race";
    case "consumer-backpressure":
      return "backpressure";
    default:
      return assertNever(reason);
  }
}

function describeCoverage(coverage: Coverage): string {
  switch (coverage.state) {
    case "complete":
      return "complete";
    case "partial": {
      const watched: number = coverage.watchedDirectories;
      const deferred: number = coverage.deferredDirectories;
      return `${describePartialReason(coverage.reason)}:${watched}:${deferred}`;
    }
    case "uncertain":
      return describeUncertainReason(coverage.reason);
    default:
      return assertNever(coverage);
  }
}

function describeAutomaticStatus(status: AutomaticReconciliationStatus): string {
  switch (status.state) {
    case "disabled":
    case "idle":
    case "disposing":
    case "disposed":
      return status.state;
    case "scheduled": {
      const attempt: number = status.attempt;
      const delayMs: number = status.delayMs;
      return `${status.reason}:${attempt}:${delayMs}`;
    }
    case "reconciling": {
      const attempt: number = status.attempt;
      return `${status.reason}:${attempt}`;
    }
    case "recovered":
    case "incomplete": {
      const attempts: number = status.attempts;
      const generation: bigint = status.exclusionGeneration;
      return `${status.reason}:${attempts}:${generation}:${describeCoverage(status.coverage)}`;
    }
    case "exhausted": {
      const attempts: number = status.attempts;
      const diagnostic: string = status.error;
      return `${status.reason}:${attempts}:${diagnostic}`;
    }
    case "blocked":
      return status.reason;
    case "recovering-root":
      return status.identityPolicy;
    default:
      return assertNever(status);
  }
}

function describeRecoveryFailure(reason: RootRecoveryFailureReason): string {
  switch (reason) {
    case "replacement-not-accepted":
    case "candidate-missing":
    case "candidate-not-directory":
    case "symlink-ancestry":
    case "identity-unstable":
    case "root-watch-unavailable":
      return reason;
    default:
      return assertNever(reason);
  }
}

function inspectRecovery(result: RootRecoveryResult): string {
  const previousDevice: bigint = result.previousRootState.identity.device;
  const previousInode: bigint = result.previousRootState.identity.inode;
  const currentGeneration: bigint = result.currentRootState.generation;
  const exclusionGeneration: bigint = result.exclusionGeneration;
  const boundary: bigint | null = result.boundarySequence;

  switch (result.attachment) {
    case "not-attached": {
      const reason: RootRecoveryFailureReason = result.reason;
      const candidateDevice: bigint | undefined = result.candidateIdentity?.device;
      return `${describeRecoveryFailure(reason)}:${candidateDevice}`;
    }
    case "original-restored":
    case "replacement-adopted": {
      const noFailure: undefined = result.reason;
      const candidateDevice: bigint = result.candidateIdentity.device;
      return `${result.attachment}:${candidateDevice}`;
    }
    default:
      return assertNever(result);
  }

  void previousDevice;
  void previousInode;
  void currentGeneration;
  void exclusionGeneration;
  void boundary;
}

function inspectSystemCause(cause: WatchboundSystemCause): string {
  const message: string = cause.message;
  const code: string | number | undefined = cause.code;
  const kind: string | undefined = cause.kind;
  switch (cause.domain) {
    case "os":
      return `${message}:${code}:${kind}`;
    case "node-api":
      return `${message}:${code}`;
    default:
      return assertNever(cause.domain);
  }
}

function inspectOperation(operation: WatchboundOperation): string {
  switch (operation) {
    case "create-engine":
    case "subscribe":
    case "replace-exclusions":
    case "reconcile":
    case "recover-root":
    case "dispose":
    case "deliver-batch":
      return operation;
    default:
      return assertNever(operation);
  }
}

function inspectRetryAfter(retryAfter: WatchboundRetryAfterType): string {
  switch (retryAfter) {
    case "topology-transaction-settles":
    case "delivery-drains":
    case "root-state-changes":
    case "filesystem-state-changes":
    case "resources-available":
    case "runtime-disposed":
      return retryAfter;
    default:
      return assertNever(retryAfter);
  }
}

function inspectErrorCode(code: WatchboundErrorCodeType): string {
  switch (code) {
    case "WATCHBOUND_INVALID_ARGUMENT":
    case "WATCHBOUND_SUBSCRIPTION_CLOSED":
    case "WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT":
    case "WATCHBOUND_OPERATION_INTERRUPTED":
    case "WATCHBOUND_OPERATION_CANCELLED":
    case "WATCHBOUND_CONSUMER_BACKPRESSURE":
    case "WATCHBOUND_ROOT_STATE_CONFLICT":
    case "WATCHBOUND_ROOT_UNAVAILABLE":
    case "WATCHBOUND_RESOURCE_UNAVAILABLE":
    case "WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT":
    case "WATCHBOUND_INTERNAL":
      return code;
    default:
      return assertNever(code);
  }
}

function inspectUnknownError(error: unknown): string {
  if (!isWatchboundError(error)) return "not-watchbound";
  const retryable: boolean = error.retryable;
  const operation = inspectOperation(error.operation);
  const code = inspectErrorCode(error.code);
  const retryAfter = error.retryAfter === undefined
    ? "none"
    : inspectRetryAfter(error.retryAfter);
  const cause = error.systemCause === undefined
    ? "none"
    : inspectSystemCause(error.systemCause);
  return `${code}:${operation}:${retryable}:${retryAfter}:${cause}`;
}

function inspectCapabilities(): void {
  const schemaVersion: 3 = capabilities.schemaVersion;
  const bindingApi: number = capabilities.versions.bindingApi;
  const callbackCompletion: "promise-aware-serialized" =
    capabilities.observability.callbackCompletion;
  const callbackMaxInFlight: 1 =
    capabilities.observability.callbackMaxInFlight;
  const targetTriple: string = capabilities.build.targetTriple;
  const delivery:
    | "controlled-source-build"
    | "bundled-native-package" = capabilities.build.delivery;
  const prebuilt: boolean = capabilities.build.prebuilt;
  const nodeRange: ">=24.18.0 <25" = capabilities.support.nodeRange;
  const supportStatus: "pending" | "ready" = (() => {
    switch (capabilities.support.status) {
      case "target-pending-clean-ci":
        return "pending";
      case "supported":
        return "ready";
      default:
        return assertNever(capabilities.support.status);
    }
  })();
  const runtimeNode: string = capabilities.runtime.node.version;
  const runtimeNodeApi: number | null = capabilities.runtime.node.api;
  const processBudget = capabilities.options.engine.nativeWatchBudget;
  const processScope: "process-runtime" = processBudget.scope;
  const nativeAccounting: "unique-native-watches" = processBudget.accounting;
  const logicalAccounting: "logical-directories" =
    capabilities.options.subscription.watchLimit.accounting;
  const batchDefault: number = capabilities.options.subscription.maxBatchPaths.default;
  const authoritative: "ordered-batches" = capabilities.observability.authoritativeState;
  const callbackBoundary: "before-callback" =
    capabilities.observability.observedStateBoundary;
  const hasObservedState: boolean = capabilities.features.observedState;
  const cancellableEstablishment: boolean =
    capabilities.features.cancellableEstablishment;
  const sharedNodeDelivery: boolean = capabilities.features.sharedNodeDelivery;
  const dispatcherScope: "node-environment" =
    capabilities.observability.deliveryDispatcherScope;
  const deliveryAdmission: "single-credit" =
    capabilities.observability.deliveryAdmission;
  const dispatcherWorkQuantum: 64 =
    capabilities.observability.deliveryDispatcherWorkQuantum;
  const dispatcherPollMilliseconds: 5 =
    capabilities.observability.deliveryDispatcherPollMilliseconds;

  void schemaVersion;
  void bindingApi;
  void callbackCompletion;
  void callbackMaxInFlight;
  void targetTriple;
  void delivery;
  void prebuilt;
  void nodeRange;
  void supportStatus;
  void runtimeNode;
  void runtimeNodeApi;
  void processScope;
  void nativeAccounting;
  void logicalAccounting;
  void batchDefault;
  void authoritative;
  void callbackBoundary;
  void hasObservedState;
  void cancellableEstablishment;
  void sharedNodeDelivery;
  void dispatcherScope;
  void deliveryAdmission;
  void dispatcherWorkQuantum;
  void dispatcherPollMilliseconds;
}

function inspectRuntimeStats(stats: RuntimeStats): string {
  const active: boolean = stats.active;
  const inotifyInstances: number = stats.inotifyInstances;
  const workerThreads: number = stats.workerThreads;
  const nativeWatches: number = stats.nativeWatches;
  const nativeWatchBudget: number | null = stats.nativeWatchBudget;
  const deferredInterests: number = stats.deferredInterests;
  const subscriptions: number = stats.subscriptions;
  return `${active}:${inotifyInstances}:${workerThreads}:${nativeWatches}:${nativeWatchBudget}:${deferredInterests}:${subscriptions}`;
}

function inspectBatch(batch: ChangeBatch): string {
  const sequence: bigint = batch.sequence;
  const exclusionGeneration: bigint = batch.exclusionGeneration;
  const rootGeneration: bigint = batch.rootState.generation;
  const device: bigint = batch.rootState.identity.device;
  const inode: bigint = batch.rootState.identity.inode;
  const firstBytes: Uint8Array | undefined = batch.invalidatedPathBytes[0];
  const firstPath: string | undefined = batch.invalidatedPaths[0];
  const collapsed: boolean = batch.pathEncodingCollapsed;
  return `${sequence}:${exclusionGeneration}:${rootGeneration}:${device}:${inode}:${firstBytes?.byteLength}:${firstPath}:${collapsed}:${describeCoverage(batch.coverage)}`;
}

async function inspectSubscription(subscription: Subscription): Promise<void> {
  const initialCoverage: Coverage = subscription.initialCoverage;
  const initialRootGeneration: bigint = subscription.initialRootState.generation;
  const observedSequence: bigint = subscription.observedState.sequence;
  const observedExclusionGeneration: bigint =
    subscription.observedState.exclusionGeneration;
  const observedDevice: bigint = subscription.observedState.rootState.identity.device;
  const observedCoverage: Coverage = subscription.observedState.coverage;
  const nativeExclusionGeneration: bigint = subscription.exclusionGeneration;
  const nativeRootGeneration: bigint = subscription.rootState.generation;
  const automaticStatus: string = describeAutomaticStatus(
    subscription.automaticReconciliation,
  );

  const exactBytes = new Uint8Array([0xff, 0x00, 0x61]);
  const replacement: Coverage = await subscription.replaceExclusions(
    1n,
    ["ignored", exactBytes],
  );
  const reconciliation = await subscription.reconcile();
  const reconciledGeneration: bigint = reconciliation.exclusionGeneration;
  const recovered = await subscription.recoverRoot({
    identityPolicy: "accept-replacement",
  });
  const recoveryDescription = inspectRecovery(recovered);
  const stats = subscription.stats();
  const rawEvents: bigint = stats.rawEvents;
  const batchesDelivered: bigint = stats.batchesDelivered;
  const batchesDropped: bigint = stats.batchesDropped;
  const topologyScans: bigint = stats.topologyScans;
  const overflowEvents: bigint = stats.overflowEvents;
  const callbackErrors: bigint = stats.callbackErrors;
  const bridgeDeliveryErrors: bigint = stats.bridgeDeliveryErrors;
  const watchedDirectories: number = stats.watchedDirectories;
  const deferredDirectories: number = stats.deferredDirectories;
  const disposed: boolean = stats.disposed;
  const disposal: Promise<void> = subscription.dispose();
  await disposal;

  void initialCoverage;
  void initialRootGeneration;
  void observedSequence;
  void observedExclusionGeneration;
  void observedDevice;
  void observedCoverage;
  void nativeExclusionGeneration;
  void nativeRootGeneration;
  void automaticStatus;
  void replacement;
  void reconciledGeneration;
  void recoveryDescription;
  void rawEvents;
  void batchesDelivered;
  void batchesDropped;
  void topologyScans;
  void overflowEvents;
  void callbackErrors;
  void bridgeDeliveryErrors;
  void watchedDirectories;
  void deferredDirectories;
  void disposed;
}

async function usePublicApi(): Promise<void> {
  inspectCapabilities();

  const unbounded: Engine = createEngine();
  const explicitUnbounded: Engine = createEngine({ nativeWatchBudget: null });
  const bounded: Engine = createEngine({ nativeWatchBudget: 8_192 });
  const configuredBudget: number | null = bounded.nativeWatchBudget;
  const runtime = inspectRuntimeStats(bounded.runtimeStats());

  const callback = (batch: ChangeBatch): void => {
    inspectBatch(batch);
  };
  const expressionBatches: ChangeBatch[] = [];
  const expressionCallback: BatchCallback = (batch) => expressionBatches.push(batch);
  const asyncCallback: BatchCallback = async (batch, context) => {
    const callbackContext: BatchCallbackContext = context;
    inspectBatch(batch);
    if (callbackContext.signal.aborted) callbackContext.stop();
    await Promise.resolve();
  };
  void expressionCallback;
  void asyncCallback;
  const establishmentController = new AbortController();
  const fromEngine: Subscription = await bounded.subscribe(
    "/tmp/watchbound-types",
    callback,
    {
      watchLimit: 4_096,
      batchWindowMs: 10,
      maxBatchPaths: 1_024,
      outputQueueCapacity: 64,
      automaticReconciliation: {
        maxAttempts: 3,
        initialDelayMs: 25,
        maxDelayMs: 1_000,
      },
      signal: establishmentController.signal,
    },
  );
  const fromDefault: Subscription = await subscribe(
    "/tmp/watchbound-types",
    callback,
    { automaticReconciliation: false },
  );

  await inspectSubscription(fromEngine);
  await fromDefault.dispose();

  const normalized: WatchboundError = normalizeWatchboundError(
    new Error("native failure"),
    "subscribe",
  );
  inspectUnknownError(normalized);
  const constructed = new WatchboundError("conflict", {
    code: WatchboundErrorCode.RUNTIME_CONFIGURATION_CONFLICT,
    operation: "subscribe",
    systemCause: {
      domain: "os",
      code: 16,
      kind: "ResourceBusy",
      message: "resource busy",
    },
  });
  const retryAfter: WatchboundRetryAfterType = WatchboundRetryAfter.RUNTIME_DISPOSED;
  inspectUnknownError(constructed);
  inspectRetryAfter(retryAfter);

  void unbounded;
  void explicitUnbounded;
  void configuredBudget;
  void runtime;
}

const validComplete: Coverage = { state: "complete" };
const validStatus: AutomaticReconciliationStatus = { state: "idle" };

// @ts-expect-error Coverage is a closed discriminated union.
const invalidCoverage: Coverage = { state: "degraded" };
// @ts-expect-error Automatic-reconciliation states are closed.
const invalidAutomaticStatus: AutomaticReconciliationStatus = { state: "waiting" };
// @ts-expect-error Native watch budgets are numbers, not bigint values.
createEngine({ nativeWatchBudget: 8_192n });
// @ts-expect-error Subscription watch limits are numbers, not bigint values.
subscribe("/tmp/watchbound-types", () => {}, { watchLimit: 8_192n });
subscribe("/tmp/watchbound-types", () => {}, {
  // @ts-expect-error Automatic-reconciliation option values are numeric.
  automaticReconciliation: { maxAttempts: "3" },
});
subscribe("/tmp/watchbound-types", () => {}, {
  // @ts-expect-error Establishment cancellation requires an AbortSignal.
  signal: { aborted: false },
});

declare const negativeSubscription: Subscription;
declare const negativeBatch: ChangeBatch;
declare const negativeStats: ReturnType<Subscription["stats"]>;

// @ts-expect-error Exclusion generations must be bigint values.
negativeSubscription.replaceExclusions(1, []);
// @ts-expect-error Exclusions accept only strings or exact-byte Uint8Array values.
negativeSubscription.replaceExclusions(1n, [42]);
// @ts-expect-error Root identity policy is a closed union.
negativeSubscription.recoverRoot({ identityPolicy: "automatic" });
// @ts-expect-error Batch sequence values are bigint values.
const numberSequence: number = negativeBatch.sequence;
// @ts-expect-error Root identity fields are bigint values.
const numberDevice: number = negativeBatch.rootState.identity.device;
// @ts-expect-error Cumulative counters are bigint values.
const numberEvents: number = negativeStats.rawEvents;
// @ts-expect-error Capability objects are immutable.
capabilities.schemaVersion = 2;
// @ts-expect-error Nested capability objects are immutable.
capabilities.options.engine.nativeWatchBudget.maximum = 10;
// @ts-expect-error Engine configuration is immutable.
boundedForNegative.nativeWatchBudget = null;
// @ts-expect-error Observed state is immutable.
negativeSubscription.observedState.sequence = 2n;
// @ts-expect-error Batch invalidation arrays are immutable.
negativeBatch.invalidatedPaths.push("/tmp/extra");
// @ts-expect-error Error codes are a closed union.
const invalidErrorCode: WatchboundErrorCodeType = "WATCHBOUND_UNKNOWN";
// @ts-expect-error Operations are a closed union.
const invalidOperation: WatchboundOperation = "start";
const invalidSystemCause: WatchboundSystemCause = {
  // @ts-expect-error System-cause domains are closed.
  domain: "filesystem",
  message: "bad domain",
};

declare const boundedForNegative: Engine;

void validComplete;
void validStatus;
void invalidCoverage;
void invalidAutomaticStatus;
void numberSequence;
void numberDevice;
void numberEvents;
void invalidErrorCode;
void invalidOperation;
void invalidSystemCause;
void usePublicApi;
