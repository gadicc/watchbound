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
  stats(): Stats;
  replaceExclusions(
    generation: bigint,
    prefixes: readonly (string | Uint8Array)[],
  ): Promise<Coverage>;
  dispose(): Promise<void>;
}

export interface Capabilities {
  recursive: true;
  movedInTreeDiscovery: boolean;
  explicitWatchLimits: boolean;
  overflowReporting: boolean;
  dynamicExclusions: boolean;
  rootReplacementRecovery: boolean;
  exactPathBytes: true;
}

export declare const capabilities: Readonly<Capabilities>;

export declare function subscribe(
  root: string,
  onBatch: (batch: ChangeBatch) => void,
  options?: SubscriptionOptions,
): Promise<Subscription>;
