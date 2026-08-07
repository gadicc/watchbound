import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import exclusionSmokeHelpers from "../../scripts/fixtures/exclusion-smoke-helpers.cjs";
import {
  DEFAULT_INSTALLED_SMOKE_WAIT_TIMEOUT_MS,
  parseInstalledSmokeWaitTimeoutMs,
  releaseCallbackGateAndJoinDisposal,
  recoverStableReplacement,
  waitForInstalledSmokeCondition,
} from "../../scripts/installed-package-smoke-helpers.mjs";

const { hasInvalidatedPathAtOrBelow } = exclusionSmokeHelpers;
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

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

test("installed smoke bounds callback entry while releasing and joining cleanup", async () => {
  let now = 0;
  let finishDisposal;
  const disposalGate = new Promise((resolve) => {
    finishDisposal = resolve;
  });
  const events = [];
  const operation = (async () => {
    try {
      await waitForInstalledSmokeCondition(
        () => false,
        "callback did not enter",
        {
          timeoutMs: 20,
          now: () => now,
          sleep: async (milliseconds) => {
            now += milliseconds;
          },
          onDeadline: () => events.push("semantic-deadline"),
        },
      );
    } finally {
      await releaseCallbackGateAndJoinDisposal(
        () => events.push("callback-release"),
        {
          dispose: async () => {
            events.push("dispose-start");
            await disposalGate;
            events.push("dispose-complete");
          },
        },
      );
    }
  })();
  let outcome;
  const observed = operation.then(
    () => {
      outcome = "fulfilled";
    },
    (error) => {
      outcome = error;
    },
  );

  await waitForImmediate();
  assert.deepEqual(events, [
    "semantic-deadline",
    "callback-release",
    "dispose-start",
  ]);
  assert.equal(outcome, undefined, "deadline detached joined disposal");

  finishDisposal();
  await observed;
  assert.match(String(outcome), /callback did not enter/u);
  assert.deepEqual(events, [
    "semantic-deadline",
    "callback-release",
    "dispose-start",
    "dispose-complete",
  ]);
});

test("installed smoke wires both callback-entry waits through the bounded path", () => {
  const source = fs.readFileSync(
    path.join(workspaceRoot, "scripts/check-installed-package.mjs"),
    "utf8",
  );

  assert.match(source, /waitFor\(\s*\(\) => entered >= 1,/u);
  assert.match(
    source,
    /waitFor\(\s*\(\) => callbackContext !== undefined,/u,
  );
  assert.doesNotMatch(source, /await (?:firstEntered|entered)\.promise/u);
  assert.equal(
    source.match(/releaseCallbackGateAndJoinDisposal\(/gu)?.length,
    2,
  );
  assert.match(
    source,
    /recoverStableReplacement\(subscription, \{\s*timeoutMs: waitTimeoutMs,\s*onDeadline: reportSemanticDeadline,/u,
  );
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

test("installed smoke does not report a losing recovery deadline", async () => {
  let resolveDeadline;
  const deadlines = [];
  const result = await recoverStableReplacement(
    {
      recoverRoot: async () => ({ attachment: "replacement-adopted" }),
    },
    {
      timeoutMs: 25,
      deadlineSleep: async () => {
        await new Promise((resolve) => {
          resolveDeadline = resolve;
        });
      },
      onDeadline: (message) => deadlines.push(message),
    },
  );

  assert.deepEqual(result, { attachment: "replacement-adopted" });
  resolveDeadline();
  await waitForImmediate();
  assert.deepEqual(deadlines, []);
});

test("installed smoke bounds repeated identity instability", async () => {
  const times = [0, 50, 100];
  let calls = 0;
  let sleeps = 0;
  const deadlines = [];
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
      onDeadline: (message, timeoutMs) => {
        deadlines.push({ message, timeoutMs });
      },
    },
  );

  assert.deepEqual(result, {
    attachment: "not-attached",
    reason: "identity-unstable",
  });
  assert.equal(calls, 2);
  assert.equal(sleeps, 1);
  assert.deepEqual(deadlines, [{
    message: "root recovery remained identity-unstable for 100ms",
    timeoutMs: 100,
  }]);
});

test("installed smoke bounds a recovery operation that never settles", {
  timeout: 1_000,
}, async () => {
  let calls = 0;
  const deadlines = [];
  await assert.rejects(
    recoverStableReplacement(
      {
        recoverRoot: async () => {
          calls += 1;
          await new Promise(() => {});
        },
      },
      {
        timeoutMs: 25,
        onDeadline: (message, timeoutMs) => {
          deadlines.push({ message, timeoutMs });
        },
      },
    ),
    /root recovery did not settle within 25ms/u,
  );
  assert.equal(calls, 1);
  assert.deepEqual(deadlines, [{
    message: "root recovery did not settle within 25ms",
    timeoutMs: 25,
  }]);
});
