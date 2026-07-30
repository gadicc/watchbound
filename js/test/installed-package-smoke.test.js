import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_INSTALLED_SMOKE_WAIT_TIMEOUT_MS,
  parseInstalledSmokeWaitTimeoutMs,
  recoverStableReplacement,
} from "../../scripts/installed-package-smoke-helpers.mjs";

test("installed smoke keeps its short default and accepts a bounded override", () => {
  assert.equal(
    parseInstalledSmokeWaitTimeoutMs(undefined),
    DEFAULT_INSTALLED_SMOKE_WAIT_TIMEOUT_MS,
  );
  assert.equal(parseInstalledSmokeWaitTimeoutMs("30000"), 30_000);
});

test("installed smoke rejects malformed or excessive wait overrides", () => {
  for (const value of [
    "0",
    "-1",
    "4.5",
    " 4000",
    "4000ms",
    "60001",
    "9007199254740992",
  ]) {
    assert.throws(
      () => parseInstalledSmokeWaitTimeoutMs(value),
      /integer from 1 through 60000/u,
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
