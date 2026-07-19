import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { capabilities, subscribe } from "../index.js";

test("wrapper delivers string paths and idempotent disposal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-"));
  let subscription;
  try {
    const batches = [];
    subscription = await subscribe(root, (batch) => batches.push(batch), {
      batchWindowMs: 8,
    });
    const changed = path.join(root, "changed.txt");
    fs.writeFileSync(changed, "change");
    const deadline = Date.now() + 3_000;
    while (batches.length === 0 && Date.now() < deadline) await delay(10);

    assert.equal(capabilities.recursive, true);
    assert.equal(capabilities.dynamicExclusions, true);
    assert.equal(subscription.initialCoverage.state, "complete");
    assert.equal(subscription.exclusionGeneration, 0n);
    assert.ok(batches.some((batch) => batch.invalidatedPaths.includes(changed)));
    assert.equal(typeof batches[0].sequence, "bigint");
    assert.equal(batches[0].exclusionGeneration, 0n);
    assert.equal(batches[0].pathEncodingCollapsed, false);
    await Promise.all([subscription.dispose(), subscription.dispose()]);
    assert.equal(subscription.stats().disposed, true);
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper replaces exclusions atomically and validates its representation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-exclusions-"));
  const hidden = path.join(root, "hidden");
  fs.mkdirSync(hidden);
  let subscription;
  try {
    const batches = [];
    subscription = await subscribe(root, (batch) => batches.push(batch), {
      batchWindowMs: 8,
    });
    await assert.rejects(subscription.replaceExclusions(1n, ["../outside"]), /normalized/);
    assert.equal(subscription.exclusionGeneration, 0n);
    await subscription.replaceExclusions(1n, ["hidden"]);
    fs.writeFileSync(path.join(hidden, "ignored"), "value");
    await delay(30);
    assert.equal(batches.length, 0);

    await subscription.replaceExclusions(2n, []);
    const deadline = Date.now() + 3_000;
    while (batches.length === 0 && Date.now() < deadline) await delay(10);
    assert.ok(batches.some((batch) => batch.invalidatedPaths.includes(hidden)));
    assert.ok(batches.every((batch) => batch.exclusionGeneration === 2n));
    assert.equal(subscription.exclusionGeneration, 2n);
    assert.throws(() => subscription.replaceExclusions(3, []), /bigint/);
    assert.throws(() => subscription.replaceExclusions(3n, null), /array/);
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper reconciles in place under the committed exclusion generation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-reconcile-"));
  let subscription;
  try {
    const batches = [];
    subscription = await subscribe(root, (batch) => batches.push(batch), {
      batchWindowMs: 8,
    });
    await subscription.replaceExclusions(2n, ["hidden"]);
    fs.mkdirSync(path.join(root, "created", "deep"), { recursive: true });

    const result = await subscription.reconcile();
    assert.deepEqual(result, {
      exclusionGeneration: 2n,
      coverage: { state: "complete" },
    });
    assert.equal(capabilities.reconciliation, true);
    const deadline = Date.now() + 3_000;
    while (!batches.some((batch) => batch.invalidatedPaths.includes(root)) && Date.now() < deadline) {
      await delay(10);
    }
    assert.ok(batches.some((batch) =>
      batch.invalidatedPaths.includes(root) && batch.exclusionGeneration === 2n));
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper validates arguments before entering native code", async () => {
  await assert.rejects(subscribe("", () => {}), /non-empty string/);
  await assert.rejects(subscribe("/tmp", null), /onBatch must be a function/);
});

test("wrapper preserves symlink parent-navigation components for native validation", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-symlink-parent-"));
  const target = path.join(parent, "target");
  const link = path.join(parent, "link");
  fs.mkdirSync(target);
  fs.symlinkSync(target, link);
  const candidate = `${link}${path.sep}..${path.sep}target`;
  let acceptedSubscription;
  let rejection;
  try {
    try {
      acceptedSubscription = await subscribe(candidate, () => {});
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection, "wrapper erased the symlink component before native validation");
    assert.match(rejection.message, /symbolic link/);
  } finally {
    await acceptedSubscription?.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("non-UTF-8 child paths preserve bytes and collapse the string invalidation to root", async () => {
  const previousCwd = process.cwd();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-bytes-"));
  const relativeRoot = "root";
  const root = path.join(parent, relativeRoot);
  fs.mkdirSync(root);
  let subscription;
  try {
    process.chdir(parent);
    const batches = [];
    subscription = await subscribe(relativeRoot, (batch) => batches.push(batch), {
      batchWindowMs: 8,
    });
    process.chdir(previousCwd);
    const exactPath = Buffer.concat([
      Buffer.from(`${root}${path.sep}`),
      Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74]),
    ]);
    fs.writeFileSync(exactPath, "bytes");
    const deadline = Date.now() + 3_000;
    while (batches.length === 0 && Date.now() < deadline) await delay(10);

    assert.ok(batches.some((batch) => batch.pathEncodingCollapsed));
    assert.ok(batches.some((batch) => batch.invalidatedPaths.includes(root)));
    assert.ok(
      batches.some((batch) =>
        batch.invalidatedPathBytes.some((bytes) => Buffer.from(bytes).equals(exactPath)),
      ),
    );
  } finally {
    process.chdir(previousCwd);
    await subscription?.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a callback that captures its subscription does not defeat GC cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-cycle-"));
  const wrapperUrl = new URL("../index.js", import.meta.url).href;
  const source = `
    import fs from "node:fs";
    import path from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    import { subscribe } from ${JSON.stringify(wrapperUrl)};
    let liveCallbacks = 0;
    const liveSubscription = await subscribe(
      ${JSON.stringify(root)},
      () => { liveCallbacks += 1; },
      { batchWindowMs: 5 },
    );
    for (let index = 0; index < 10; index += 1) global.gc();
    fs.writeFileSync(path.join(${JSON.stringify(root)}, "live.txt"), "change");
    const callbackDeadline = Date.now() + 1_000;
    while (liveCallbacks === 0 && Date.now() < callbackDeadline) await delay(10);
    if (liveCallbacks === 0) throw new Error("live subscription lost its callback holder");
    await liveSubscription.dispose();

    async function createSubscription() {
      const subscription = await subscribe(
        ${JSON.stringify(root)},
        () => subscription.stats(),
      );
      return subscription;
    }
    let subscription = await createSubscription();
    subscription = null;
    for (let index = 0; index < 40; index += 1) {
      global.gc();
      await delay(10);
    }
  `;
  const child = spawn(
    process.execPath,
    ["--expose-gc", "--input-type=module", "--eval", source],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("callback/subscription cycle kept the child process alive"));
      }, 3_000);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    assert.deepEqual(result, { code: 0, signal: null }, stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
