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

export function buildCapabilities(native, metadata) {
  if (native?.schemaVersion !== 3 || metadata?.schemaVersion !== 1) {
    throw new Error(
      "native capability metadata does not use capability schema 3 and metadata schema 1",
    );
  }
  if (
    native.cancellableEstablishment !== true ||
    native.sharedNodeDelivery !== true ||
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

  return deepFreeze({
    schemaVersion: 3,
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
    },
    runtime,
    support: {
      status: "target-pending-clean-ci",
      operatingSystem: {
        family: "linux",
        distribution: "ubuntu",
        version: "24.04",
        kernelMinimum: "6.8",
      },
      architecture: "x64",
      libc: { family: "glibc", version: "2.39" },
      nodeRange: ">=24.18.0 <25",
      rustMinimum: "1.88",
      packageManager: "pnpm@10.33.2",
      delivery: WRAPPER_DELIVERY,
      rootThreatModel: "trusted-stable-local-roots",
    },
    features: {
      recursive: native.recursive,
      movedInTreeDiscovery: native.movedInTreeDiscovery,
      explicitWatchLimits: native.explicitWatchLimits,
      processNativeWatchBudget: native.processNativeWatchBudget,
      sharedNativeWatches: native.sharedNativeWatches,
      overflowReporting: native.overflowReporting,
      dynamicExclusions: native.dynamicExclusions,
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
