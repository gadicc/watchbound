import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

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
