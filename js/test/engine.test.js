import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  capabilities,
  createEngine,
  qualifyRoot,
  subscribe,
} from "../index.js";
import nativeMatrix from "../../config/native-matrix.json" with {
  type: "json",
};
import wrapperPackage from "../package.json" with { type: "json" };
import nativeBinding from "../../node/index.js";
import { buildCapabilities, evaluateQualification } from "../capabilities.js";

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

test("capability schema v9 exposes physical bytes-only and exact ARM ABI delivery", () => {
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
  assert.equal(capabilities.schemaVersion, 9);
  assert.deepEqual(capabilities.versions, {
    wrapper: wrapperPackage.version,
    native: wrapperPackage.version,
    engine: wrapperPackage.version,
    bindingApi: 5,
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
      armAbi: currentTarget.armAbi ?? null,
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
  const admittedRuntime = nativeBinding.runtimeAdmissionMetadata();
  assert.deepEqual(capabilities.runtime, {
    platform: admittedRuntime.platform,
    architecture: admittedRuntime.architecture,
    armAbi: admittedRuntime.armAbi,
    kernel: admittedRuntime.kernel,
    libc: {
      family: admittedRuntime.libc.family,
      version: admittedRuntime.libc.version,
    },
    node: admittedRuntime.node,
  });
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
    nodeRange: ">=18.15.0",
    rustMinimum: "1.88",
    packageManager: "pnpm@10.33.2",
    delivery: "controlled-source-build",
    rootThreatModel: "trusted-stable-local-roots",
  });
  assert.equal(capabilities.support.targets.length, 3);
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
      {
        id: "linux-arm-gnueabihf",
        architecture: "arm",
        status: "supported",
      },
    ],
  );
  assert.equal(capabilities.support.qualificationLanes.length, 8);
  assert.deepEqual(capabilities.support.currentRuntime, {
    scope: "packaged-target-compatibility",
    packagedTargetId: currentTarget.id,
    runtimeMatchesPackagedTarget: true,
    qualification: currentTarget.qualification,
    targetCompatible: currentTarget.qualification === "supported",
    fullQualification: "qualify-root-required",
  });
  assert.deepEqual(
    capabilities.support.intentionallyUnsupported.map(({ target }) => target),
    ["linux-arm-soft-float", "linux-musl", "non-linux"],
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
    directoryNameExclusions: true,
    observedExcludedPaths: true,
    reconciliation: true,
    automaticReconciliation: true,
    rootReplacementRecovery: true,
    physicalRootResolution: true,
    rootQualification: true,
    bytesOnlyInvalidations: true,
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
      rootPathPolicy: {
        type: "enum",
        values: ["strict", "resolve-physical"],
        default: "strict",
        outputPaths: "physical",
        aliasTracking: "establishment-snapshot",
        nonUtf8PhysicalRoot: "bytes-only-invalidations",
      },
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
    pathEncodingStates: ["complete", "root-collapsed", "bytes-only"],
    earlyDelivery: "buffered-until-resolved-root",
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

test("root qualification never outruns floor, environment, or filesystem evidence", () => {
  const target = capabilities.support.targets.find(
    ({ id }) => id === capabilities.support.currentRuntime.packagedTargetId,
  );
  assert.ok(target);
  const baseEvidence = {
    wsl: false,
    container: false,
    root: {
      availability: "available",
      directory: true,
      lexicalPath: "/workspace",
      lexicalPathBytes: Uint8Array.from(Buffer.from("/workspace")),
      physicalPath: "/workspace",
      physicalPathBytes: Uint8Array.from(Buffer.from("/workspace")),
      filesystem: { kind: "ordinary-local", magic: "0xef53" },
    },
  };
  const evaluate = ({ runtime = capabilities.runtime, evidence = baseEvidence } = {}) =>
    evaluateQualification({
      runtime,
      currentRuntime: capabilities.support.currentRuntime,
      target,
      evidence,
    });

  const qualified = evaluate({
    runtime: {
      ...capabilities.runtime,
      kernel: target.kernelMinimum,
      libc: {
        family: "glibc",
        version: target.libc.maximumRequiredSymbolVersion,
      },
    },
  });
  assert.equal(qualified.state, "qualified");
  assert.deepEqual(qualified.reasons, []);

  for (const [label, input, expectedState, expectedReason] of [
    [
      "kernel below floor",
      { runtime: { ...capabilities.runtime, kernel: "5.14.99", libc: { family: "glibc", version: "2.35" } } },
      "unqualified",
      "kernel-below-floor",
    ],
    [
      "glibc below floor",
      { runtime: { ...capabilities.runtime, kernel: "5.15.0", libc: { family: "glibc", version: "2.34" } } },
      "unqualified",
      "glibc-below-floor",
    ],
    [
      "unknown floors",
      { runtime: { ...capabilities.runtime, kernel: "unknown", libc: { family: "unknown", version: null } } },
      "unknown",
      "kernel-unknown",
    ],
    [
      "malformed kernel evidence",
      { runtime: { ...capabilities.runtime, kernel: "999.999garbage", libc: { family: "glibc", version: "2.35" } } },
      "unknown",
      "kernel-unknown",
    ],
    [
      "malformed glibc evidence",
      { runtime: { ...capabilities.runtime, kernel: "5.15.0", libc: { family: "glibc", version: "999.999garbage" } } },
      "unknown",
      "glibc-unknown",
    ],
    [
      "WSL",
      { evidence: { ...baseEvidence, wsl: true } },
      "unqualified",
      "wsl-detected",
    ],
    [
      "unknown WSL evidence",
      { evidence: { ...baseEvidence, wsl: null } },
      "unknown",
      "wsl-unknown",
    ],
    [
      "container",
      { evidence: { ...baseEvidence, container: true } },
      "unqualified",
      "container-detected",
    ],
    [
      "unknown container evidence",
      { evidence: { ...baseEvidence, container: null } },
      "unknown",
      "container-unknown",
    ],
    ...["network", "fuse", "overlay"].map((kind) => [
      `${kind} filesystem`,
      {
        evidence: {
          ...baseEvidence,
          root: {
            ...baseEvidence.root,
            filesystem: { kind, magic: "0x0" },
          },
        },
      },
      "unqualified",
      `filesystem-${kind}`,
    ]),
    [
      "unknown filesystem",
      {
        evidence: {
          ...baseEvidence,
          root: {
            ...baseEvidence.root,
            filesystem: { kind: "unknown", magic: "0x0" },
          },
        },
      },
      "unknown",
      "filesystem-unknown",
    ],
  ]) {
    const result = evaluate(input);
    assert.equal(result.state, expectedState, label);
    assert.ok(result.reasons.includes(expectedReason), label);
    assert.notEqual(result.state, "qualified", label);
  }
});

test("qualifyRoot inspects a real root without acquiring watcher resources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-qualification-"));
  const engine = createEngine();
  try {
    const before = engine.runtimeStats();
    const result = qualifyRoot(root);
    assert.equal(result.schemaVersion, 1);
    assert.ok(["qualified", "unqualified", "unknown"].includes(result.state));
    assert.equal(result.target.packagedTargetId, currentTarget.id);
    assert.equal(result.root.physicalPath, root);
    assert.notEqual(result.root.filesystem.magic, null);
    assert.deepEqual(engine.runtimeStats(), before);
    if (result.state === "qualified") {
      assert.deepEqual(result.reasons, []);
      assert.equal(result.target.state, "qualified");
      assert.equal(result.host.state, "qualified");
      assert.equal(result.root.state, "qualified");
    } else {
      assert.ok(result.reasons.length > 0);
    }
    assert.equal(Object.isFrozen(result), true);
    assert.throws(
      () => qualifyRoot(""),
      (error) => error.operation === "qualify-root" && !error.retryable,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capability handshake fails closed without native exclusion isolation", () => {
  const raw = nativeBinding.capabilities();
  const metadata = nativeBinding.bindingMetadata();
  const delivery = nativeBinding.nativeDeliveryMetadata();
  const runtime = nativeBinding.runtimeAdmissionMetadata();
  const matrix = nativeBinding.nativeTargetMatrix();
  for (const incompatible of [
    { ...raw, schemaVersion: 4 },
    { ...raw, schemaVersion: 6 },
    { ...raw, directoryNameExclusions: false },
    { ...raw, observedExcludedPaths: false },
    { ...raw, physicalRootResolution: false },
  ]) {
    assert.throws(
      () => buildCapabilities(incompatible, metadata, delivery, runtime, matrix),
      /incompatible/u,
    );
  }
  assert.throws(
    () => buildCapabilities(
      raw,
      { ...metadata, bindingApiVersion: 4 },
      delivery,
      runtime,
      matrix,
    ),
    /incompatible/u,
  );
  assert.throws(
    () => buildCapabilities(
      raw,
      { ...metadata, bindingApiVersion: 6 },
      delivery,
      runtime,
      matrix,
    ),
    /incompatible/u,
  );
  for (const incompatibleRuntime of [
    { ...runtime, schemaVersion: 0 },
    { ...runtime, libc: { ...runtime.libc, version: null } },
    { ...runtime, node: { ...runtime.node, api: null } },
  ]) {
    assert.throws(
      () => buildCapabilities(raw, metadata, delivery, incompatibleRuntime, matrix),
      /incompatible/u,
    );
  }
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
