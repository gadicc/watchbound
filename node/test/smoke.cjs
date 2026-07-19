"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const binding = require("../index.js");
const trace = (...values) => {
  if (process.env.WATCHBOUND_TEST_TRACE) console.error(...values);
};

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-smoke-"));
  try {
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    const batches = [];
    trace("subscribing", root);
    const subscription = await binding.subscribe(
      root,
      { batchWindowMs: 10 },
      (batch) => batches.push(batch),
    );
    trace("subscribed", subscription.initialCoverage);
    assert.equal(subscription.initialCoverage.state, "complete");
    assert.equal(subscription.stats().watchedDirectories, 3);

    const changed = path.join(root, "a", "b", "file.txt");
    fs.writeFileSync(changed, "change");
    const deadline = Date.now() + 3_000;
    while (batches.length === 0 && Date.now() < deadline) await delay(10);
    trace("batches", batches.length);
    assert.ok(batches.length > 0, "native callback was not delivered");
    assert.equal(typeof batches[0].sequence, "bigint");
    assert.ok(
      batches[0].invalidatedPaths.some((value) => value.equals(Buffer.from(changed))),
      "deep path was not invalidated",
    );

    trace("disposing");
    await subscription.dispose();
    trace("disposed");
    const countAtDispose = batches.length;
    fs.writeFileSync(path.join(root, "after.txt"), "after");
    await delay(30);
    assert.equal(batches.length, countAtDispose, "callback ran after dispose resolved");
    assert.equal(subscription.stats().disposed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(
  () => console.log("watchbound node smoke: ok"),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
