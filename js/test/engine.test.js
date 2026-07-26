import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  capabilities,
  createEngine,
  subscribe,
} from "../index.js";
import nativeMatrix from "../../config/native-matrix.json" with {
  type: "json",
};
import wrapperPackage from "../package.json" with { type: "json" };

const currentTarget = nativeMatrix.targets.find(
  (target) =>
    target.platform === process.platform &&
    target.architecture === process.arch,
);
assert.ok(
  currentTarget,
  `native matrix omits the current runtime ${process.platform}/${process.arch}`,
);

function assertDeeplyFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeeplyFrozen(nested, seen);
}

test("capability schema v4 separates packaged, runtime, and qualification state", () => {
  assert.deepEqual(Object.keys(capabilities), [
    "schemaVersion",
    "versions",
    "build",
    "runtime",
    "support",
    "features",
    "options",
    "observability",
  ]);
  assert.equal(capabilities.schemaVersion, 4);
  assert.deepEqual(capabilities.versions, {
    wrapper: wrapperPackage.version,
    native: wrapperPackage.version,
    engine: wrapperPackage.version,
    bindingApi: 3,
  });
  assert.deepEqual(capabilities.build, {
    delivery: "controlled-source-build",
    prebuilt: false,
    profile: "release",
    targetTriple: currentTarget.rustTarget,
    nodeApi: 6,
    rustMinimum: "1.88",
    packagedTarget: {
      id: currentTarget.id,
      package: null,
      binary: currentTarget.binary,
      sha256: capabilities.build.packagedTarget.sha256,
      architecture: currentTarget.architecture,
      libc: currentTarget.libc,
      qualification: currentTarget.qualification,
    },
  });
  assert.match(capabilities.build.packagedTarget.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(capabilities.runtime.platform, process.platform);
  assert.equal(capabilities.runtime.architecture, process.arch);
  assert.equal(capabilities.runtime.kernel, os.release());
  assert.equal(capabilities.runtime.node.version, process.versions.node);
  assert.equal(
    capabilities.runtime.node.api,
    process.versions.napi === undefined ? null : Number(process.versions.napi),
  );
  assert.ok(["glibc", "musl", "unknown"].includes(capabilities.runtime.libc.family));
  assert.ok(
    capabilities.runtime.libc.version === null ||
      typeof capabilities.runtime.libc.version === "string",
  );
  assert.deepEqual({
    scope: capabilities.support.scope,
    status: capabilities.support.status,
    operatingSystem: capabilities.support.operatingSystem,
    architecture: capabilities.support.architecture,
    libc: capabilities.support.libc,
    nodeRange: capabilities.support.nodeRange,
    rustMinimum: capabilities.support.rustMinimum,
    packageManager: capabilities.support.packageManager,
    delivery: capabilities.support.delivery,
    rootThreatModel: capabilities.support.rootThreatModel,
  }, {
    scope: "legacy-primary-target",
    status: "supported",
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
    delivery: "controlled-source-build",
    rootThreatModel: "trusted-stable-local-roots",
  });
  assert.equal(capabilities.support.targets.length, 2);
  assert.deepEqual(
    capabilities.support.targets.map(({ id, architecture, status }) => ({
      id,
      architecture,
      status,
    })),
    [
      {
        id: "linux-x64-gnu",
        architecture: "x64",
        status: "supported",
      },
      {
        id: "linux-arm64-gnu",
        architecture: "arm64",
        status: "supported",
      },
    ],
  );
  assert.equal(capabilities.support.qualificationLanes.length, 7);
  assert.deepEqual(capabilities.support.currentRuntime, {
    packagedTargetId: currentTarget.id,
    runtimeMatchesPackagedTarget: true,
    qualification: currentTarget.qualification,
    supported: currentTarget.qualification === "supported",
  });
  assert.deepEqual(
    capabilities.support.intentionallyUnsupported.map(({ target }) => target),
    ["linux-armv7-gnu", "linux-musl", "non-linux"],
  );
  assert.deepEqual(capabilities.features, {
    recursive: true,
    movedInTreeDiscovery: true,
    explicitWatchLimits: true,
    processNativeWatchBudget: true,
    sharedNativeWatches: true,
    overflowReporting: true,
    initialExclusions: true,
    dynamicExclusions: true,
    reconciliation: true,
    automaticReconciliation: true,
    rootReplacementRecovery: true,
    exactPathBytes: true,
    orderedBatches: true,
    observedState: true,
    cancellableEstablishment: true,
    sharedNodeDelivery: true,
  });
  assert.deepEqual(capabilities.options, {
    engine: {
      nativeWatchBudget: {
        type: "integer-or-null",
        scope: "process-runtime",
        accounting: "unique-native-watches",
        default: null,
        minimum: 1,
        maximum: 4_294_967_295,
        nullMeaning: "no-watchbound-limit",
      },
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
      watchLimit: {
        type: "integer-or-null",
        scope: "subscription",
        accounting: "logical-directories",
        default: null,
        minimum: 1,
        maximum: 4_294_967_295,
        nullMeaning: "no-watchbound-limit",
      },
      batchWindowMs: {
        type: "integer",
        unit: "milliseconds",
        default: 10,
        minimum: 1,
        maximum: 4_294_967_295,
      },
      maxBatchPaths: {
        type: "integer",
        unit: "paths",
        default: 1_024,
        minimum: 1,
        maximum: 4_294_967_295,
      },
      outputQueueCapacity: {
        type: "integer",
        unit: "batches",
        default: 64,
        minimum: 1,
        maximum: 4_294_967_295,
      },
      automaticReconciliation: {
        forms: ["boolean", "options"],
        default: false,
        maxAttempts: { default: 3, minimum: 1, maximum: 16 },
        initialDelayMs: { default: 25, minimum: 10, maximum: 60_000 },
        maxDelayMs: { default: 1_000, minimum: 10, maximum: 60_000 },
        constraint: "maxDelayMs-gte-initialDelayMs",
      },
    },
  });
  assert.deepEqual(capabilities.observability, {
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
    deliveryDispatcherScope: "node-environment",
    deliveryAdmission: "single-credit",
    callbackCompletion: "promise-aware-serialized",
    callbackMaxInFlight: 1,
    callbackErrorPolicy: "count-and-continue",
    callbackDisposalPolicy: "join-pending-completion",
    callbackTeardownPolicy: "abandon-pending-completion",
    deliveryDispatcherWorkQuantum: 64,
    deliveryDispatcherPollMilliseconds: 5,
  });
  assertDeeplyFrozen(capabilities);
  assert.doesNotThrow(() => JSON.stringify(capabilities));
});

test("createEngine validates and retains resource-free immutable configuration", () => {
  for (const nativeWatchBudget of [0, -1, 1.5, Number.NaN, Infinity, 4_294_967_296]) {
    assert.throws(
      () => createEngine({ nativeWatchBudget }),
      (error) => {
        assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
        assert.equal(error.operation, "create-engine");
        return true;
      },
    );
  }
  assert.throws(
    () => createEngine(null),
    (error) => {
      assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
      assert.equal(error.operation, "create-engine");
      return true;
    },
  );

  const unbounded = createEngine();
  const explicitUnbounded = createEngine({ nativeWatchBudget: null });
  const bounded = createEngine({ nativeWatchBudget: 7 });
  assert.equal(unbounded.nativeWatchBudget, null);
  assert.equal(explicitUnbounded.nativeWatchBudget, null);
  assert.equal(bounded.nativeWatchBudget, 7);
  assert.equal(Object.isFrozen(bounded), true);
  assert.deepEqual(bounded.runtimeStats(), {
    active: false,
    inotifyInstances: 0,
    workerThreads: 0,
    nativeWatches: 0,
    nativeWatchBudget: null,
    deferredInterests: 0,
    subscriptions: 0,
  });
  assertDeeplyFrozen(bounded.runtimeStats());
});

test("engine budgets own the first live process runtime and release it on joined disposal", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-engine-"));
  const firstRoot = path.join(parent, "first");
  const secondRoot = path.join(parent, "second");
  const thirdRoot = path.join(parent, "third");
  fs.mkdirSync(path.join(firstRoot, "a", "deep"), { recursive: true });
  fs.mkdirSync(secondRoot);
  fs.mkdirSync(thirdRoot);

  const firstEngine = createEngine({ nativeWatchBudget: 2 });
  const peerEngine = createEngine({ nativeWatchBudget: 2 });
  const unboundedEngine = createEngine();
  let first;
  let peer;
  let reconfigured;
  try {
    first = await firstEngine.subscribe(firstRoot, () => {});
    assert.deepEqual(first.initialCoverage, {
      state: "partial",
      reason: "resource-limit",
      watchedDirectories: 2,
      deferredDirectories: 1,
    });
    assert.deepEqual(firstEngine.runtimeStats(), {
      active: true,
      inotifyInstances: 1,
      workerThreads: 1,
      nativeWatches: 2,
      nativeWatchBudget: 2,
      deferredInterests: 1,
      subscriptions: 1,
    });

    peer = await peerEngine.subscribe(secondRoot, () => {});
    assert.equal(peerEngine.runtimeStats().subscriptions, 2);
    assert.ok(peerEngine.runtimeStats().nativeWatches <= 2);
    await assert.rejects(
      unboundedEngine.subscribe(thirdRoot, () => {}),
      (error) => {
        assert.equal(error.code, "WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT");
        assert.equal(error.operation, "subscribe");
        assert.equal(error.retryAfter, "runtime-disposed");
        return true;
      },
    );
    await assert.rejects(
      subscribe(thirdRoot, () => {}),
      (error) => {
        assert.equal(error.code, "WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT");
        return true;
      },
    );

    await Promise.all([first.dispose(), peer.dispose()]);
    first = undefined;
    peer = undefined;
    assert.equal(firstEngine.runtimeStats().active, false);

    reconfigured = await unboundedEngine.subscribe(thirdRoot, () => {});
    assert.equal(reconfigured.initialCoverage.state, "complete");
    assert.equal(unboundedEngine.runtimeStats().nativeWatchBudget, null);
  } finally {
    await Promise.all([
      first?.dispose(),
      peer?.dispose(),
      reconfigured?.dispose(),
    ]);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
