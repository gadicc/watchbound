import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { classifyReleaseChanges } from "../../scripts/lib/release-classification.mjs";

const BREAKING_COMMIT = `feat(api)!: require explicit root qualification

BREAKING CHANGE: capabilities.support.currentRuntime.supported was removed. capabilities.support.currentRuntime.targetCompatible covers only packaged-target compatibility. Full host/root qualification now requires qualifyRoot(root).`;

test("semantic-release classifies the supported-field removal as major", async () => {
  const requireFromSemanticRelease = createRequire(import.meta.resolve("semantic-release"));
  const analyzer = await import(
    requireFromSemanticRelease.resolve("@semantic-release/commit-analyzer")
  );
  const releaseType = await analyzer.analyzeCommits(
    { preset: "conventionalcommits" },
    {
      commits: [{ message: BREAKING_COMMIT }],
      logger: { log() {} },
    },
  );
  assert.equal(releaseType, "major");
});

test("release paths classify docs as none, wrapper code as wrapper, and uncertainty as native", () => {
  assert.deepEqual(
    classifyReleaseChanges(["AGENTS.md", "README.md", "docs/releasing.md", "skills/watchbound/SKILL.md"]),
    {
      releaseClass: "none",
      reason: "documentation-only",
      paths: ["AGENTS.md", "README.md", "docs/releasing.md", "skills/watchbound/SKILL.md"],
    },
  );
  assert.equal(
    classifyReleaseChanges(["README.md", "js/index.js", "js/index.d.ts"]).releaseClass,
    "wrapper",
  );
  assert.equal(
    classifyReleaseChanges([
      "config/qualified-native-stack.json",
      "js/index.js",
    ]).releaseClass,
    "wrapper",
  );
  assert.equal(
    classifyReleaseChanges(["config/qualified-native-stack.json"]).releaseClass,
    "none",
  );
  for (const changed of [
    ["engine/src/lib.rs"],
    ["node/load-native.cjs"],
    ["config/native-matrix.json"],
    [".github/workflows/release.yml"],
    ["scripts/unknown-release-tool.mjs"],
    ["LICENSE.txt"],
    ["js/index.js", "some-new-area/file.txt"],
  ]) {
    assert.equal(
      classifyReleaseChanges(changed).releaseClass,
      "native",
      changed.join(", "),
    );
  }
});
