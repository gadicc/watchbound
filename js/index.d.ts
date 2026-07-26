/**
 * A resource-aware recursive directory watcher for supported Linux systems.
 *
 * Watchbound reports conservative path invalidations together with explicit
 * complete, partial, or uncertain filesystem coverage.
 *
 * @example Watch a directory and join disposal.
 * ```ts
 * import { subscribe } from "watchbound";
 *
 * const subscription = await subscribe("/workspace", (batch) => {
 *   for (const path of batch.invalidatedPaths) {
 *     console.log(path);
 *   }
 * });
 *
 * await subscription.dispose();
 * ```
 *
 * @module
 */

/** Stable machine-readable error codes emitted by Watchbound operations. */
export declare const WatchboundErrorCode: Readonly<{
  INVALID_ARGUMENT: "WATCHBOUND_INVALID_ARGUMENT";
  SUBSCRIPTION_CLOSED: "WATCHBOUND_SUBSCRIPTION_CLOSED";
  TOPOLOGY_TRANSACTION_CONFLICT: "WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT";
  OPERATION_INTERRUPTED: "WATCHBOUND_OPERATION_INTERRUPTED";
  OPERATION_CANCELLED: "WATCHBOUND_OPERATION_CANCELLED";
  CONSUMER_BACKPRESSURE: "WATCHBOUND_CONSUMER_BACKPRESSURE";
  ROOT_STATE_CONFLICT: "WATCHBOUND_ROOT_STATE_CONFLICT";
  ROOT_UNAVAILABLE: "WATCHBOUND_ROOT_UNAVAILABLE";
  RESOURCE_UNAVAILABLE: "WATCHBOUND_RESOURCE_UNAVAILABLE";
  RUNTIME_CONFIGURATION_CONFLICT: "WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT";
  INTERNAL: "WATCHBOUND_INTERNAL";
}>;

/** A machine-readable error code emitted by a Watchbound operation. */
export type WatchboundErrorCode =
  (typeof WatchboundErrorCode)[keyof typeof WatchboundErrorCode];

/** Stable conditions that describe when a retryable operation may be retried. */
export declare const WatchboundRetryAfter: Readonly<{
  TOPOLOGY_TRANSACTION_SETTLES: "topology-transaction-settles";
  DELIVERY_DRAINS: "delivery-drains";
  ROOT_STATE_CHANGES: "root-state-changes";
  FILESYSTEM_STATE_CHANGES: "filesystem-state-changes";
  RESOURCES_AVAILABLE: "resources-available";
  RUNTIME_DISPOSED: "runtime-disposed";
}>;

/** A condition that must change before retrying a failed operation. */
export type WatchboundRetryAfter =
  (typeof WatchboundRetryAfter)[keyof typeof WatchboundRetryAfter];

/** The public operation during which a {@link WatchboundError} occurred. */
export type WatchboundOperation =
  | "create-engine"
  | "subscribe"
  | "replace-exclusions"
  | "reconcile"
  | "recover-root"
  | "dispose"
  | "deliver-batch";

/** How the JavaScript wrapper and its native addon were delivered. */
export type WatchboundPackageDelivery =
  | "controlled-source-build"
  | "bundled-native-package";

/** Sanitized operating-system or Node-API details for a structured error. */
export interface WatchboundSystemCause {
  /** Subsystem that reported the failure. */
  readonly domain: "os" | "node-api";
  /** Platform-specific error code, when one is available. */
  readonly code?: string | number;
  /** Platform-specific error category, when one is available. */
  readonly kind?: string;
  /** Sanitized diagnostic message from the underlying subsystem. */
  readonly message: string;
}

/** Structured fields used to construct a {@link WatchboundError}. */
export interface WatchboundErrorOptions {
  /** Stable machine-readable failure code. */
  readonly code: WatchboundErrorCode;
  /** Public operation that failed. */
  readonly operation: WatchboundOperation;
  /** Sanitized underlying subsystem failure. */
  readonly systemCause?: WatchboundSystemCause;
  /** Original JavaScript failure, when one exists. */
  readonly cause?: unknown;
}

/** A stable, structured error thrown or rejected by the public API. */
export declare class WatchboundError extends Error {
  /** Stable class name for the structured error. */
  readonly name: "WatchboundError";
  /** Stable machine-readable failure code. */
  readonly code: WatchboundErrorCode;
  /** Public operation that failed. */
  readonly operation: WatchboundOperation;
  /** Whether retrying may succeed after the reported condition changes. */
  readonly retryable: boolean;
  /** Condition that should change before retrying. */
  readonly retryAfter?: WatchboundRetryAfter;
  /** Sanitized underlying subsystem failure. */
  readonly systemCause?: Readonly<WatchboundSystemCause>;
  /** Original JavaScript failure, when one exists. */
  readonly cause?: unknown;

  /** Creates a structured error with stable machine-readable fields. */
  constructor(message: string, options: WatchboundErrorOptions);
}

/** Returns whether an unknown value is a {@link WatchboundError}. */
export declare function isWatchboundError(error: unknown): error is WatchboundError;

/** Converts an unknown failure into a {@link WatchboundError}. */
export declare function normalizeWatchboundError(
  error: unknown,
  operation: WatchboundOperation,
): WatchboundError;

/** Why a subscription covers only part of its requested directory tree. */
export type PartialReason =
  | "resource-limit"
  | "permission"
  | "transient-error";

/** Why delivered invalidations may not describe every affected path. */
export type UncertainReason =
  | "event-overflow"
  | "root-replaced"
  | "topology-race"
  | "consumer-backpressure";

/**
 * The watcher’s conservative claim about filesystem coverage.
 *
 * Consumers should rescan an appropriate boundary whenever coverage is
 * uncertain and must not treat partial coverage as complete.
 */
export type Coverage =
  | { state: "complete" }
  | {
      state: "partial";
      reason: PartialReason;
      watchedDirectories: number;
      deferredDirectories: number;
    }
  | { state: "uncertain"; reason: UncertainReason };

/** One ordered batch of conservative path invalidations. */
export interface ChangeBatch {
  /** Monotonic sequence assigned to this batch. */
  readonly sequence: bigint;
  /** Exclusion-set generation applied to this batch. */
  readonly exclusionGeneration: bigint;
  /** Absolute string paths conservatively invalidated by this batch. */
  readonly invalidatedPaths: readonly string[];
  /** Exact Linux path bytes for each native invalidation. */
  readonly invalidatedPathBytes: readonly Uint8Array[];
  /** Whether an unrepresentable child path forced string output to the root. */
  readonly pathEncodingCollapsed: boolean;
  /** Root identity and attachment state at this batch boundary. */
  readonly rootState: RootState;
  /** Coverage claim at this batch boundary. */
  readonly coverage: Coverage;
}

/** Stable lifecycle context passed to every invocation of a batch callback. */
export interface BatchCallbackContext {
  /** Aborted synchronously when stop or subscription disposal begins. */
  readonly signal: AbortSignal;
  /**
   * Idempotently requests disposal without awaiting the current callback.
   * Join the request later with Subscription.dispose().
   */
  stop(): void;
}

/**
 * Receives ordered invalidation batches.
 *
 * Promise-like results are awaited before the next callback is admitted.
 */
export type BatchCallback =
  | ((batch: ChangeBatch, context: BatchCallbackContext) => void)
  | ((
      batch: ChangeBatch,
      context: BatchCallbackContext,
    ) => PromiseLike<unknown>);

/**
 * The establishment baseline or the last batch whose callback entered
 * JavaScript. Native state and completed operations may be ahead of it.
 */
export interface ObservedState {
  /** Sequence of the last callback that entered JavaScript. */
  readonly sequence: bigint;
  /** Exclusion generation at the observed callback boundary. */
  readonly exclusionGeneration: bigint;
  /** Root state at the observed callback boundary. */
  readonly rootState: RootState;
  /** Coverage at the observed callback boundary. */
  readonly coverage: Coverage;
}

/** Stable Linux device and inode identity for a watched root. */
export interface RootIdentity {
  /** Linux device identifier. */
  readonly device: bigint;
  /** Linux inode identifier. */
  readonly inode: bigint;
}

/** Whether the subscription is currently attached to its watched root. */
export type RootAttachment = "attached" | "lost";

/** Evidence that caused Watchbound to mark a root as lost. */
export type RootLossEvidence =
  | "root-self-event"
  | "root-watch-loss"
  | "path-identity-mismatch"
  | "multiple";

/** The current identity, attachment, and generation of a watched root. */
export interface RootState {
  /** Monotonic generation incremented when the root identity changes. */
  readonly generation: bigint;
  /** Identity Watchbound currently associates with the subscription root. */
  readonly identity: RootIdentity;
  /** Whether the subscription remains attached to that root identity. */
  readonly attachment: RootAttachment;
  /** Evidence for a lost attachment. */
  readonly lossEvidence?: RootLossEvidence;
}

/** Policy controlling whether root recovery may adopt a replacement identity. */
export type RootIdentityPolicy = "original-only" | "accept-replacement";

/** The attachment outcome of a root-recovery attempt. */
export type RootRecoveryAttachment =
  | "original-restored"
  | "replacement-adopted"
  | "not-attached";

/** Why a root-recovery attempt could not attach the subscription. */
export type RootRecoveryFailureReason =
  | "replacement-not-accepted"
  | "candidate-missing"
  | "candidate-not-directory"
  | "symlink-ancestry"
  | "identity-unstable"
  | "root-watch-unavailable";

/** Successful result of restoring or replacing a lost watched root. */
export interface AttachedRootRecoveryResult {
  /** Root state before the recovery attempt. */
  readonly previousRootState: RootState;
  /** Root state after the recovery attempt. */
  readonly currentRootState: RootState;
  /** Exclusion-set generation applied during recovery. */
  readonly exclusionGeneration: bigint;
  /** Coverage after the recovery attempt. */
  readonly coverage: Coverage;
  /** Sequence boundary for the recovery transition, if one was emitted. */
  readonly boundarySequence: bigint | null;
  /** How the subscription became attached. */
  readonly attachment: "original-restored" | "replacement-adopted";
  /** Successful outcomes do not carry a failure reason. */
  readonly reason?: never;
  /** Identity of the candidate accepted during recovery. */
  readonly candidateIdentity: RootIdentity;
}

/** Result of a root-recovery attempt that remains unattached. */
export interface NotAttachedRootRecoveryResult {
  /** Root state before the recovery attempt. */
  readonly previousRootState: RootState;
  /** Root state after the recovery attempt. */
  readonly currentRootState: RootState;
  /** Exclusion-set generation applied during recovery. */
  readonly exclusionGeneration: bigint;
  /** Coverage after the recovery attempt. */
  readonly coverage: Coverage;
  /** Sequence boundary for the recovery transition, if one was emitted. */
  readonly boundarySequence: bigint | null;
  /** Indicates that no root candidate was attached. */
  readonly attachment: "not-attached";
  /** Reason that recovery could not attach a candidate. */
  readonly reason: RootRecoveryFailureReason;
  /** Identity inspected during recovery, when one was available. */
  readonly candidateIdentity?: RootIdentity;
}

/** Result of explicitly attempting to recover a lost watched root. */
export type RootRecoveryResult =
  | AttachedRootRecoveryResult
  | NotAttachedRootRecoveryResult;

/** Options for establishing a recursive subscription. */
export interface SubscriptionOptions {
  /**
   * Exact normalized root-relative directory prefixes excluded during initial
   * establishment at exclusion generation zero.
   */
  initialExclusions?: readonly (string | Uint8Array)[];
  /** Maximum logical directories covered by this subscription. */
  watchLimit?: number;
  /** Milliseconds used to coalesce native events into a batch. */
  batchWindowMs?: number;
  /** Maximum detailed invalidated paths retained in one batch. */
  maxBatchPaths?: number;
  /** Maximum native batches waiting for JavaScript delivery. */
  outputQueueCapacity?: number;
  /** Enables the default or a customized bounded reconciliation policy. */
  automaticReconciliation?: boolean | AutomaticReconciliationOptions;
  /**
   * Cancels establishment only. Once subscribe resolves, aborting this signal
   * is a no-op and the returned subscription must be disposed explicitly.
   */
  signal?: AbortSignal;
}

/** Bounds for the optional automatic-reconciliation retry policy. */
export interface AutomaticReconciliationOptions {
  /** Maximum reconciliation attempts for one uncertain transition. */
  maxAttempts?: number;
  /** Delay in milliseconds before the first retry. */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds after exponential backoff. */
  maxDelayMs?: number;
}

/** Cumulative counters and current resource gauges for one subscription. */
export interface Stats {
  /** Logical directories currently watched. */
  watchedDirectories: number;
  /** Logical directories deferred by resource limits. */
  deferredDirectories: number;
  /** Native inotify events processed. */
  rawEvents: bigint;
  /** Batches delivered to the JavaScript bridge. */
  batchesDelivered: bigint;
  /** Over-detailed batches dropped under bounded pressure. */
  batchesDropped: bigint;
  /** Recursive topology scans performed. */
  topologyScans: bigint;
  /** Native inotify queue overflows observed. */
  overflowEvents: bigint;
  /** Consumer callback failures contained by the wrapper. */
  callbackErrors: bigint;
  /** Native-to-JavaScript delivery failures. */
  bridgeDeliveryErrors: bigint;
  /** Whether joined subscription disposal has completed. */
  disposed: boolean;
}

/** An established recursive directory subscription and its lifecycle controls. */
export interface Subscription {
  /** Immutable coverage established before subscription resolution. */
  readonly initialCoverage: Coverage;
  /** Immutable root state established before subscription resolution. */
  readonly initialRootState: RootState;
  /** Last state whose callback entered JavaScript. */
  readonly observedState: ObservedState;
  /** Latest native-backed exclusion generation. */
  readonly exclusionGeneration: bigint;
  /** Latest native-backed root state. */
  readonly rootState: RootState;
  /** Current automatic-reconciliation policy state. */
  readonly automaticReconciliation: AutomaticReconciliationStatus;
  /** Returns a snapshot of subscription counters and resource gauges. */
  stats(): Stats;
  /**
   * Atomically replaces exact-byte directory-prefix exclusions.
   *
   * Generations must increase monotonically.
   */
  replaceExclusions(
    generation: bigint,
    prefixes: readonly (string | Uint8Array)[],
  ): Promise<Coverage>;
  /** Rebuilds topology coverage after a recoverable uncertain transition. */
  reconcile(): Promise<ReconciliationResult>;
  /** Attempts to reattach a subscription whose watched root was replaced. */
  recoverRoot(options: {
    /** Controls whether a different root identity may be adopted. */
    identityPolicy: RootIdentityPolicy;
  }): Promise<RootRecoveryResult>;
  /**
   * Idempotently joins native disposal and any already-admitted callback.
   *
   * No callback can begin after the returned promise resolves.
   */
  dispose(): Promise<void>;
}

/** Coverage and exclusion generation produced by explicit reconciliation. */
export interface ReconciliationResult {
  /** Exclusion generation applied by the reconciliation transaction. */
  exclusionGeneration: bigint;
  /** Coverage established by reconciliation. */
  coverage: Coverage;
}

/** An uncertain coverage reason that automatic reconciliation can retry. */
export type RecoverableUncertainReason =
  | "event-overflow"
  | "topology-race"
  | "consumer-backpressure";

/** Current state of the bounded automatic-reconciliation policy. */
export type AutomaticReconciliationStatus =
  | { readonly state: "disabled" | "idle" | "disposing" | "disposed" }
  | {
      readonly state: "scheduled";
      readonly reason: RecoverableUncertainReason;
      readonly attempt: number;
      readonly delayMs: number;
    }
  | {
      readonly state: "reconciling";
      readonly reason: RecoverableUncertainReason;
      readonly attempt: number;
    }
  | {
      readonly state: "recovered" | "incomplete";
      readonly reason: RecoverableUncertainReason;
      readonly attempts: number;
      readonly exclusionGeneration: bigint;
      readonly coverage: Coverage;
    }
  | {
      readonly state: "exhausted";
      readonly reason: RecoverableUncertainReason;
      readonly attempts: number;
      readonly error: string;
    }
  | { readonly state: "blocked"; readonly reason: "root-replaced" }
  | {
      readonly state: "recovering-root";
      readonly identityPolicy: RootIdentityPolicy;
    };

/** Qualification status declared for the exact package build and target. */
export type SupportStatus = "target-pending-clean-ci" | "supported";

/**
 * Frozen, JSON-serializable description of this build, runtime, supported
 * target, public features, option bounds, and observability contract.
 */
export interface Capabilities {
  /** Version of this capabilities object’s schema. */
  readonly schemaVersion: 3;
  /** Wrapper, native engine, and binding API versions. */
  readonly versions: {
    readonly wrapper: string;
    readonly native: string;
    readonly engine: string;
    readonly bindingApi: number;
  };
  /** Immutable facts about the loaded package build. */
  readonly build: {
    readonly delivery: WatchboundPackageDelivery;
    readonly prebuilt: boolean;
    readonly profile: string;
    readonly targetTriple: string;
    readonly nodeApi: number;
    readonly rustMinimum: "1.88";
  };
  /** Observed facts about the current process and host runtime. */
  readonly runtime: {
    readonly platform: string;
    readonly architecture: string;
    readonly kernel: string;
    readonly libc: {
      readonly family: "glibc" | "musl" | "unknown";
      readonly version: string | null;
    };
    readonly node: {
      readonly version: string;
      readonly api: number | null;
    };
  };
  /** Exact maintained target and qualification status. */
  readonly support: {
    readonly status: SupportStatus;
    readonly operatingSystem: {
      readonly family: "linux";
      readonly distribution: "ubuntu";
      readonly version: "24.04";
      readonly kernelMinimum: "6.8";
    };
    readonly architecture: "x64";
    readonly libc: { readonly family: "glibc"; readonly version: "2.39" };
    readonly nodeRange: ">=24.15.0 <25";
    readonly rustMinimum: "1.88";
    readonly packageManager: "pnpm@10.33.2";
    readonly delivery: WatchboundPackageDelivery;
    readonly rootThreatModel: "trusted-stable-local-roots";
  };
  /** Public behavioral and lifecycle features of this build. */
  readonly features: {
    readonly recursive: boolean;
    readonly movedInTreeDiscovery: boolean;
    readonly explicitWatchLimits: boolean;
    readonly processNativeWatchBudget: boolean;
    readonly sharedNativeWatches: boolean;
    readonly overflowReporting: boolean;
    readonly initialExclusions: boolean;
    readonly dynamicExclusions: boolean;
    readonly reconciliation: boolean;
    readonly automaticReconciliation: boolean;
    readonly rootReplacementRecovery: boolean;
    readonly exactPathBytes: boolean;
    readonly orderedBatches: boolean;
    readonly observedState: boolean;
    readonly cancellableEstablishment: boolean;
    readonly sharedNodeDelivery: boolean;
  };
  /** Accepted option forms, defaults, bounds, and accounting rules. */
  readonly options: {
    readonly engine: {
      readonly nativeWatchBudget: NullableIntegerOptionCapability<
        "process-runtime",
        "unique-native-watches"
      >;
    };
    readonly subscription: {
      readonly initialExclusions: InitialExclusionsOptionCapability;
      readonly watchLimit: NullableIntegerOptionCapability<
        "subscription",
        "logical-directories"
      >;
      readonly batchWindowMs: IntegerOptionCapability;
      readonly maxBatchPaths: IntegerOptionCapability;
      readonly outputQueueCapacity: IntegerOptionCapability;
      readonly automaticReconciliation: {
        readonly forms: readonly ["boolean", "options"];
        readonly default: false;
        readonly maxAttempts: IntegerRangeCapability;
        readonly initialDelayMs: IntegerRangeCapability;
        readonly maxDelayMs: IntegerRangeCapability;
        readonly constraint: "maxDelayMs-gte-initialDelayMs";
      };
    };
  };
  /** State boundaries, counter encodings, and delivery behavior. */
  readonly observability: {
    readonly authoritativeState: "ordered-batches";
    readonly observedStateBoundary: "before-callback";
    readonly operationResultsMayLeadObservedState: true;
    readonly nativeGettersMayLeadObservedState: true;
    readonly initialCoverage: true;
    readonly initialRootState: true;
    readonly subscriptionStats: true;
    readonly runtimeStats: {
      readonly scope: "process";
      readonly nativeWatchAccounting: "unique-native-watches";
      readonly deferredAccounting: "logical-interests";
      readonly inactiveSnapshot: "zero";
    };
    readonly counterEncoding: {
      readonly sequences: "bigint";
      readonly cumulativeCounters: "bigint";
      readonly gauges: "number";
    };
    readonly nativeCallbackQueueCapacity: 1;
    readonly deliveryDispatcherScope: "node-environment";
    readonly deliveryAdmission: "single-credit";
    readonly callbackCompletion: "promise-aware-serialized";
    readonly callbackMaxInFlight: 1;
    readonly callbackErrorPolicy: "count-and-continue";
    readonly callbackDisposalPolicy: "join-pending-completion";
    readonly callbackTeardownPolicy: "abandon-pending-completion";
    readonly deliveryDispatcherWorkQuantum: 64;
    readonly deliveryDispatcherPollMilliseconds: 5;
  };
}

/** Metadata for subscribe-time exact directory-prefix exclusions. */
export interface InitialExclusionsOptionCapability {
  /** Accepted option form. */
  readonly type: "directory-prefix-array";
  /** Default initial exclusion set. */
  readonly default: readonly [];
  /** Lifecycle phase that consumes the option. */
  readonly scope: "subscription-establishment";
  /** Prefix comparison preserves exact Linux path bytes. */
  readonly matching: "exact-bytes";
  /** Prefixes must be normalized and relative to the watched root. */
  readonly paths: "normalized-root-relative";
  /** Initial exclusions are committed at generation zero. */
  readonly exclusionGeneration: 0;
}

/** Default, minimum, and maximum values for an integer option. */
export interface IntegerRangeCapability {
  /** Default option value. */
  readonly default: number;
  /** Smallest accepted option value. */
  readonly minimum: number;
  /** Largest accepted option value. */
  readonly maximum: number;
}

/** Metadata for a bounded integer subscription option. */
export interface IntegerOptionCapability extends IntegerRangeCapability {
  /** Accepted primitive option type. */
  readonly type: "integer";
  /** Unit represented by the integer. */
  readonly unit: "milliseconds" | "paths" | "batches";
}

/** Metadata for an optional watch limit and its accounting scope. */
export interface NullableIntegerOptionCapability<
  Scope extends "process-runtime" | "subscription" =
    | "process-runtime"
    | "subscription",
  Accounting extends "unique-native-watches" | "logical-directories" =
    | "unique-native-watches"
    | "logical-directories",
> {
  /** Accepted option form. */
  readonly type: "integer-or-null";
  /** Resource scope governed by the limit. */
  readonly scope: Scope;
  /** Quantity counted against the limit. */
  readonly accounting: Accounting;
  /** Default option value. */
  readonly default: null;
  /** Smallest accepted non-null value. */
  readonly minimum: number;
  /** Largest accepted non-null value. */
  readonly maximum: number;
  /** Meaning of an explicit or default null value. */
  readonly nullMeaning: "no-watchbound-limit";
}

/** Options used to create an {@link Engine}. */
export interface EngineOptions {
  /** Process-wide unique-native-watch budget, or null for no package limit. */
  nativeWatchBudget?: number | null;
}

/** Process-global native resource statistics observed by an engine. */
export interface RuntimeStats {
  /** Whether the shared native runtime is active. */
  readonly active: boolean;
  /** Number of process-owned inotify instances. */
  readonly inotifyInstances: number;
  /** Number of process-owned Watchbound runtime threads. */
  readonly workerThreads: number;
  /** Unique native directory watches currently installed. */
  readonly nativeWatches: number;
  /** Active process-native watch budget, or null when unlimited. */
  readonly nativeWatchBudget: number | null;
  /** Logical interests deferred by the active watch budget. */
  readonly deferredInterests: number;
  /** Established subscriptions sharing the native runtime. */
  readonly subscriptions: number;
}

/** A lightweight subscription factory sharing the process-native runtime. */
export interface Engine {
  /** Native watch budget requested for subscriptions created by this engine. */
  readonly nativeWatchBudget: number | null;
  /** Returns process-global native resource statistics. */
  runtimeStats(): Readonly<RuntimeStats>;
  /** Establishes a recursive subscription using this engine’s configuration. */
  subscribe(
    root: string,
    onBatch: BatchCallback,
    options?: SubscriptionOptions,
  ): Promise<Subscription>;
}

/** Frozen capabilities for the loaded wrapper, native addon, and runtime. */
export declare const capabilities: Readonly<Capabilities>;

/**
 * Creates a resource-free subscription factory.
 *
 * The first admitted subscription provisionally fixes the shared native watch
 * budget until the final runtime lease is disposed.
 */
export declare function createEngine(options?: EngineOptions): Engine;

/** Establishes a recursive subscription using the lazy default engine. */
export declare function subscribe(
  root: string,
  onBatch: BatchCallback,
  options?: SubscriptionOptions,
): Promise<Subscription>;
