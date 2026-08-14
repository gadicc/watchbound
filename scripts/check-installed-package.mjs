import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import exclusionSmokeHelpers from "./fixtures/exclusion-smoke-helpers.cjs";
import {
  parseInstalledSmokeWaitTimeoutMs,
  releaseCallbackGateAndJoinDisposal,
  recoverStableReplacement,
  waitForInstalledSmokeCondition,
} from "./installed-package-smoke-helpers.mjs";

const { hasInvalidatedPathAtOrBelow } = exclusionSmokeHelpers;

const smokeStartedAt = Date.now();
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseOptions(process.argv.slice(2));
logPhase("startup");
const waitTimeoutMs = parseInstalledSmokeWaitTimeoutMs(
  options["wait-timeout-ms"],
);
const projectRoot = path.resolve(options.project);
const wrapperRoot = options["wrapper-path"]
  ? path.resolve(options["wrapper-path"])
  : path.join(projectRoot, "node_modules", options.wrapper);
const wrapperEntry = fs.realpathSync(path.join(wrapperRoot, "index.js"));
const wrapperRequire = createRequire(wrapperEntry);
const loaderRoot = path.dirname(
  wrapperRequire.resolve("@gadicc/watchbound-node"),
);
const nativeMatrix = readJson(path.join(loaderRoot, "native-matrix.json"));
const nativeTarget = nativeMatrix.targets.find((target) =>
  target.platform === process.platform && target.architecture === process.arch);
assert.ok(nativeTarget, `no installed native target for ${process.platform}/${process.arch}`);
if (options["native-target"]) {
  assert.equal(nativeTarget.id, options["native-target"]);
}
const nativeRoot = path.dirname(
  wrapperRequire.resolve(`${nativeTarget.package}/package.json`),
);
const nativePath = path.join(nativeRoot, nativeTarget.binary);
const evidence = {
  schemaVersion: 1,
  kind: "watchbound-installed-package-smoke",
  route: options.route,
  expectedVersion: options.version,
  expectedNativeTarget: options["native-target"] ?? nativeTarget.id,
  expectedNativeSha256: options["native-sha256"],
  waitTimeoutMs,
  startedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    kernel: os.release(),
    glibc: process.report?.getReport?.().header?.glibcVersionRuntime ?? null,
  },
};

try {
  Object.assign(evidence, await runSmoke());
  evidence.status = "passed";
  logPhase("checks-complete");
} catch (error) {
  evidence.status = "failed";
  evidence.error = {
    name: error?.name ?? null,
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
  };
  logPhase("checks-failed", { errorName: error?.name ?? null });
  throw error;
} finally {
  evidence.finishedAt = new Date().toISOString();
  if (options.evidence) {
    logPhase("evidence-write-start");
    const evidencePath = path.resolve(options.evidence);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(
      evidencePath,
      `${JSON.stringify(evidence, bigintReplacer, 2)}\n`,
    );
    logPhase("evidence-write-complete");
  }
}

process.stdout.write(
  `Installed package smoke passed for ${options.route} ${options.version}\n`,
);

async function runSmoke() {
  logPhase("package-contracts-start");
  const wrapperPackage = readJson(path.join(wrapperRoot, "package.json"));
  const loaderPackage = readJson(path.join(loaderRoot, "package.json"));
  const nativePackage = readJson(path.join(nativeRoot, "package.json"));
  assert.equal(wrapperPackage.version, options.version);
  assert.equal(loaderPackage.version, options.version);
  assert.equal(nativePackage.version, options.version);
  assert.equal(
    wrapperPackage.dependencies?.["@gadicc/watchbound-node"],
    options.version,
  );
  assert.equal(wrapperDelivery(wrapperPackage), "bundled-native-package");
  assert.equal(loaderPackage.watchbound?.delivery, "bundled-native-package");
  assert.equal(nativePackage.watchbound?.delivery, "target-native-package");
  assert.equal(nativePackage.name, nativeTarget.package);
  assert.equal(nativePackage.watchbound?.target, nativeTarget.id);
  assert.equal(nativePackage.watchbound?.targetTriple, nativeTarget.rustTarget);
  assert.equal(
    nativePackage.watchbound?.nodeApiMinimum,
    nativeMatrix.nodeApiMinimum,
  );
  assert.ok(fs.existsSync(nativePath), `missing installed native addon: ${nativePath}`);
  const nativeSha256 = sha256(nativePath);
  assert.equal(
    nativeSha256,
    options["native-sha256"],
    "installed native addon differs from the independently approved artifact",
  );
  logPhase("package-contracts-complete");

  logPhase("native-module-start");
  const module = await import(pathToFileURL(wrapperEntry));
  const { capabilities, createEngine, qualifyRoot } = module;
  assert.deepEqual(capabilities.versions, {
    wrapper: options.version,
    native: options.version,
    engine: options.version,
    bindingApi: 5,
  });
  assert.equal(capabilities.build.delivery, "bundled-native-package");
  assert.equal(capabilities.build.prebuilt, true);
  assert.equal(capabilities.schemaVersion, 9);
  assert.equal(capabilities.features.directoryNameExclusions, true);
  assert.equal(capabilities.features.observedExcludedPaths, true);
  assert.equal(capabilities.features.bytesOnlyInvalidations, true);
  assert.deepEqual(capabilities.observability.pathEncodingStates, [
    "complete",
    "root-collapsed",
    "bytes-only",
  ]);
  assert.equal(capabilities.build.packagedTarget.id, nativeTarget.id);
  assert.equal(capabilities.build.packagedTarget.package, nativeTarget.package);
  assert.equal(capabilities.build.packagedTarget.sha256, nativeSha256);
  assert.equal(capabilities.support.scope, "legacy-primary-target");
  const legacyX64Target = nativeMatrix.targets.find(
    (target) => target.architecture === "x64",
  );
  assert.ok(legacyX64Target, "native matrix omits its legacy x64 target");
  assert.equal(capabilities.support.status, legacyX64Target.qualification);
  // These legacy single-target fields retain their original x64/Ubuntu 24.04
  // meaning. Consumers must use support.targets and currentRuntime for the
  // additive multi-target contract.
  assert.equal(capabilities.support.operatingSystem.distribution, "ubuntu");
  assert.equal(capabilities.support.operatingSystem.version, "24.04");
  assert.equal(capabilities.support.architecture, "x64");
  assert.deepEqual(capabilities.support.libc, {
    family: "glibc",
    version: "2.39",
  });
  assert.equal(capabilities.support.targets.length, nativeMatrix.targets.length);
  assert.equal(
    capabilities.support.currentRuntime.packagedTargetId,
    nativeTarget.id,
  );
  assert.equal(
    capabilities.support.currentRuntime.runtimeMatchesPackagedTarget,
    true,
  );
  assert.equal(
    capabilities.support.currentRuntime.qualification,
    nativeTarget.qualification,
  );
  assert.equal(
    capabilities.support.currentRuntime.targetCompatible,
    nativeTarget.qualification === "supported",
  );
  const qualification = qualifyRoot(process.cwd());
  assert.equal(qualification.schemaVersion, 1);
  assert.ok(["qualified", "unqualified", "unknown"].includes(qualification.state));
  assert.equal(qualification.target.packagedTargetId, nativeTarget.id);

  const engine = createEngine();
  const inactiveRuntime = {
    active: false,
    inotifyInstances: 0,
    workerThreads: 0,
    nativeWatches: 0,
    nativeWatchBudget: null,
    deferredInterests: 0,
    subscriptions: 0,
  };
  assert.deepEqual(engine.runtimeStats(), inactiveRuntime);
  const processBaseline = processResources();
  logPhase("native-module-complete");

  logPhase("real-delivery-start");
  await checkRealDeliveryAndSerialization(engine);
  logPhase("real-delivery-complete");
  logPhase("exclusions-recovery-start");
  await checkExclusionsRecoveryAndReconciliation(engine);
  logPhase("exclusions-recovery-complete");
  logPhase("joined-disposal-start");
  await checkContextAbortAndJoinedDisposal(engine);
  logPhase("joined-disposal-complete");
  logPhase("context-stop-start");
  await checkContextStop(engine);
  logPhase("context-stop-complete");

  logPhase("resource-return-start");
  await waitFor(
    () => deepEqual(engine.runtimeStats(), inactiveRuntime),
    "runtime resources did not return to the inactive baseline",
  );
  const processFinal = processResources();
  assert.equal(
    processFinal.watchboundThreads,
    processBaseline.watchboundThreads,
    "Watchbound threads did not return to baseline",
  );
  assert.equal(
    processFinal.inotifyDescriptors,
    processBaseline.inotifyDescriptors,
    "inotify descriptors did not return to baseline",
  );
  assert.ok(
    processFinal.fileDescriptors <= processBaseline.fileDescriptors + 2,
    "process file descriptors did not return near baseline",
  );
  assert.ok(
    processFinal.tasks <= processBaseline.tasks + 4,
    "process tasks did not return near the cold baseline",
  );
  logPhase("resource-return-complete");

  return {
    wrapper: {
      name: wrapperPackage.name,
      version: wrapperPackage.version,
    },
    loader: {
      name: loaderPackage.name,
      version: loaderPackage.version,
    },
    native: {
      name: nativePackage.name,
      version: nativePackage.version,
      sha256: nativeSha256,
      bytes: fs.statSync(nativePath).size,
    },
    runtime: {
      baseline: inactiveRuntime,
      final: engine.runtimeStats(),
    },
    processResources: {
      baseline: processBaseline,
      final: processFinal,
      tolerance: {
        fileDescriptors: 2,
        coldTasks: 4,
      },
    },
  };
}

function logPhase(phase, details = {}) {
  process.stdout.write(
    `WATCHBOUND_INSTALLED_SMOKE_PHASE=${JSON.stringify({
      phase,
      elapsedMs: Date.now() - smokeStartedAt,
      route: options.route,
      ...details,
    })}\n`,
  );
}

async function checkExclusionsRecoveryAndReconciliation(engine) {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "watchbound-installed-platform-semantics-"),
  );
  const root = path.join(parent, "root");
  const movedRoot = path.join(parent, "root-old");
  const initialExcluded = path.join(root, "initial-hidden");
  const dynamicExcluded = path.join(root, "dynamic-hidden");
  const observedGit = path.join(root, ".git");
  const nestedGit = path.join(root, "nested", ".git");
  fs.mkdirSync(initialExcluded, { recursive: true });
  fs.mkdirSync(dynamicExcluded, { recursive: true });
  fs.mkdirSync(path.join(observedGit, "objects"), { recursive: true });
  fs.mkdirSync(path.join(nestedGit, "objects"), { recursive: true });
  const batches = [];
  let subscription;
  try {
    subscription = await engine.subscribe(
      root,
      (batch) => batches.push(batch),
      {
        initialExclusions: ["initial-hidden"],
        excludedDirectoryNames: [".git"],
        observedExcludedPaths: [".git"],
        batchWindowMs: 5,
        outputQueueCapacity: 16,
      },
    );
    assert.equal(subscription.initialCoverage.state, "complete");

    const initialHidden = path.join(initialExcluded, "hidden.txt");
    const initialVisible = path.join(root, "visible.txt");
    fs.writeFileSync(initialHidden, "hidden");
    fs.writeFileSync(initialVisible, "visible");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(initialVisible)),
      "initial-exclusion smoke did not deliver the visible path",
    );
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, initialExcluded),
      false,
      "initial exclusion leaked its prefix or a descendant path",
    );
    fs.writeFileSync(path.join(observedGit, "objects", "ignored"), "hidden");
    fs.writeFileSync(path.join(nestedGit, "objects", "ignored"), "hidden");
    await delay(30);
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, nestedGit),
      false,
      "nested directory-name exclusion leaked a descendant path",
    );
    fs.rmSync(observedGit, { recursive: true });
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(observedGit)),
      "observed excluded boundary deletion was not delivered",
    );

    const replacementCoverage = await subscription.replaceExclusions(
      1n,
      {
        prefixes: ["dynamic-hidden"],
        excludedDirectoryNames: [".git"],
        observedExcludedPaths: [".git"],
      },
    );
    assert.equal(replacementCoverage.state, "complete");
    const dynamicHidden = path.join(dynamicExcluded, "hidden.txt");
    const nowVisible = path.join(root, "initial-hidden", "now-visible.txt");
    fs.writeFileSync(dynamicHidden, "hidden");
    fs.writeFileSync(nowVisible, "visible");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(nowVisible)),
      "dynamic-exclusion smoke did not deliver the newly visible path",
    );
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, dynamicExcluded),
      false,
      "dynamic exclusion leaked its prefix or a descendant path",
    );

    const reconciliation = await subscription.reconcile();
    assert.equal(reconciliation.exclusionGeneration, 1n);
    assert.equal(reconciliation.coverage.state, "complete");

    fs.renameSync(root, movedRoot);
    fs.mkdirSync(path.join(root, "replacement"), { recursive: true });
    await waitFor(
      () => subscription.rootState.attachment === "lost",
      "root replacement did not become explicitly lost",
    );
    const recovery = await recoverStableReplacement(subscription, {
      timeoutMs: waitTimeoutMs,
      onDeadline: reportSemanticDeadline,
    });
    assert.equal(
      recovery.attachment,
      "replacement-adopted",
      `root recovery did not adopt the stable replacement: ${recovery.reason ?? "unknown"}`,
    );
    assert.equal(recovery.currentRootState.attachment, "attached");
    const afterRecovery = path.join(root, "replacement", "after.txt");
    fs.writeFileSync(afterRecovery, "after");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(afterRecovery)),
      "root-recovery smoke did not restore real delivery",
    );
    await subscription.dispose();
    subscription = undefined;
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, initialExcluded, 0n),
      false,
      "joined history exposed an initial-exclusion namespace leak",
    );
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, dynamicExcluded, 1n),
      false,
      "joined history exposed a dynamic-exclusion namespace leak",
    );
  } finally {
    await subscription?.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function wrapperDelivery(manifest) {
  if (manifest.watchbound?.delivery !== undefined) {
    return manifest.watchbound.delivery;
  }
  if (
    manifest.name === "@jsr/gadicc__watchbound" &&
    manifest.dependencies?.["@gadicc/watchbound-node"] === manifest.version
  ) {
    return "bundled-native-package";
  }
  return undefined;
}

async function checkRealDeliveryAndSerialization(engine) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "watchbound-installed-serialization-"),
  );
  const firstRelease = deferred();
  let subscription;
  let entered = 0;
  let active = 0;
  let maximumActive = 0;
  const invalidatedPaths = [];
  try {
    logPhase("real-delivery-subscribe-start");
    subscription = await engine.subscribe(
      root,
      async (batch) => {
        invalidatedPaths.push(...batch.invalidatedPaths);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        entered += 1;
        if (entered === 1) {
          logPhase("real-delivery-first-callback-enter");
          await firstRelease.promise;
        } else if (entered === 2) {
          logPhase("real-delivery-second-callback-enter");
        }
        active -= 1;
      },
      {
        batchWindowMs: 5,
        outputQueueCapacity: 4,
      },
    );
    logPhase("real-delivery-subscribe-complete");
    assert.equal(subscription.initialCoverage.state, "complete");
    logPhase("real-delivery-first-write");
    fs.writeFileSync(path.join(root, "first.txt"), "first");
    logPhase("real-delivery-first-callback-wait-start");
    await waitFor(
      () => entered >= 1,
      "the first serialized callback did not enter",
    );
    logPhase("real-delivery-first-callback-wait-complete");
    logPhase("real-delivery-second-write");
    fs.writeFileSync(path.join(root, "second.txt"), "second");
    await delay(75);
    assert.equal(entered, 1, "a later callback overlapped a pending callback");
    firstRelease.resolve();
    logPhase("real-delivery-second-callback-wait-start");
    await waitFor(() => entered >= 2, "the serialized callback did not resume");
    logPhase("real-delivery-second-callback-wait-complete");
    assert.equal(maximumActive, 1);
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    const beforeChange = entered;
    const firstInvalidations = invalidatedPaths.filter((value) => value === first).length;
    fs.appendFileSync(first, "-changed");
    await waitFor(
      () => entered > beforeChange &&
        invalidatedPaths.filter((value) => value === first).length > firstInvalidations,
      "the file-change callback was not delivered",
    );
    const beforeDelete = entered;
    const secondInvalidations = invalidatedPaths.filter((value) => value === second).length;
    fs.rmSync(second);
    await waitFor(
      () => entered > beforeDelete &&
        invalidatedPaths.filter((value) => value === second).length > secondInvalidations,
      "the file-deletion callback was not delivered",
    );
  } finally {
    logPhase("real-delivery-disposal-start");
    await releaseCallbackGateAndJoinDisposal(
      () => firstRelease.resolve(),
      subscription,
    );
    logPhase("real-delivery-disposal-complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function checkContextAbortAndJoinedDisposal(engine) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "watchbound-installed-disposal-"),
  );
  const completionRelease = deferred();
  let callbackCompleted = false;
  let callbackContext;
  let subscription;
  try {
    subscription = await engine.subscribe(
      root,
      async (_batch, context) => {
        callbackContext = context;
        if (!context.signal.aborted) {
          await new Promise((resolve) => {
            context.signal.addEventListener("abort", resolve, { once: true });
          });
        }
        await completionRelease.promise;
        callbackCompleted = true;
      },
      { batchWindowMs: 5 },
    );
    fs.writeFileSync(path.join(root, "changed.txt"), "change");
    await waitFor(
      () => callbackContext !== undefined,
      "the joined-disposal callback did not enter",
    );
    let disposalResolved = false;
    const disposal = subscription.dispose().then(() => {
      disposalResolved = true;
    });
    assert.equal(callbackContext.signal.aborted, true);
    await delay(50);
    assert.equal(
      disposalResolved,
      false,
      "disposal resolved before the pending callback completed",
    );
    completionRelease.resolve();
    await disposal;
    assert.equal(callbackCompleted, true);
    assert.equal(subscription.stats().disposed, true);
  } finally {
    await releaseCallbackGateAndJoinDisposal(
      () => completionRelease.resolve(),
      subscription,
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function checkContextStop(engine) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "watchbound-installed-stop-"),
  );
  let calls = 0;
  let callbackContext;
  let subscription;
  try {
    subscription = await engine.subscribe(
      root,
      (_batch, context) => {
        calls += 1;
        callbackContext = context;
        context.stop();
        context.stop();
      },
      { batchWindowMs: 5 },
    );
    fs.writeFileSync(path.join(root, "changed.txt"), "change");
    await waitFor(
      () => subscription.stats().disposed,
      "context.stop() did not dispose the subscription",
    );
    assert.equal(callbackContext.signal.aborted, true);
    await subscription.dispose();
    fs.writeFileSync(path.join(root, "after-stop.txt"), "after");
    await delay(75);
    assert.equal(calls, 1, "a callback started after context.stop() disposal");
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function processResources() {
  const tasks = fs.readdirSync("/proc/self/task")
    .filter((entry) => /^\d+$/u.test(entry));
  const watchboundThreads = tasks.filter((entry) => {
    try {
      return fs.readFileSync(`/proc/self/task/${entry}/comm`, "utf8")
        .trim()
        .startsWith("watchbound-");
    } catch {
      return false;
    }
  }).length;
  const descriptors = fs.readdirSync("/proc/self/fd")
    .filter((entry) => /^\d+$/u.test(entry));
  const inotifyDescriptors = descriptors.filter((entry) => {
    try {
      return fs.readlinkSync(`/proc/self/fd/${entry}`) === "anon_inode:inotify";
    } catch {
      return false;
    }
  }).length;
  return {
    fileDescriptors: descriptors.length,
    tasks: tasks.length,
    watchboundThreads,
    inotifyDescriptors,
  };
}

async function waitFor(predicate, message) {
  await waitForInstalledSmokeCondition(predicate, message, {
    timeoutMs: waitTimeoutMs,
    onDeadline: reportSemanticDeadline,
  });
}

function reportSemanticDeadline(message, timeoutMs) {
  process.stderr.write(
    `WATCHBOUND_INSTALLED_SMOKE_SEMANTIC_DEADLINE=${JSON.stringify({
      elapsedMs: Date.now() - smokeStartedAt,
      route: options.route,
      timeoutMs,
      message,
    })}\n`,
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: check-installed-package.mjs --project <path> --wrapper <name> --version <version> --native-sha256 <digest> --route <route> [--native-target <id>] [--wrapper-path <path>] [--evidence <path>] [--wait-timeout-ms <milliseconds>]",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  for (const required of [
    "project",
    "wrapper",
    "version",
    "native-sha256",
    "route",
  ]) {
    assert.ok(parsed[required], `--${required} is required`);
  }
  assert.match(parsed["native-sha256"], /^[0-9a-f]{64}$/u);
  return parsed;
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function sha256(source) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(source))
    .digest("hex");
}

function deepEqual(left, right) {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? `${value}n` : value;
}
