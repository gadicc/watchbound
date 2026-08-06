/* Hand-owned public declarations. Native generation writes native.generated.d.ts. */

export declare function assertWrapperVersion(version: string): void
export declare class NativeEngine {
  get nativeWatchBudget(): number | null
  runtimeStats(): JsRuntimeStats
  createEstablishmentCancellation(): NativeEstablishmentCancellation
  subscribe(root: string, options: JsSubscriptionOptions | undefined | null, callback: (batch: JsChangeBatch, deliveryId: bigint) => boolean, cancellation?: NativeEstablishmentCancellation | undefined | null): Promise<NativeSubscription>
}

export declare class NativeEstablishmentCancellation {
  cancel(): void
  commitPublicSuccess(): boolean
}

export declare class NativeSubscription {
  get resolvedRoot(): JsResolvedRoot
  get initialCoverage(): JsCoverage
  get initialRootState(): JsRootState
  stats(): JsStats
  get exclusionGeneration(): bigint
  get rootState(): JsRootState
  replaceExclusions(generation: bigint, exclusions: Array<Buffer> | JsExclusionPolicy): Promise<JsCoverage>
  reconcile(): Promise<JsReconciliationResult>
  recoverRoot(identityPolicy: string): Promise<JsRootRecoveryResult>
  dispose(): Promise<void>
}

/**
 * @internal Unsupported deterministic integration-test seam. Not product API.
 */
export declare class __WatchboundTestOnlyThreadpoolBlocker {
  get started(): boolean
  block(): Promise<void>
  release(): void
}

export declare function bindingMetadata(): JsBindingMetadata

export declare function nativeDeliveryMetadata(): JsNativeDeliveryMetadata

export declare function nativeTargetMatrix(): JsNativeTargetMatrix

export declare function capabilities(): JsCapabilities

export declare function createEngine(options?: JsEngineOptions | undefined | null): NativeEngine

export declare function createEstablishmentCancellation(): NativeEstablishmentCancellation

/**
 * @internal Unsupported deterministic integration-test seam. Not product API.
 */
export declare function __watchboundTestOnlyCreateThreadpoolBlocker(): __WatchboundTestOnlyThreadpoolBlocker

/**
 * @internal Unsupported deterministic integration-test seam. Not product API.
 */
export declare function __watchboundTestOnlySynchronizeDispatcher(): void

export declare function deliveryDiagnostics(): JsDeliveryDiagnostics

/**
 * @internal Private wrapper acknowledgement for one native delivery ticket.
 */
export declare function completeDelivery(deliveryId: bigint, callbackError: boolean, stop: boolean): boolean

export interface JsBindingMetadata {
  schemaVersion: number
  bindingApiVersion: number
  nativeVersion: string
  engineVersion: string
  nodeApiVersion: number
  targetTriple: string
  buildProfile: string
}

export interface JsNativeDeliveryMetadata {
  schemaVersion: 1
  delivery: "controlled-source-build" | "bundled-native-package"
  loaderPackage: "@gadicc/watchbound-node"
  targetPackage: string | null
  targetId: string
  targetTriple: string
  architecture: "x64" | "arm64" | "arm"
  armAbi: { version: 7; floatAbi: "hard"; endianness: "little" } | null
  runtimeArmAbi: { version: 7; floatAbi: "hard"; endianness: "little" } | null
  libc: "glibc"
  binary: string
  sha256: string
  qualification: "target-pending-clean-ci" | "supported"
  glibcMaximum: string
  kernelMinimum: string
}

export interface JsNativeTargetMatrix {
  schemaVersion: 1
  nodeRange: ">=24.15.0 <25"
  nodeMinimum: "24.15.0"
  nodeApiMinimum: 6
  rustMinimum: "1.88"
  packageManager: "pnpm@10.33.2"
  rootThreatModel: "trusted-stable-local-roots"
  releaseBaseline: {
    distribution: "ubuntu"
    version: "22.04"
    kernelMinimum: "5.15"
    glibcMaximum: "2.35"
  }
  codexRuntime: {
    electron: "42.3.0"
    node: "24.15.0"
    nodeApi: 10
    asar: { archive: "app.asar"; nativeDirectory: "app.asar.unpacked" }
  }
  targets: Array<{
    id: string
    platform: "linux"
    architecture: "x64" | "arm64" | "arm"
    unameArchitecture: "x86_64" | "aarch64" | "armv7l"
    rustTarget: string
    libc: "glibc"
    armAbi?: { version: 7; floatAbi: "hard"; endianness: "little" }
    binary: string
    package: string
    runner: string
    overflowRunner: string | null
    nixSystem: "x86_64-linux" | "aarch64-linux" | null
    buildMode?: "cross"
    buildArchitecture?: "x64"
    linker?: "arm-linux-gnueabihf-gcc"
    linkerBinary?: "arm-linux-gnueabihf-ld"
    runtimeQualification?: "qemu-user-electron"
    runtimeEmulator?: "/usr/bin/qemu-arm"
    runtimeCpu?: "cortex-a15"
    runtimeRootfs?: {
      platform: "linux/arm/v7"
      image: string
      binfmtImage: string
      snapshot: string
      packages: Array<string>
    }
    codexElectron: {
      archiveArchitecture: "x64" | "arm64" | "armv7l"
      sha256SRI: string
    }
    qualification: "target-pending-clean-ci" | "supported"
    elf: {
      class: 1 | 2
      endianness: 1
      machine: number
      flags: number
      flagsDescription?: string
      machineName: string
      fileMachineName: string
      neededLibraries: Array<string>
    }
  }>
  qualificationLanes: Array<{
    id: string
    distribution: string
    version: string
    family: string
    evidence: string
    architectures: Array<"x64" | "arm64" | "arm">
    image: string
  }>
  recognizedCompatibilityFamilies: Record<string, Array<string>>
  intentionallyUnsupported: Array<{ target: string; reason: string }>
}

export interface JsCapabilities {
  schemaVersion: number
  recursive: boolean
  movedInTreeDiscovery: boolean
  explicitWatchLimits: boolean
  overflowReporting: boolean
  initialExclusions: boolean
  dynamicExclusions: boolean
  directoryNameExclusions: boolean
  observedExcludedPaths: boolean
  reconciliation: boolean
  rootReplacementRecovery: boolean
  physicalRootResolution: boolean
  exactPathBytes: boolean
  processNativeWatchBudget: boolean
  sharedNativeWatches: boolean
  cancellableEstablishment: boolean
  sharedNodeDelivery: boolean
  nativeCallbackQueueCapacity: number
  deliveryDispatcherScope: string
  deliveryAdmission: string
  callbackCompletion: string
  callbackMaxInFlight: number
  callbackErrorPolicy: string
  callbackDisposalPolicy: string
  callbackTeardownPolicy: string
  deliveryDispatcherWorkQuantum: number
  deliveryDispatcherPollMilliseconds: number
  subscriptionDefaults: JsSubscriptionDefaults
  positiveIntegerMinimum: number
  positiveIntegerMaximum: number
}

export interface JsDeliveryDiagnostics {
  dispatcherEnvironments: number
  dispatcherThreads: number
  registrations: number
  outstandingCallbacks: number
  cleanupCoordinatorThreads: number
  cleanupRequests: number
  activeThreadsafeFunctions: number
  environmentGenerations: bigint
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
  rootPathPolicy?: "strict" | "resolve-physical"
  initialExclusions?: Array<Buffer>
  excludedDirectoryNames?: Array<Buffer>
  observedExcludedPaths?: Array<Buffer>
  watchLimit?: number
  batchWindowMs?: number
  maxBatchPaths?: number
  outputQueueCapacity?: number
}

export interface JsResolvedRoot {
  policy: "strict" | "resolve-physical"
  lexicalPath: Buffer
  physicalPath: Buffer
  identity: JsRootIdentity
}

export interface JsExclusionPolicy {
  prefixes?: Array<Buffer>
  excludedDirectoryNames?: Array<Buffer>
  observedExcludedPaths?: Array<Buffer>
}

export declare function subscribe(root: string, options: JsSubscriptionOptions | undefined | null, callback: (batch: JsChangeBatch, deliveryId: bigint) => boolean, cancellation?: NativeEstablishmentCancellation | undefined | null): Promise<NativeSubscription>
