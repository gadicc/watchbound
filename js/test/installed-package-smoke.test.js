import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import exclusionSmokeHelpers from "../../scripts/fixtures/exclusion-smoke-helpers.cjs";
import {
  DEFAULT_INSTALLED_SMOKE_WAIT_TIMEOUT_MS,
  parseInstalledSmokeWaitTimeoutMs,
  recoverStableReplacement,
} from "../../scripts/installed-package-smoke-helpers.mjs";

const { hasInvalidatedPathAtOrBelow } = exclusionSmokeHelpers;

test("installed smoke rejects excluded-prefix and descendant invalidations", () => {
  const root = path.join(path.sep, "tmp", "watchbound-smoke");
  const excluded = path.join(root, "hidden");
  const batch = (invalidatedPaths) => ({ invalidatedPaths });

  assert.equal(
    hasInvalidatedPathAtOrBelow([batch([excluded])], excluded),
    true,
  );
  assert.equal(
    hasInvalidatedPathAtOrBelow([
      batch([path.join(excluded, "deep", "changed.txt")]),
    ], excluded),
    true,
  );
  assert.equal(
    hasInvalidatedPathAtOrBelow([
      batch([root, `${excluded}-sibling`, path.join(root, "visible.txt")]),
    ], excluded),
    false,
  );

  const delayedHistory = [
    { exclusionGeneration: 0n, invalidatedPaths: [path.join(root, "visible.txt")] },
    { exclusionGeneration: 1n, invalidatedPaths: [path.join(excluded, "now-visible.txt")] },
  ];
  assert.equal(
    hasInvalidatedPathAtOrBelow(delayedHistory, excluded, 0n),
    false,
    "later generations must not be charged to an earlier exclusion phase",
  );
  assert.equal(
    hasInvalidatedPathAtOrBelow(delayedHistory, excluded, 1n),
    true,
    "the matching generation must retain excluded-namespace evidence",
  );
});

test("installed smoke keeps its short default and accepts a bounded override", () => {
  assert.equal(
    parseInstalledSmokeWaitTimeoutMs(undefined),
    DEFAULT_INSTALLED_SMOKE_WAIT_TIMEOUT_MS,
  );
  assert.equal(parseInstalledSmokeWaitTimeoutMs("30000"), 30_000);
  assert.equal(parseInstalledSmokeWaitTimeoutMs("120000"), 120_000);
});

test("installed smoke rejects malformed or excessive wait overrides", () => {
  for (const value of [
    "0",
    "-1",
    "4.5",
    " 4000",
    "4000ms",
    "120001",
    "9007199254740992",
  ]) {
    assert.throws(
      () => parseInstalledSmokeWaitTimeoutMs(value),
      /integer from 1 through 120000/u,
    );
  }
});

test("installed smoke retries transient identity instability", async () => {
  const attempts = [
    { attachment: "not-attached", reason: "identity-unstable" },
    { attachment: "replacement-adopted" },
  ];
  const sleeps = [];
  const result = await recoverStableReplacement(
    {
      recoverRoot: async (options) => {
        assert.deepEqual(options, { identityPolicy: "accept-replacement" });
        return attempts.shift();
      },
    },
    {
      timeoutMs: 100,
      now: () => 0,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    },
  );

  assert.deepEqual(result, { attachment: "replacement-adopted" });
  assert.deepEqual(sleeps, [10]);
  assert.equal(attempts.length, 0);
});

test("installed smoke preserves non-transient recovery failures", async () => {
  let calls = 0;
  const failure = {
    attachment: "not-attached",
    reason: "root-watch-unavailable",
  };
  const result = await recoverStableReplacement({
    recoverRoot: async () => {
      calls += 1;
      return failure;
    },
  });

  assert.equal(result, failure);
  assert.equal(calls, 1);
});

test("installed smoke bounds repeated identity instability", async () => {
  const times = [0, 50, 100];
  let calls = 0;
  let sleeps = 0;
  const result = await recoverStableReplacement(
    {
      recoverRoot: async () => {
        calls += 1;
        return { attachment: "not-attached", reason: "identity-unstable" };
      },
    },
    {
      timeoutMs: 100,
      now: () => times.shift(),
      sleep: async () => {
        sleeps += 1;
      },
    },
  );

  assert.deepEqual(result, {
    attachment: "not-attached",
    reason: "identity-unstable",
  });
  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
});

test("installed smoke bounds a recovery operation that never settles", {
  timeout: 1_000,
}, async () => {
  let calls = 0;
  await assert.rejects(
    recoverStableReplacement(
      {
        recoverRoot: async () => {
          calls += 1;
          await new Promise(() => {});
        },
      },
      { timeoutMs: 25 },
    ),
    /root recovery did not settle within 25ms/u,
  );
  assert.equal(calls, 1);
});
