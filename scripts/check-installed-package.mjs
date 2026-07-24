import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseOptions(process.argv.slice(2));
const projectRoot = path.resolve(options.project);
const wrapperRoot = options["wrapper-path"]
  ? path.resolve(options["wrapper-path"])
  : path.join(projectRoot, "node_modules", options.wrapper);
const wrapperEntry = fs.realpathSync(path.join(wrapperRoot, "index.js"));
const wrapperRequire = createRequire(wrapperEntry);
const nativeRoot = path.dirname(
  wrapperRequire.resolve("@gadicc/watchbound-node"),
);
const nativePath = path.join(
  nativeRoot,
  "watchbound.linux-x64-gnu.node",
);
const evidence = {
  schemaVersion: 1,
  kind: "watchbound-installed-package-smoke",
  route: options.route,
  expectedVersion: options.version,
  expectedNativeSha256: options["native-sha256"],
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
} catch (error) {
  evidence.status = "failed";
  evidence.error = {
    name: error?.name ?? null,
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
  };
  throw error;
} finally {
  evidence.finishedAt = new Date().toISOString();
  if (options.evidence) {
    const evidencePath = path.resolve(options.evidence);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(
      evidencePath,
      `${JSON.stringify(evidence, bigintReplacer, 2)}\n`,
    );
  }
}

process.stdout.write(
  `Installed package smoke passed for ${options.route} ${options.version}\n`,
);

async function runSmoke() {
  const wrapperPackage = readJson(path.join(wrapperRoot, "package.json"));
  const nativePackage = readJson(path.join(nativeRoot, "package.json"));
  assert.equal(wrapperPackage.version, options.version);
  assert.equal(nativePackage.version, options.version);
  assert.equal(
    wrapperPackage.dependencies?.["@gadicc/watchbound-node"],
    options.version,
  );
  assert.equal(wrapperDelivery(wrapperPackage), "bundled-native-package");
  assert.equal(nativePackage.watchbound?.delivery, "bundled-native-package");
  assert.ok(fs.existsSync(nativePath), `missing installed native addon: ${nativePath}`);
  const nativeSha256 = sha256(nativePath);
  assert.equal(
    nativeSha256,
    options["native-sha256"],
    "installed native addon differs from the independently approved artifact",
  );

  const module = await import(pathToFileURL(wrapperEntry));
  const { capabilities, createEngine } = module;
  assert.deepEqual(capabilities.versions, {
    wrapper: options.version,
    native: options.version,
    engine: options.version,
    bindingApi: 3,
  });
  assert.equal(capabilities.build.delivery, "bundled-native-package");
  assert.equal(capabilities.build.prebuilt, true);
  assert.equal(capabilities.support.status, "supported");
  assert.equal(capabilities.support.operatingSystem.distribution, "ubuntu");
  assert.equal(capabilities.support.operatingSystem.version, "24.04");
  assert.equal(capabilities.support.architecture, "x64");
  assert.deepEqual(capabilities.support.libc, {
    family: "glibc",
    version: "2.39",
  });

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

  await checkRealDeliveryAndSerialization(engine);
  await checkContextAbortAndJoinedDisposal(engine);
  await checkContextStop(engine);

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

  return {
    wrapper: {
      name: wrapperPackage.name,
      version: wrapperPackage.version,
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
  const firstEntered = deferred();
  const firstRelease = deferred();
  let subscription;
  let entered = 0;
  let active = 0;
  let maximumActive = 0;
  try {
    subscription = await engine.subscribe(
      root,
      async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        entered += 1;
        if (entered === 1) {
          firstEntered.resolve();
          await firstRelease.promise;
        }
        active -= 1;
      },
      {
        batchWindowMs: 5,
        outputQueueCapacity: 4,
      },
    );
    assert.equal(subscription.initialCoverage.state, "complete");
    fs.writeFileSync(path.join(root, "first.txt"), "first");
    await firstEntered.promise;
    fs.writeFileSync(path.join(root, "second.txt"), "second");
    await delay(75);
    assert.equal(entered, 1, "a later callback overlapped a pending callback");
    firstRelease.resolve();
    await waitFor(() => entered >= 2, "the serialized callback did not resume");
    assert.equal(maximumActive, 1);
  } finally {
    firstRelease.resolve();
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function checkContextAbortAndJoinedDisposal(engine) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "watchbound-installed-disposal-"),
  );
  const entered = deferred();
  const completionRelease = deferred();
  let callbackCompleted = false;
  let callbackContext;
  let subscription;
  try {
    subscription = await engine.subscribe(
      root,
      async (_batch, context) => {
        callbackContext = context;
        entered.resolve();
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
    await entered.promise;
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
    completionRelease.resolve();
    await subscription?.dispose();
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
  const deadline = Date.now() + 4_000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
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
        "usage: check-installed-package.mjs --project <path> --wrapper <name> --version <version> --native-sha256 <digest> --route <route> [--wrapper-path <path>] [--evidence <path>]",
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
