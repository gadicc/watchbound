import assert from "node:assert/strict";
import test from "node:test";

import { recoverStableReplacement } from "../../scripts/installed-package-smoke-helpers.mjs";

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
