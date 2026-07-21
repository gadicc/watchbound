/* Hand-owned public declarations. Native generation writes native.generated.d.ts. */

export declare function assertWrapperVersion(version: string): void
export declare class NativeEngine {
  get nativeWatchBudget(): number | null
  runtimeStats(): JsRuntimeStats
  subscribe(root: string, options: JsSubscriptionOptions | undefined | null, callback: (arg0: JsChangeBatch) => void): Promise<NativeSubscription>
}

export declare class NativeSubscription {
  get initialCoverage(): JsCoverage
  get initialRootState(): JsRootState
  stats(): JsStats
  get exclusionGeneration(): bigint
  get rootState(): JsRootState
  replaceExclusions(generation: bigint, prefixes: Array<Buffer>): Promise<JsCoverage>
  reconcile(): Promise<JsReconciliationResult>
  recoverRoot(identityPolicy: string): Promise<JsRootRecoveryResult>
  dispose(): Promise<void>
}

export declare function bindingMetadata(): JsBindingMetadata

export declare function capabilities(): JsCapabilities

export declare function createEngine(options?: JsEngineOptions | undefined | null): NativeEngine

export interface JsBindingMetadata {
  schemaVersion: number
  bindingApiVersion: number
  nativeVersion: string
  engineVersion: string
  nodeApiVersion: number
  targetTriple: string
  buildProfile: string
}

export interface JsCapabilities {
  schemaVersion: number
  recursive: boolean
  movedInTreeDiscovery: boolean
  explicitWatchLimits: boolean
  overflowReporting: boolean
  dynamicExclusions: boolean
  reconciliation: boolean
  rootReplacementRecovery: boolean
  exactPathBytes: boolean
  processNativeWatchBudget: boolean
  sharedNativeWatches: boolean
  subscriptionDefaults: JsSubscriptionDefaults
  positiveIntegerMinimum: number
  positiveIntegerMaximum: number
}

export interface JsChangeBatch {
  sequence: bigint
  exclusionGeneration: bigint
  rootState: JsRootState
  /**
   * Exact Linux path bytes. The JavaScript wrapper may decode UTF-8 paths,
   * but the native boundary never performs a lossy conversion.
   */
  invalidatedPaths: Array<Buffer>
  coverage: JsCoverage
}

export interface JsCoverage {
  state: string
  reason?: string
  watchedDirectories?: number
  deferredDirectories?: number
}

export interface JsEngineOptions {
  nativeWatchBudget?: number | null
}

export interface JsReconciliationResult {
  exclusionGeneration: bigint
  coverage: JsCoverage
}

export interface JsRootIdentity {
  device: bigint
  inode: bigint
}

export interface JsRootRecoveryResult {
  attachment: string
  reason?: string
  previousRootState: JsRootState
  candidateIdentity?: JsRootIdentity
  currentRootState: JsRootState
  exclusionGeneration: bigint
  coverage: JsCoverage
  boundarySequence?: bigint
}

export interface JsRootState {
  generation: bigint
  identity: JsRootIdentity
  attachment: string
  lossEvidence?: string
}

export interface JsRuntimeStats {
  active: boolean
  inotifyInstances: number
  workerThreads: number
  nativeWatches: number
  nativeWatchBudget?: number
  deferredInterests: number
  subscriptions: number
}

export interface JsStats {
  watchedDirectories: number
  deferredDirectories: number
  rawEvents: bigint
  batchesDelivered: bigint
  batchesDropped: bigint
  topologyScans: bigint
  overflowEvents: bigint
  callbackErrors: bigint
  bridgeDeliveryErrors: bigint
  disposed: boolean
}

export interface JsSubscriptionDefaults {
  watchLimit?: number
  batchWindowMs: number
  maxBatchPaths: number
  outputQueueCapacity: number
}

export interface JsSubscriptionOptions {
  watchLimit?: number
  batchWindowMs?: number
  maxBatchPaths?: number
  outputQueueCapacity?: number
}

export declare function subscribe(root: string, options: JsSubscriptionOptions | undefined | null, callback: (arg0: JsChangeBatch) => void): Promise<NativeSubscription>
