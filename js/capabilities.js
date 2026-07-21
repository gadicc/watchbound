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

export function buildCapabilities(native, metadata) {
  if (native?.schemaVersion !== 1 || metadata?.schemaVersion !== 1) {
    throw new Error("native capability metadata does not use schema version 1");
  }

  const runtime = runtimeFacts();
  const minimum = native.positiveIntegerMinimum;
  const maximum = native.positiveIntegerMaximum;
  const defaults = native.subscriptionDefaults;

  return deepFreeze({
    schemaVersion: 1,
    versions: {
      wrapper: WRAPPER_VERSION,
      native: metadata.nativeVersion,
      engine: metadata.engineVersion,
      bindingApi: metadata.bindingApiVersion,
    },
    build: {
      delivery: "controlled-source-build",
      prebuilt: false,
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
      delivery: "controlled-source-build",
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
      nativeCallbackQueueCapacity: 1,
    },
  });
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
