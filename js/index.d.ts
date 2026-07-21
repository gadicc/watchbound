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

export interface RootRecoveryResult {
  readonly attachment: RootRecoveryAttachment;
  readonly reason?: RootRecoveryFailureReason;
  readonly previousRootState: RootState;
  readonly candidateIdentity?: RootIdentity;
  readonly currentRootState: RootState;
  readonly exclusionGeneration: bigint;
  readonly coverage: Coverage;
  readonly boundarySequence: bigint | null;
}

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
  recursive: true;
  movedInTreeDiscovery: boolean;
  explicitWatchLimits: boolean;
  overflowReporting: boolean;
  dynamicExclusions: boolean;
  reconciliation: boolean;
  automaticReconciliation: boolean;
  rootReplacementRecovery: boolean;
  exactPathBytes: true;
}

export declare const capabilities: Readonly<Capabilities>;

export declare function subscribe(
  root: string,
  onBatch: (batch: ChangeBatch) => void,
  options?: SubscriptionOptions,
): Promise<Subscription>;
