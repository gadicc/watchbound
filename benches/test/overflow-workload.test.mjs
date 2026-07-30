import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_APPROVED_KERNEL_QUEUE_EVENTS,
  OVERFLOW_EVENT_MARGIN,
  planOverflowWorkload,
} from "../lib/overflow-workload.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("overflow workload stays within the retained qualification envelope", () => {
  assert.equal(MAX_APPROVED_KERNEL_QUEUE_EVENTS, 16_384);
  assert.equal(OVERFLOW_EVENT_MARGIN, 4_096);
  assert.deepEqual(planOverflowWorkload("16384\n"), {
    kernelQueueLimit: 16_384,
    generatedEventCount: 20_480,
    exceededQueueBy: 4_096,
    approvedMaximumKernelQueueLimit: 16_384,
  });
  assert.deepEqual(planOverflowWorkload("1"), {
    kernelQueueLimit: 1,
    generatedEventCount: 4_097,
    exceededQueueBy: 4_096,
    approvedMaximumKernelQueueLimit: 16_384,
  });
});

test("overflow workload fails closed instead of capping oversized hosts", () => {
  assert.throws(
    () => planOverflowWorkload("16385"),
    /exceeds approved forced-overflow ceiling 16384/u,
  );
  assert.throws(
    () => planOverflowWorkload(String(Number.MAX_SAFE_INTEGER)),
    /exceeds approved forced-overflow ceiling 16384/u,
  );
});

test("overflow workload rejects missing or malformed kernel limits", () => {
  for (const value of [undefined, null, "", "0", "-1", "16.5", "unavailable"]) {
    assert.throws(
      () => planOverflowWorkload(value),
      /max_queued_events must be a positive base-10 integer/u,
    );
  }
});

test("preflight and both overflow scenario paths share the bounded planner", () => {
  const scenarios = fs.readFileSync(
    path.join(workspaceRoot, "benches/lib/scenarios.mjs"),
    "utf8",
  );
  const preflight = fs.readFileSync(
    path.join(workspaceRoot, "scripts/record-overflow-preflight.mjs"),
    "utf8",
  );

  assert.equal(scenarios.match(/planOverflowWorkload\(/gu)?.length, 2);
  assert.match(preflight, /overflowWorkload = planOverflowWorkload\(maxQueuedEvents\)/u);
  assert.doesNotMatch(
    scenarios,
    /kernelQueueLimit \+ 4_096|Number\.parseInt\([\s\S]*?max_queued_events/u,
  );
});
