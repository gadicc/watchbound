export declare const WatchboundErrorCode: Readonly<{
  INVALID_ARGUMENT: "WATCHBOUND_INVALID_ARGUMENT";
  SUBSCRIPTION_CLOSED: "WATCHBOUND_SUBSCRIPTION_CLOSED";
  TOPOLOGY_TRANSACTION_CONFLICT: "WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT";
  OPERATION_INTERRUPTED: "WATCHBOUND_OPERATION_INTERRUPTED";
  CONSUMER_BACKPRESSURE: "WATCHBOUND_CONSUMER_BACKPRESSURE";
  ROOT_STATE_CONFLICT: "WATCHBOUND_ROOT_STATE_CONFLICT";
  ROOT_UNAVAILABLE: "WATCHBOUND_ROOT_UNAVAILABLE";
  RESOURCE_UNAVAILABLE: "WATCHBOUND_RESOURCE_UNAVAILABLE";
  RUNTIME_CONFIGURATION_CONFLICT: "WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT";
  INTERNAL: "WATCHBOUND_INTERNAL";
}>;

export type WatchboundErrorCode =
  (typeof WatchboundErrorCode)[keyof typeof WatchboundErrorCode];

export declare const WatchboundRetryAfter: Readonly<{
  TOPOLOGY_TRANSACTION_SETTLES: "topology-transaction-settles";
  DELIVERY_DRAINS: "delivery-drains";
  ROOT_STATE_CHANGES: "root-state-changes";
  FILESYSTEM_STATE_CHANGES: "filesystem-state-changes";
  RESOURCES_AVAILABLE: "resources-available";
  RUNTIME_DISPOSED: "runtime-disposed";
}>;

export type WatchboundRetryAfter =
  (typeof WatchboundRetryAfter)[keyof typeof WatchboundRetryAfter];

export type WatchboundOperation =
  | "create-engine"
  | "subscribe"
  | "replace-exclusions"
  | "reconcile"
  | "recover-root"
  | "dispose"
  | "deliver-batch";

export interface WatchboundSystemCause {
  readonly domain: "os" | "node-api";
  readonly code?: string | number;
  readonly kind?: string;
  readonly message: string;
}

export interface WatchboundErrorOptions {
  readonly code: WatchboundErrorCode;
  readonly operation: WatchboundOperation;
  readonly systemCause?: WatchboundSystemCause;
  readonly cause?: unknown;
}

export declare class WatchboundError extends Error {
  readonly name: "WatchboundError";
  readonly code: WatchboundErrorCode;
  readonly operation: WatchboundOperation;
  readonly retryable: boolean;
  readonly retryAfter?: WatchboundRetryAfter;
  readonly systemCause?: Readonly<WatchboundSystemCause>;
  readonly cause?: unknown;

  constructor(message: string, options: WatchboundErrorOptions);
}

export declare function isWatchboundError(error: unknown): error is WatchboundError;

export declare function normalizeWatchboundError(
  error: unknown,
  operation: WatchboundOperation,
): WatchboundError;

export type PartialReason =
  | "resource-limit"
  | "permission"
  | "transient-error";

export type UncertainReason =
  | "event-overflow"
  | "root-replaced"
  | "topology-race"
  | "consumer-backpressure";

export type Coverage =
  | { state: "complete" }
  | {
      state: "partial";
      reason: PartialReason;
      watchedDirectories: number;
      deferredDirectories: number;
    }
  | { state: "uncertain"; reason: UncertainReason };

export interface ChangeBatch {
  readonly sequence: bigint;
  readonly exclusionGeneration: bigint;
  readonly invalidatedPaths: readonly string[];
  readonly invalidatedPathBytes: readonly Uint8Array[];
  readonly pathEncodingCollapsed: boolean;
  readonly rootState: RootState;
  readonly coverage: Coverage;
}

/**
 * The establishment baseline or the last batch whose callback entered
 * JavaScript. Native state and completed operations may be ahead of it.
 */
export interface ObservedState {
  readonly sequence: bigint;
  readonly exclusionGeneration: bigint;
  readonly rootState: RootState;
  readonly coverage: Coverage;
}

export interface RootIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export type RootAttachment = "attached" | "lost";

export type RootLossEvidence =
  | "root-self-event"
  | "root-watch-loss"
  | "path-identity-mismatch"
  | "multiple";

export interface RootState {
  readonly generation: bigint;
  readonly identity: RootIdentity;
  readonly attachment: RootAttachment;
  readonly lossEvidence?: RootLossEvidence;
}

export type RootIdentityPolicy = "original-only" | "accept-replacement";

export type RootRecoveryAttachment =
  | "original-restored"
  | "replacement-adopted"
  | "not-attached";

export type RootRecoveryFailureReason =
  | "replacement-not-accepted"
  | "candidate-missing"
  | "candidate-not-directory"
  | "symlink-ancestry"
  | "identity-unstable"
  | "root-watch-unavailable";

interface RootRecoveryResultBase {
  readonly previousRootState: RootState;
  readonly currentRootState: RootState;
  readonly exclusionGeneration: bigint;
  readonly coverage: Coverage;
  readonly boundarySequence: bigint | null;
}

export interface AttachedRootRecoveryResult extends RootRecoveryResultBase {
  readonly attachment: "original-restored" | "replacement-adopted";
  readonly reason?: never;
  readonly candidateIdentity: RootIdentity;
}

export interface NotAttachedRootRecoveryResult extends RootRecoveryResultBase {
  readonly attachment: "not-attached";
  readonly reason: RootRecoveryFailureReason;
  readonly candidateIdentity?: RootIdentity;
}

export type RootRecoveryResult =
  | AttachedRootRecoveryResult
  | NotAttachedRootRecoveryResult;

export interface SubscriptionOptions {
  watchLimit?: number;
  batchWindowMs?: number;
  maxBatchPaths?: number;
  outputQueueCapacity?: number;
  automaticReconciliation?: boolean | AutomaticReconciliationOptions;
}

export interface AutomaticReconciliationOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export interface Stats {
  watchedDirectories: number;
  deferredDirectories: number;
  rawEvents: bigint;
  batchesDelivered: bigint;
  batchesDropped: bigint;
  topologyScans: bigint;
  overflowEvents: bigint;
  callbackErrors: bigint;
  bridgeDeliveryErrors: bigint;
  disposed: boolean;
}

export interface Subscription {
  readonly initialCoverage: Coverage;
  readonly initialRootState: RootState;
  readonly observedState: ObservedState;
  readonly exclusionGeneration: bigint;
  readonly rootState: RootState;
  readonly automaticReconciliation: AutomaticReconciliationStatus;
  stats(): Stats;
  replaceExclusions(
    generation: bigint,
    prefixes: readonly (string | Uint8Array)[],
  ): Promise<Coverage>;
  reconcile(): Promise<ReconciliationResult>;
  recoverRoot(options: {
    identityPolicy: RootIdentityPolicy;
  }): Promise<RootRecoveryResult>;
  dispose(): Promise<void>;
}

export interface ReconciliationResult {
  exclusionGeneration: bigint;
  coverage: Coverage;
}

export type RecoverableUncertainReason =
  | "event-overflow"
  | "topology-race"
  | "consumer-backpressure";

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

export interface Capabilities {
  readonly schemaVersion: 1;
  readonly versions: {
    readonly wrapper: string;
    readonly native: string;
    readonly engine: string;
    readonly bindingApi: number;
  };
  readonly build: {
    readonly delivery: "controlled-source-build";
    readonly prebuilt: false;
    readonly profile: string;
    readonly targetTriple: string;
    readonly nodeApi: number;
    readonly rustMinimum: "1.88";
  };
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
  readonly support: {
    readonly status: "target-pending-clean-ci";
    readonly operatingSystem: {
      readonly family: "linux";
      readonly distribution: "ubuntu";
      readonly version: "24.04";
      readonly kernelMinimum: "6.8";
    };
    readonly architecture: "x64";
    readonly libc: { readonly family: "glibc"; readonly version: "2.39" };
    readonly nodeRange: ">=24.18.0 <25";
    readonly rustMinimum: "1.88";
    readonly packageManager: "pnpm@10.33.2";
    readonly delivery: "controlled-source-build";
    readonly rootThreatModel: "trusted-stable-local-roots";
  };
  readonly features: {
    readonly recursive: boolean;
    readonly movedInTreeDiscovery: boolean;
    readonly explicitWatchLimits: boolean;
    readonly processNativeWatchBudget: boolean;
    readonly sharedNativeWatches: boolean;
    readonly overflowReporting: boolean;
    readonly dynamicExclusions: boolean;
    readonly reconciliation: boolean;
    readonly automaticReconciliation: boolean;
    readonly rootReplacementRecovery: boolean;
    readonly exactPathBytes: boolean;
    readonly orderedBatches: boolean;
    readonly observedState: boolean;
  };
  readonly options: {
    readonly engine: {
      readonly nativeWatchBudget: NullableIntegerOptionCapability<
        "process-runtime",
        "unique-native-watches"
      >;
    };
    readonly subscription: {
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
  };
}

export interface IntegerRangeCapability {
  readonly default: number;
  readonly minimum: number;
  readonly maximum: number;
}

export interface IntegerOptionCapability extends IntegerRangeCapability {
  readonly type: "integer";
  readonly unit: "milliseconds" | "paths" | "batches";
}

export interface NullableIntegerOptionCapability<
  Scope extends "process-runtime" | "subscription" =
    | "process-runtime"
    | "subscription",
  Accounting extends "unique-native-watches" | "logical-directories" =
    | "unique-native-watches"
    | "logical-directories",
> {
  readonly type: "integer-or-null";
  readonly scope: Scope;
  readonly accounting: Accounting;
  readonly default: null;
  readonly minimum: number;
  readonly maximum: number;
  readonly nullMeaning: "no-watchbound-limit";
}

export interface EngineOptions {
  nativeWatchBudget?: number | null;
}

export interface RuntimeStats {
  readonly active: boolean;
  readonly inotifyInstances: number;
  readonly workerThreads: number;
  readonly nativeWatches: number;
  readonly nativeWatchBudget: number | null;
  readonly deferredInterests: number;
  readonly subscriptions: number;
}

export interface Engine {
  readonly nativeWatchBudget: number | null;
  runtimeStats(): Readonly<RuntimeStats>;
  subscribe(
    root: string,
    onBatch: (batch: ChangeBatch) => void,
    options?: SubscriptionOptions,
  ): Promise<Subscription>;
}

export declare const capabilities: Readonly<Capabilities>;

export declare function createEngine(options?: EngineOptions): Engine;

export declare function subscribe(
  root: string,
  onBatch: (batch: ChangeBatch) => void,
  options?: SubscriptionOptions,
): Promise<Subscription>;
