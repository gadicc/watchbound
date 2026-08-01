import fs from "node:fs";
import os from "node:os";

import {
  AUTOMATIC_RECONCILIATION_DEFAULTS,
  AUTOMATIC_RECONCILIATION_LIMITS,
} from "./automatic-reconciliation.js";

const wrapperPackage = JSON.parse(
  fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

export const WRAPPER_VERSION = wrapperPackage.version;
export const WRAPPER_DELIVERY = packageDelivery(wrapperPackage);

export function buildCapabilities(native, metadata, deliveryMetadata, matrix) {
  if (
    native?.schemaVersion !== 4 ||
    metadata?.schemaVersion !== 1 ||
    metadata?.bindingApiVersion !== 4 ||
    deliveryMetadata?.schemaVersion !== 1 ||
    matrix?.schemaVersion !== 1
  ) {
    throw new Error(
      "native capability, delivery, or target metadata uses an incompatible schema",
    );
  }
  if (
    native.cancellableEstablishment !== true ||
    native.sharedNodeDelivery !== true ||
    native.initialExclusions !== true ||
    native.directoryNameExclusions !== true ||
    native.observedExcludedPaths !== true ||
    native.nativeCallbackQueueCapacity !== 1 ||
    native.deliveryDispatcherScope !== "node-environment" ||
    native.deliveryAdmission !== "single-credit" ||
    native.callbackCompletion !== "wrapper-acknowledged-promise-settlement" ||
    native.callbackMaxInFlight !== 1 ||
    native.callbackErrorPolicy !== "count-and-continue" ||
    native.callbackDisposalPolicy !== "join-pending-completion" ||
    native.callbackTeardownPolicy !== "abandon-pending-completion" ||
    native.deliveryDispatcherWorkQuantum !== 64 ||
    native.deliveryDispatcherPollMilliseconds !== 5
  ) {
    throw new Error("native cancellation and shared-delivery capabilities are incompatible");
  }

  const runtime = runtimeFacts();
  const minimum = native.positiveIntegerMinimum;
  const maximum = native.positiveIntegerMaximum;
  const defaults = native.subscriptionDefaults;
  const prebuilt = WRAPPER_DELIVERY === "bundled-native-package";
  const supportTargets = matrix.targets.map((target) => ({
    id: target.id,
    status: target.qualification,
    package: target.package,
    targetTriple: target.rustTarget,
    operatingSystem: "linux",
    architecture: target.architecture,
    libc: {
      family: target.libc,
      maximumRequiredSymbolVersion: matrix.releaseBaseline.glibcMaximum,
    },
    kernelMinimum: matrix.releaseBaseline.kernelMinimum,
    nodeRange: matrix.nodeRange,
    qualificationLanes: matrix.qualificationLanes
      .filter((lane) => lane.architectures.includes(target.architecture))
      .map((lane) => lane.id),
  }));
  const runtimeMatchesPackagedTarget =
    runtime.platform === "linux" &&
    runtime.architecture === deliveryMetadata.architecture &&
    runtime.libc.family === deliveryMetadata.libc &&
    metadata.targetTriple === deliveryMetadata.targetTriple;
  const currentTarget = supportTargets.find(
    (target) => target.id === deliveryMetadata.targetId,
  );
  if (currentTarget === undefined) {
    throw new Error("loaded native target is absent from the support matrix");
  }

  return deepFreeze({
    schemaVersion: 5,
    versions: {
      wrapper: WRAPPER_VERSION,
      native: metadata.nativeVersion,
      engine: metadata.engineVersion,
      bindingApi: metadata.bindingApiVersion,
    },
    build: {
      delivery: WRAPPER_DELIVERY,
      prebuilt,
      profile: metadata.buildProfile,
      targetTriple: metadata.targetTriple,
      nodeApi: metadata.nodeApiVersion,
      rustMinimum: "1.88",
      packagedTarget: {
        id: deliveryMetadata.targetId,
        package: deliveryMetadata.targetPackage,
        binary: deliveryMetadata.binary,
        sha256: deliveryMetadata.sha256,
        architecture: deliveryMetadata.architecture,
        libc: deliveryMetadata.libc,
        qualification: deliveryMetadata.qualification,
      },
    },
    runtime,
    support: {
      scope: "legacy-primary-target",
      status: supportTargets.find((target) => target.architecture === "x64").status,
      operatingSystem: {
        family: "linux",
        distribution: "ubuntu",
        version: "24.04",
        kernelMinimum: "6.8",
      },
      architecture: "x64",
      libc: { family: "glibc", version: "2.39" },
      nodeRange: ">=24.15.0 <25",
      rustMinimum: "1.88",
      packageManager: "pnpm@10.33.2",
      delivery: WRAPPER_DELIVERY,
      rootThreatModel: "trusted-stable-local-roots",
      targets: supportTargets,
      qualificationLanes: matrix.qualificationLanes.map((lane) => ({
        id: lane.id,
        distribution: lane.distribution,
        version: lane.version,
        family: lane.family,
        architectures: lane.architectures,
        evidence: lane.evidence,
      })),
      recognizedCompatibilityFamilies: matrix.recognizedCompatibilityFamilies,
      currentRuntime: {
        packagedTargetId: currentTarget.id,
        runtimeMatchesPackagedTarget,
        qualification: currentTarget.status,
        supported:
          runtimeMatchesPackagedTarget && currentTarget.status === "supported",
      },
      intentionallyUnsupported: matrix.intentionallyUnsupported,
    },
    features: {
      recursive: native.recursive,
      movedInTreeDiscovery: native.movedInTreeDiscovery,
      explicitWatchLimits: native.explicitWatchLimits,
      processNativeWatchBudget: native.processNativeWatchBudget,
      sharedNativeWatches: native.sharedNativeWatches,
      overflowReporting: native.overflowReporting,
      initialExclusions: native.initialExclusions,
      dynamicExclusions: native.dynamicExclusions,
      directoryNameExclusions: native.directoryNameExclusions,
      observedExcludedPaths: native.observedExcludedPaths,
      reconciliation: native.reconciliation,
      automaticReconciliation: true,
      rootReplacementRecovery: native.rootReplacementRecovery,
      exactPathBytes: native.exactPathBytes,
      orderedBatches: true,
      observedState: true,
      cancellableEstablishment: native.cancellableEstablishment,
      sharedNodeDelivery: native.sharedNodeDelivery,
    },
    options: {
      engine: {
        nativeWatchBudget: nullableIntegerOption(
          "process-runtime",
          "unique-native-watches",
          null,
          minimum,
          maximum,
        ),
      },
      subscription: {
        initialExclusions: {
          type: "directory-prefix-array",
          default: [],
          scope: "subscription-establishment",
          matching: "exact-bytes",
          paths: "normalized-root-relative",
          exclusionGeneration: 0,
        },
        excludedDirectoryNames: {
          type: "directory-name-array",
          default: [],
          scope: "subscription-establishment",
          matching: "exact-component-bytes",
          depth: "every-directory-depth",
          exclusionGeneration: 0,
        },
        observedExcludedPaths: {
          type: "observed-excluded-path-array",
          default: [],
          scope: "subscription-establishment",
          matching: "exact-bytes",
          paths: "normalized-nonempty-root-relative",
          descendants: "excluded-and-unwatched",
          boundaryDelivery: "conservative-invalidation",
          exclusionGeneration: 0,
        },
        watchLimit: nullableIntegerOption(
          "subscription",
          "logical-directories",
          defaults.watchLimit ?? null,
          minimum,
          maximum,
        ),
        batchWindowMs: integerOption(
          "milliseconds",
          defaults.batchWindowMs,
          minimum,
          maximum,
        ),
        maxBatchPaths: integerOption(
          "paths",
          defaults.maxBatchPaths,
          minimum,
          maximum,
        ),
        outputQueueCapacity: integerOption(
          "batches",
          defaults.outputQueueCapacity,
          minimum,
          maximum,
        ),
        automaticReconciliation: {
          forms: ["boolean", "options"],
          default: false,
          maxAttempts: {
            default: AUTOMATIC_RECONCILIATION_DEFAULTS.maxAttempts,
            ...AUTOMATIC_RECONCILIATION_LIMITS.maxAttempts,
          },
          initialDelayMs: {
            default: AUTOMATIC_RECONCILIATION_DEFAULTS.initialDelayMs,
            ...AUTOMATIC_RECONCILIATION_LIMITS.delayMs,
          },
          maxDelayMs: {
            default: AUTOMATIC_RECONCILIATION_DEFAULTS.maxDelayMs,
            ...AUTOMATIC_RECONCILIATION_LIMITS.delayMs,
          },
          constraint: "maxDelayMs-gte-initialDelayMs",
        },
      },
    },
    observability: {
      authoritativeState: "ordered-batches",
      observedStateBoundary: "before-callback",
      operationResultsMayLeadObservedState: true,
      nativeGettersMayLeadObservedState: true,
      initialCoverage: true,
      initialRootState: true,
      subscriptionStats: true,
      runtimeStats: {
        scope: "process",
        nativeWatchAccounting: "unique-native-watches",
        deferredAccounting: "logical-interests",
        inactiveSnapshot: "zero",
      },
      counterEncoding: {
        sequences: "bigint",
        cumulativeCounters: "bigint",
        gauges: "number",
      },
      nativeCallbackQueueCapacity: native.nativeCallbackQueueCapacity,
      deliveryDispatcherScope: native.deliveryDispatcherScope,
      deliveryAdmission: native.deliveryAdmission,
      callbackCompletion: "promise-aware-serialized",
      callbackMaxInFlight: native.callbackMaxInFlight,
      callbackErrorPolicy: native.callbackErrorPolicy,
      callbackDisposalPolicy: native.callbackDisposalPolicy,
      callbackTeardownPolicy: native.callbackTeardownPolicy,
      deliveryDispatcherWorkQuantum: native.deliveryDispatcherWorkQuantum,
      deliveryDispatcherPollMilliseconds:
        native.deliveryDispatcherPollMilliseconds,
    },
  });
}

function packageDelivery(manifest) {
  const delivery = manifest?.watchbound?.delivery;
  if (
    delivery === undefined &&
    manifest?.name === "@jsr/gadicc__watchbound" &&
    manifest?.dependencies?.["@gadicc/watchbound-node"] === manifest.version
  ) {
    return "bundled-native-package";
  }
  if (
    delivery !== "controlled-source-build" &&
    delivery !== "bundled-native-package"
  ) {
    throw new Error("wrapper package delivery metadata is invalid");
  }
  return delivery;
}

export function normalizeRuntimeStats(stats) {
  return Object.freeze({
    active: stats.active,
    inotifyInstances: stats.inotifyInstances,
    workerThreads: stats.workerThreads,
    nativeWatches: stats.nativeWatches,
    nativeWatchBudget: stats.nativeWatchBudget ?? null,
    deferredInterests: stats.deferredInterests,
    subscriptions: stats.subscriptions,
  });
}

function nullableIntegerOption(scope, accounting, defaultValue, minimum, maximum) {
  return {
    type: "integer-or-null",
    scope,
    accounting,
    default: defaultValue,
    minimum,
    maximum,
    nullMeaning: "no-watchbound-limit",
  };
}

function integerOption(unit, defaultValue, minimum, maximum) {
  return {
    type: "integer",
    unit,
    default: defaultValue,
    minimum,
    maximum,
  };
}

function runtimeFacts() {
  let report;
  try {
    report = process.report?.getReport?.();
  } catch {
    report = undefined;
  }
  const glibcVersion = report?.header?.glibcVersionRuntime;
  const musl = report?.sharedObjects?.some((value) =>
    /(?:^|\/)(?:ld-musl|libc\.musl)/u.test(value),
  );
  return {
    platform: process.platform,
    architecture: process.arch,
    kernel: os.release(),
    libc: {
      family: typeof glibcVersion === "string" ? "glibc" : musl ? "musl" : "unknown",
      version: typeof glibcVersion === "string" ? glibcVersion : null,
    },
    node: {
      version: process.versions.node,
      api: process.versions.napi === undefined ? null : Number(process.versions.napi),
    },
  };
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
