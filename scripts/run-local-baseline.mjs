import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeMatrix } from "./lib/native-matrix.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const matrix = loadNativeMatrix(workspaceRoot);
const scratchRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "watchbound-local-baseline-"),
);
const conformanceOutput = path.join(scratchRoot, "conformance.json");
const benchmarkOutput = path.join(scratchRoot, "benchmark.json");
const ordinaryScenarios = [
  "normal-deep-change",
  "moved-in-subtree",
  "root-replacement",
  "root-replacement-recovery",
  "watch-limit",
  "bridge-backpressure",
  "dynamic-exclusions",
  "reconciliation",
  "automatic-reconciliation",
  "burst-files",
  "burst-directories",
  "burst-renames",
  "disposal",
];
const forcedOverflowScenarios = new Set([
  "queue-overflow",
  "overflow-reconciliation",
  "automatic-overflow-reconciliation",
]);

assert.equal(process.platform, "linux", "local baseline requires Linux");
assert.equal(process.arch, "x64", "local baseline requires Linux x64");
assertSupportedNode();

try {
  run("pnpm", ["build:node"]);
  run(process.execPath, [
    "benches/conformance.mjs",
    "--adapter",
    "watchbound",
    "--scenarios",
    ordinaryScenarios.join(","),
    "--quick",
    "--order",
    "rotating",
    "--strict",
    "--output",
    conformanceOutput,
    "--quiet",
  ]);
  run(process.execPath, [
    "--expose-gc",
    "benches/benchmark.mjs",
    "--adapter",
    "watchbound",
    "--quick",
    "--order",
    "rotating",
    "--strict",
    "--output",
    benchmarkOutput,
    "--quiet",
  ]);

  const conformance = validateReport(conformanceOutput, "conformance");
  const benchmark = validateReport(benchmarkOutput, "benchmark");
  process.stdout.write(
    [
      `Local Watchbound baseline passed on ${process.version}.`,
      `Conformance: ${conformance.summary.passed}/${conformance.summary.planned} ordinary scenarios in ${conformance.durationMs} ms.`,
      `Benchmark smoke: ${benchmark.summary.passed}/${benchmark.summary.planned} quick trials in ${benchmark.durationMs} ms.`,
      "Quick timings are functionality smoke only; no raw report or release evidence was retained.",
      "",
    ].join("\n"),
  );
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

function validateReport(source, expectedSuite) {
  const report = JSON.parse(fs.readFileSync(source, "utf8"));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.suite, expectedSuite);
  assert.deepEqual(report.config.adapters, ["watchbound"]);
  assert.equal(report.config.quick, true);
  assert.equal(report.config.allowForcedOverflow, false);
  assert.equal(report.config.runs, 1);
  assert.deepEqual(report.config.directoryCounts, [100]);
  assert.equal(report.config.burstCount, 100);
  assert.equal(
    report.config.scenarios.some((scenario) =>
      forcedOverflowScenarios.has(scenario)
    ),
    false,
    "local baseline must not select a forced-overflow scenario",
  );
  assert.equal(report.summary.planned, report.summary.executed);
  assert.equal(report.summary.planned, report.summary.completed);
  assert.equal(report.summary.planned, report.summary.passed);
  assert.equal(report.summary.excluded, 0);
  assert.equal(report.summary.nonconforming, 0);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.summary.runtimeSkips, 0);
  assert.equal(report.summary.cleanupErrors, 0);
  assert.equal(report.summary.skipped, 0);
  return report;
}

function assertSupportedNode() {
  const observed = process.versions.node
    .split(".")
    .map((part) => Number(part));
  const minimum = matrix.nodeMinimum.split(".").map((part) => Number(part));
  let comparison = 0;
  for (let index = 0; index < minimum.length; index += 1) {
    if (observed[index] !== minimum[index]) {
      comparison = observed[index] - minimum[index];
      break;
    }
  }
  assert.ok(
    observed.length === minimum.length &&
      observed.every(Number.isSafeInteger) &&
      comparison >= 0,
    `local baseline requires Node ${matrix.nodeRange}, found ${process.version}`,
  );
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}`,
    );
  }
}
