import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseOptions } from "../lib/cli.mjs";
import { scenarioExclusionReason } from "../lib/controller.mjs";
import {
  createRootRecoveryScanTree,
  rootRecoveryScanCount,
  scenarioNames,
  scenarioRequirement,
} from "../lib/scenarios.mjs";

test("direct and ancestor recovery stress trees use the same bounded size", () => {
  assert.equal(rootRecoveryScanCount(1), 128);
  assert.equal(rootRecoveryScanCount(100), 200);
  assert.equal(rootRecoveryScanCount(10_000), 512);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-recovery-scan-test-"));
  try {
    const direct = createRootRecoveryScanTree(root, "direct", 7);
    const ancestor = createRootRecoveryScanTree(root, "ancestor", 7);
    assert.equal(fs.readdirSync(direct).length, 7);
    assert.equal(fs.readdirSync(ancestor).length, 7);
    assert.notEqual(direct, ancestor);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit root recovery is an ordinary capability-gated conformance scenario", () => {
  assert.ok(scenarioNames.includes("root-replacement-recovery"));
  assert.equal(
    scenarioRequirement("root-replacement-recovery"),
    "rootReplacementRecovery",
  );
  const options = parseOptions("conformance", [
    "--adapter",
    "watchbound",
    "--scenario",
    "root-replacement-recovery",
    "--quick",
  ]);
  assert.deepEqual(options.scenarios, ["root-replacement-recovery"]);
  assert.equal(options.allowForcedOverflow, false);
});

test("explicit root recovery is excluded unless the public capability is present", () => {
  const plan = { scenario: "root-replacement-recovery" };
  const probe = {
    status: "available",
    adapter: {
      capabilities: {
        rootReplacementRecovery: false,
        explicitCoverage: true,
        dynamicExclusions: { supported: true, atomic: true },
      },
    },
  };
  assert.match(scenarioExclusionReason(plan, probe), /root replacement recovery/iu);
  probe.adapter.capabilities.rootReplacementRecovery = true;
  assert.equal(scenarioExclusionReason(plan, probe), null);
});
