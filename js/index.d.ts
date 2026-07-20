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
  readonly coverage: Coverage;
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
  readonly automaticReconciliation: AutomaticReconciliationStatus;
  stats(): Stats;
  replaceExclusions(
    generation: bigint,
    prefixes: readonly (string | Uint8Array)[],
  ): Promise<Coverage>;
  reconcile(): Promise<ReconciliationResult>;
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
  | { readonly state: "blocked"; readonly reason: "root-replaced" };

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
