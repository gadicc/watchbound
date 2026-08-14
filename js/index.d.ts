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
  | "qualify-root"
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

/** Final qualification state for a target, host, or subscription root. */
export type QualificationState = "qualified" | "unqualified" | "unknown";

/** Machine-readable reason that full root qualification did not succeed. */
export type QualificationReason =
  | "packaged-target-mismatch"
  | "packaged-target-unqualified"
  | "kernel-below-floor"
  | "kernel-unknown"
  | "glibc-below-floor"
  | "glibc-unknown"
  | "wsl-detected"
  | "wsl-unknown"
  | "container-detected"
  | "container-unknown"
  | "root-unavailable"
  | "root-not-directory"
  | "filesystem-network"
  | "filesystem-fuse"
  | "filesystem-overlay"
  | "filesystem-unknown";

/** Evidence comparing one observed runtime version with a published floor. */
export interface VersionFloorEvidence {
  /** Whether the observed version satisfies the floor. */
  readonly state: "satisfied" | "below-floor" | "unknown";
  /** Observed version, or null when unavailable. */
  readonly observed: string | null;
  /** Required minimum version. */
  readonly minimum: string;
}

/** Evidence for WSL or container execution. */
export interface EnvironmentEvidence {
  /** Whether the environment was detected, not detected, or could not be determined. */
  readonly state: "detected" | "not-detected" | "unknown";
}

/** Root filesystem family relevant to Watchbound qualification. */
export type RootFilesystemKind =
  | "ordinary-local"
  | "network"
  | "fuse"
  | "overlay"
  | "unknown";

/** Machine-readable full target, host, and root qualification result. */
export interface RootQualificationResult {
  /** Version of this qualification result schema. */
  readonly schemaVersion: 1;
  /** Conservative aggregate state; unknown evidence never qualifies. */
  readonly state: QualificationState;
  /** Deduplicated reasons preventing a qualified result. */
  readonly reasons: readonly QualificationReason[];
  /** Packaged target compatibility and exact-commit qualification evidence. */
  readonly target: {
    /** Target evidence state. */
    readonly state: "qualified" | "unqualified";
    /** Loader-selected target identifier. */
    readonly packagedTargetId:
      | "linux-x64-gnu"
      | "linux-arm64-gnu"
      | "linux-arm-gnueabihf";
    /** Whether platform, architecture, libc family, and triple agree. */
    readonly runtimeMatchesPackagedTarget: boolean;
    /** Exact-commit qualification state of the target artifact. */
    readonly qualification: SupportStatus;
  };
  /** Host floor and execution-environment evidence. */
  readonly host: {
    /** Conservative host evidence state. */
    readonly state: QualificationState;
    /** Host kernel comparison with the supported floor. */
    readonly kernelFloor: VersionFloorEvidence;
    /** Runtime glibc comparison with the supported floor. */
    readonly glibcFloor: VersionFloorEvidence;
    /** WSL detection evidence. */
    readonly wsl: EnvironmentEvidence;
    /** Container detection evidence. */
    readonly container: EnvironmentEvidence;
  };
  /** Canonical root and filesystem evidence. */
  readonly root: {
    /** Conservative root evidence state. */
    readonly state: QualificationState;
    /** Absolute lexical pathname supplied to qualification. */
    readonly lexicalPath: string;
    /** Exact bytes of the absolute lexical pathname. */
    readonly lexicalPathBytes: Uint8Array;
    /** Canonical pathname, or null when unavailable or not valid UTF-8. */
    readonly physicalPath: string | null;
    /** Exact canonical bytes, or null when resolution failed. */
    readonly physicalPathBytes: Uint8Array | null;
    /** Filesystem classification and Linux statfs magic. */
    readonly filesystem: {
      /** Qualification-relevant filesystem family. */
      readonly kind: RootFilesystemKind;
      /** Unsigned hexadecimal statfs magic, or null when unavailable. */
      readonly magic: string | null;
    };
  };
}

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

/** Relationship between exact byte invalidations and their string projection. */
export type PathEncoding = "complete" | "root-collapsed" | "bytes-only";

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
  /** How exact byte invalidations were projected into string paths. */
  readonly pathEncoding: PathEncoding;
  /** Whether at least one exact byte invalidation was not representable as UTF-8. */
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

/** Policy controlling admission of symbolic links in a subscription root. */
export type RootPathPolicy = "strict" | "resolve-physical";

/** Immutable lexical-to-physical root resolution committed at establishment. */
export interface ResolvedRoot {
  /** Path admission policy used for this subscription. */
  readonly policy: RootPathPolicy;
  /** Absolute caller spelling, preserving `.` and `..` components. */
  readonly lexicalPath: string;
  /** Exact Linux bytes of the absolute caller spelling. */
  readonly lexicalPathBytes: Uint8Array;
  /** Canonical physical root, or null when those bytes are not valid UTF-8. */
  readonly physicalPath: string | null;
  /** Exact Linux bytes of the canonical physical root. */
  readonly physicalPathBytes: Uint8Array;
  /** Path namespace used by callbacks, invalidations, and exclusions. */
  readonly pathForm: "physical";
  /** Later changes to a resolving lexical alias are not followed. */
  readonly aliasTracking: "establishment-snapshot";
  /** Physical directory identity committed by establishment. */
  readonly identity: RootIdentity;
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
  /** Identity of the physical root described by `Subscription.resolvedRoot`. */
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
   * Controls root symlink handling. `strict` rejects symlinks in the entire
   * ancestry. `resolve-physical` resolves the exact supplied path once and
   * watches that canonical directory without following later alias changes.
   */
  rootPathPolicy?: RootPathPolicy;
  /**
   * Exact normalized root-relative directory prefixes excluded during initial
   * establishment at exclusion generation zero.
   */
  initialExclusions?: readonly (string | Uint8Array)[];
  /**
   * Exact directory component names pruned at every depth from exclusion
   * generation zero. Strings encode as UTF-8; Uint8Array preserves exact bytes.
   */
  excludedDirectoryNames?: readonly (string | Uint8Array)[];
  /**
   * Exact non-empty root-relative excluded paths whose boundary lifecycle is
   * invalidated while their descendants remain unwatched.
   */
  observedExcludedPaths?: readonly (string | Uint8Array)[];
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

/** A complete exclusion policy committed under one exclusion generation. */
export interface ExclusionPolicy {
  /** Exact normalized root-relative directory namespace prefixes. */
  prefixes?: readonly (string | Uint8Array)[];
  /** Exact directory component names pruned at every depth. */
  excludedDirectoryNames?: readonly (string | Uint8Array)[];
  /** Exact excluded paths whose boundary lifecycle remains observable. */
  observedExcludedPaths?: readonly (string | Uint8Array)[];
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
  /** Immutable mapping from the supplied lexical root to the watched root. */
  readonly resolvedRoot: ResolvedRoot;
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
   * Atomically replaces the complete exact-byte exclusion policy.
   *
   * The legacy prefix array remains supported. It clears the two newer policy
   * sets. Policy-object fields default to empty, and generations must increase
   * monotonically.
   */
  replaceExclusions(
    generation: bigint,
    exclusions: readonly (string | Uint8Array)[] | ExclusionPolicy,
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

/** One configured GNU/Linux native target and its exact qualification state. */
export interface SupportTargetCapability {
  /** Stable target identifier used by packages and qualification evidence. */
  readonly id:
    | "linux-x64-gnu"
    | "linux-arm64-gnu"
    | "linux-arm-gnueabihf";
  /** Qualification state for the exact source commit and native artifact. */
  readonly status: SupportStatus;
  /** npm package containing only this target's native artifact. */
  readonly package:
    | "@gadicc/watchbound-node-linux-x64-gnu"
    | "@gadicc/watchbound-node-linux-arm64-gnu"
    | "@gadicc/watchbound-node-linux-arm-gnueabihf";
  /** Rust target triple embedded in the native binding. */
  readonly targetTriple:
    | "x86_64-unknown-linux-gnu"
    | "aarch64-unknown-linux-gnu"
    | "armv7-unknown-linux-gnueabihf";
  /** Operating-system family required by the inotify engine. */
  readonly operatingSystem: "linux";
  /** Node architecture selected by the architecture-neutral loader. */
  readonly architecture: "x64" | "arm64" | "arm";
  /** Required 32-bit ARM ABI, or null for non-ARM targets. */
  readonly armAbi: {
    /** Minimum ARM instruction-set version. */
    readonly version: 7;
    /** Required GNU hard-float calling convention. */
    readonly floatAbi: "hard";
    /** Required byte order. */
    readonly endianness: "little";
  } | null;
  /** C-library ABI and audited maximum required symbol version. */
  readonly libc: {
    /** Supported C-library family. */
    readonly family: "glibc";
    /** Highest permitted required `GLIBC_*` version in a released ELF. */
    readonly maximumRequiredSymbolVersion: "2.35";
  };
  /** Oldest kernel baseline exercised by the qualification matrix. */
  readonly kernelMinimum: "5.15";
  /** JavaScript runtime range admitted independently of the native ABI floor. */
  readonly nodeRange: ">=18.15.0";
  /** Qualification-lane identifiers applicable to this architecture. */
  readonly qualificationLanes: readonly string[];
}

/** One distribution or runtime lane used to qualify native delivery. */
export interface QualificationLaneCapability {
  /** Stable lane identifier. */
  readonly id: string;
  /** Distribution or runtime name. */
  readonly distribution: string;
  /** Pinned distribution version or flake identity. */
  readonly version: string;
  /** Compatibility family represented by this lane. */
  readonly family: "debian" | "rpm" | "pacman" | "nix";
  /** Native architectures covered by the lane. */
  readonly architectures: readonly ("x64" | "arm64" | "arm")[];
  /** Evidence required before this lane can support a release claim. */
  readonly evidence:
    | "runtime-qualification-required"
    | "qemu-user-runtime-required"
    | "native-nix-closure-required";
}

/** Loader-selected packaged-target compatibility, not host/root qualification. */
export interface CurrentRuntimeQualificationCapability {
  /** Explicitly narrows this object to packaged-target compatibility. */
  readonly scope: "packaged-target-compatibility";
  /** Stable identifier of the artifact selected by the loader. */
  readonly packagedTargetId:
    | "linux-x64-gnu"
    | "linux-arm64-gnu"
    | "linux-arm-gnueabihf";
  /** Whether platform, architecture, libc, and target triple all agree. */
  readonly runtimeMatchesPackagedTarget: boolean;
  /** Exact-commit qualification state of the packaged target. */
  readonly qualification: SupportStatus;
  /** True only for an exact runtime match whose packaged target is qualified. */
  readonly targetCompatible: boolean;
  /** Full host/root qualification requires {@link qualifyRoot}. */
  readonly fullQualification: "qualify-root-required";
}

/** A deliberately excluded target and the reason it cannot be claimed. */
export interface IntentionallyUnsupportedTargetCapability {
  /** Unsupported target family. */
  readonly target: "linux-arm-soft-float" | "linux-musl" | "non-linux";
  /** Human-readable scope boundary; consumers must not parse it as policy. */
  readonly reason: string;
}

/**
 * Frozen, JSON-serializable description of this build, runtime, supported
 * target, public features, option bounds, and observability contract.
 */
export interface Capabilities {
  /** Version of this capabilities object’s schema. */
  readonly schemaVersion: 9;
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
    /** Exact local artifact selected by the architecture-neutral loader. */
    readonly packagedTarget: {
      /** Stable target identifier. */
      readonly id:
        | "linux-x64-gnu"
        | "linux-arm64-gnu"
        | "linux-arm-gnueabihf";
      /** Target package name, or null for a controlled source build. */
      readonly package:
        | "@gadicc/watchbound-node-linux-x64-gnu"
        | "@gadicc/watchbound-node-linux-arm64-gnu"
        | "@gadicc/watchbound-node-linux-arm-gnueabihf"
        | null;
      /** Exact native basename selected without fallback. */
      readonly binary:
        | "watchbound.linux-x64-gnu.node"
        | "watchbound.linux-arm64-gnu.node"
        | "watchbound.linux-arm-gnueabihf.node";
      /** SHA-256 of the selected local native artifact. */
      readonly sha256: string;
      /** Node architecture of the selected artifact. */
      readonly architecture: "x64" | "arm64" | "arm";
      /** Required 32-bit ARM ABI, or null for non-ARM targets. */
      readonly armAbi: {
        /** Minimum ARM instruction-set version. */
        readonly version: 7;
        /** Required GNU hard-float calling convention. */
        readonly floatAbi: "hard";
        /** Required byte order. */
        readonly endianness: "little";
      } | null;
      /** C-library ABI of the selected artifact. */
      readonly libc: "glibc";
      /** Qualification state of this exact target. */
      readonly qualification: SupportStatus;
    };
  };
  /** Observed facts about the current process and host runtime. */
  readonly runtime: {
    readonly platform: string;
    readonly architecture: string;
    /** Loader-attested 32-bit ARM ABI facts, or null outside ARM runtimes. */
    readonly armAbi: {
      /** Minimum attested ARM instruction-set version. */
      readonly version: 7;
      /** Attested ARM floating-point calling convention. */
      readonly floatAbi: "hard";
      /** Attested runtime byte order. */
      readonly endianness: "little";
    } | null;
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
    /** Marks the unchanged single-target fields below as a legacy view. */
    readonly scope: "legacy-primary-target";
    readonly status: SupportStatus;
    readonly operatingSystem: {
      readonly family: "linux";
      readonly distribution: "ubuntu";
      readonly version: "24.04";
      readonly kernelMinimum: "6.8";
    };
    readonly architecture: "x64";
    readonly libc: { readonly family: "glibc"; readonly version: "2.39" };
    /** JavaScript runtime range admitted independently of tested runtime evidence. */
    readonly nodeRange: ">=18.15.0";
    readonly rustMinimum: "1.88";
    readonly packageManager: "pnpm@10.33.2";
    readonly delivery: WatchboundPackageDelivery;
    readonly rootThreatModel: "trusted-stable-local-roots";
    /** All packaged native targets and their independent qualification state. */
    readonly targets: readonly SupportTargetCapability[];
    /** Distribution/runtime lanes without implied derivative qualification. */
    readonly qualificationLanes: readonly QualificationLaneCapability[];
    /** Detected derivative names grouped by their compatibility baseline. */
    readonly recognizedCompatibilityFamilies: Readonly<
      Record<string, readonly string[]>
    >;
    /** Facts connecting the selected artifact to this runtime and its evidence. */
    readonly currentRuntime: CurrentRuntimeQualificationCapability;
    /** Explicitly excluded target families that must fail closed. */
    readonly intentionallyUnsupported:
      readonly IntentionallyUnsupportedTargetCapability[];
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
    readonly directoryNameExclusions: boolean;
    readonly observedExcludedPaths: boolean;
    readonly reconciliation: boolean;
    readonly automaticReconciliation: boolean;
    readonly rootReplacementRecovery: boolean;
    readonly physicalRootResolution: boolean;
    readonly rootQualification: boolean;
    readonly bytesOnlyInvalidations: boolean;
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
      readonly rootPathPolicy: {
        readonly type: "enum";
        readonly values: readonly ["strict", "resolve-physical"];
        readonly default: "strict";
        readonly outputPaths: "physical";
        readonly aliasTracking: "establishment-snapshot";
        readonly nonUtf8PhysicalRoot: "bytes-only-invalidations";
      };
      readonly initialExclusions: InitialExclusionsOptionCapability;
      readonly excludedDirectoryNames: DirectoryNameExclusionsOptionCapability;
      readonly observedExcludedPaths: ObservedExcludedPathsOptionCapability;
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
    /** Complete set of string-projection states emitted on change batches. */
    readonly pathEncodingStates: readonly [
      "complete",
      "root-collapsed",
      "bytes-only",
    ];
    /** Establishment delivery waits for the physical output namespace. */
    readonly earlyDelivery: "buffered-until-resolved-root";
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

/** Metadata for exact directory-component exclusions applied at every depth. */
export interface DirectoryNameExclusionsOptionCapability {
  /** Accepted option form. */
  readonly type: "directory-name-array";
  /** Default directory-name exclusion set. */
  readonly default: readonly [];
  /** Lifecycle phase that consumes the option. */
  readonly scope: "subscription-establishment";
  /** Components preserve and compare exact Linux bytes. */
  readonly matching: "exact-component-bytes";
  /** Names apply to directories at every depth below the root. */
  readonly depth: "every-directory-depth";
  /** Initial names are committed at generation zero. */
  readonly exclusionGeneration: 0;
}

/** Metadata for explicit excluded paths whose boundary remains observable. */
export interface ObservedExcludedPathsOptionCapability {
  /** Accepted option form. */
  readonly type: "observed-excluded-path-array";
  /** Default observed-path set. */
  readonly default: readonly [];
  /** Lifecycle phase that consumes the option. */
  readonly scope: "subscription-establishment";
  /** Paths preserve and compare exact Linux bytes. */
  readonly matching: "exact-bytes";
  /** Paths are normalized, non-empty, and relative to the watched root. */
  readonly paths: "normalized-nonempty-root-relative";
  /** Every observed boundary's descendants remain excluded and unwatched. */
  readonly descendants: "excluded-and-unwatched";
  /** Boundary lifecycle changes produce conservative invalidations. */
  readonly boundaryDelivery: "conservative-invalidation";
  /** Initial observed paths are committed at generation zero. */
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
 * Evaluates packaged-target, host-floor, environment, and root-filesystem
 * evidence without starting a watcher or acquiring native resources.
 */
export declare function qualifyRoot(root: string): Readonly<RootQualificationResult>;

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
