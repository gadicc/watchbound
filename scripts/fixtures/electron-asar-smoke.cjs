"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const {
  hasInvalidatedPathAtOrBelow,
} = require("./exclusion-smoke-helpers.cjs");

void main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});

async function main() {
  assert.equal(process.versions.electron, "42.3.0");
  assert.equal(process.versions.node, "24.15.0");
  assert.ok(Number(process.versions.napi) >= 10);
  const watchbound = await import("watchbound");
  assert.equal(watchbound.capabilities.schemaVersion, 9);
  assert.equal(
    watchbound.capabilities.support.currentRuntime.packagedTargetId,
    process.env.WATCHBOUND_EXPECTED_TARGET,
  );
  assert.equal(
    watchbound.capabilities.build.packagedTarget.sha256,
    process.env.WATCHBOUND_EXPECTED_NATIVE_SHA256,
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-electron-asar-"));
  fs.mkdirSync(path.join(root, "hidden"));
  fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
  const batches = [];
  const engine = watchbound.createEngine();
  let subscription;
  try {
    subscription = await engine.subscribe(
      root,
      (batch) => batches.push(batch),
      {
        initialExclusions: ["hidden"],
        excludedDirectoryNames: [".git"],
        observedExcludedPaths: [".git"],
        batchWindowMs: 5,
      },
    );
    assert.equal(subscription.initialCoverage.state, "complete");
    const excluded = path.join(root, "hidden");
    const hidden = path.join(excluded, "ignored.txt");
    const visible = path.join(root, "visible.txt");
    fs.writeFileSync(hidden, "ignored");
    fs.writeFileSync(visible, "visible");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(visible)),
      "Electron ASAR callback was not delivered",
    );
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, excluded),
      false,
      "Electron ASAR initial exclusion leaked its prefix or a descendant path",
    );
    const observedGit = path.join(root, ".git");
    fs.writeFileSync(path.join(observedGit, "objects", "ignored"), "ignored");
    await delay(30);
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, path.join(observedGit, "objects")),
      false,
      "Electron ASAR directory-name exclusion leaked a descendant path",
    );
    fs.rmSync(observedGit, { recursive: true });
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(observedGit)),
      "Electron ASAR observed boundary was not delivered",
    );
    const reconciliation = await subscription.reconcile();
    assert.equal(reconciliation.coverage.state, "complete");
    await subscription.dispose();
    subscription = undefined;
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, excluded, 0n),
      false,
      "joined Electron ASAR history exposed an exclusion namespace leak",
    );
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(engine.runtimeStats().active, false);

  const loadedNative = Object.keys(require.cache).find((filename) =>
    filename.endsWith(".node") && filename.includes("app.asar"));
  assert.ok(loadedNative, "native addon was not loaded through the ASAR path");
  process.stdout.write(`${JSON.stringify({
    kind: "watchbound-electron-asar-smoke",
    status: "passed",
    electron: process.versions.electron,
    node: process.versions.node,
    nodeApi: Number(process.versions.napi),
    target: process.env.WATCHBOUND_EXPECTED_TARGET,
    nativeSha256: process.env.WATCHBOUND_EXPECTED_NATIVE_SHA256,
    loadedNative,
  })}\n`);
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 4_000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), message);
}
