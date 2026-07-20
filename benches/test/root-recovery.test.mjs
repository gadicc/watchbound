import assert from "node:assert/strict";
import test from "node:test";

import { parseOptions } from "../lib/cli.mjs";
import { scenarioExclusionReason } from "../lib/controller.mjs";
import { scenarioNames, scenarioRequirement } from "../lib/scenarios.mjs";

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
