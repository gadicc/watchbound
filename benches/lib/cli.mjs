import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapterIds } from "../adapters/index.mjs";
import { runSuite } from "./controller.mjs";
import { scenarioNames } from "./scenarios.mjs";

const DEFAULT_CONFORMANCE_SCENARIOS = [
  "normal-deep-change",
  "moved-in-subtree",
  "root-replacement",
  "watch-limit",
  "bridge-backpressure",
  "queue-overflow",
  "dynamic-exclusions",
  "reconciliation",
  "burst-files",
  "burst-directories",
  "burst-renames",
  "disposal",
];
const DEFAULT_BENCHMARK_SCENARIOS = [
  "startup-cold",
  "startup-warm",
  "burst-files",
  "burst-directories",
  "burst-renames",
  "disposal",
];

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function list(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function help(kind) {
  return `Usage: node benches/${kind}.mjs [options]

Outputs one JSON document to stdout. Trials are isolated and run serially.

  --adapter, --adapters <ids>       watchbound,codex-js,parcel-watcher (comma-separated)
  --scenario, --scenarios <names>   comma-separated scenario names
  --runs <n>                        repetitions (benchmark: 3, conformance: 1)
  --directories <counts>            startup tree sizes (default: 1000,10000)
  --burst-count <n>                 operations in each burst (default: 1000)
  --max-watches <n>                 adapter watch budget where supported (default: 65536)
  --timeout-ms <n>                  event observation timeout (default: 5000)
  --child-timeout-ms <n>            hard timeout for the entire isolated trial (default: 30000)
  --settle-ms <n>                   event quiet window (default: 100)
  --topology-delay-ms <n>           discovery/recovery window (default: 350)
  --temp-dir <path>                 parent for temporary trees (default: os.tmpdir())
  --output <path>                   also write the JSON report to this path
  --quiet                           suppress stdout (requires --output)
  --order <rotating|fixed>          adapter order within repeated trials (default: rotating)
  --quick                           100 directories/events, one run, no forced overflow
  --pretty                          indent JSON output
  --strict                          exit non-zero on errors or failed checks
  --help                            show this text

Scenarios: ${scenarioNames.join(", ")}

Environment:
  WATCHBOUND_CODEX_WATCHER_PATH     exact patch.js helper to benchmark
  WATCHBOUND_PARCEL_WATCHER_PATH    optional exact @parcel/watcher 2.5.6 package path
`;
}

export function parseOptions(kind, argv) {
  const options = {
    adapters: [...adapterIds],
    scenarios:
      kind === "benchmark" ? [...DEFAULT_BENCHMARK_SCENARIOS] : [...DEFAULT_CONFORMANCE_SCENARIOS],
    runs: kind === "benchmark" ? 3 : 1,
    directoryCounts: [1_000, 10_000],
    burstCount: 1_000,
    maxWatches: 65_536,
    timeoutMs: 5_000,
    childTimeoutMs: 30_000,
    settleMs: 100,
    topologyDelayMs: 350,
    exclusionObservationMs: 500,
    disposalObservationMs: 300,
    tempDir: os.tmpdir(),
    outputPath: null,
    quiet: false,
    trialOrder: "rotating",
    pretty: false,
    strict: false,
    quick: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    let argument = argv[index];
    let inlineValue = null;
    const equals = argument.indexOf("=");
    if (equals > 0) {
      inlineValue = argument.slice(equals + 1);
      argument = argument.slice(0, equals);
    }
    const value = () => {
      if (inlineValue != null) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} requires a value`);
      return argv[index];
    };

    if (argument === "--adapter" || argument === "--adapters") options.adapters = list(value());
    else if (argument === "--scenario" || argument === "--scenarios") options.scenarios = list(value());
    else if (argument === "--runs") options.runs = positiveInteger(value(), argument);
    else if (argument === "--directories") {
      options.directoryCounts = list(value()).map((entry) => positiveInteger(entry, argument));
    } else if (argument === "--burst-count") {
      options.burstCount = positiveInteger(value(), argument);
    } else if (argument === "--max-watches") {
      options.maxWatches = positiveInteger(value(), argument);
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = positiveInteger(value(), argument);
    } else if (argument === "--child-timeout-ms") {
      options.childTimeoutMs = positiveInteger(value(), argument);
    } else if (argument === "--settle-ms") {
      options.settleMs = positiveInteger(value(), argument);
    } else if (argument === "--topology-delay-ms") {
      options.topologyDelayMs = positiveInteger(value(), argument);
    } else if (argument === "--temp-dir") options.tempDir = value();
    else if (argument === "--output") options.outputPath = path.resolve(value());
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--order") options.trialOrder = value();
    else if (argument === "--pretty") options.pretty = true;
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--quick") options.quick = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }

  const unknownAdapters = options.adapters.filter((id) => !adapterIds.includes(id));
  if (unknownAdapters.length > 0) throw new Error(`Unknown adapter(s): ${unknownAdapters.join(", ")}`);
  const unknownScenarios = options.scenarios.filter((name) => !scenarioNames.includes(name));
  if (unknownScenarios.length > 0) throw new Error(`Unknown scenario(s): ${unknownScenarios.join(", ")}`);
  const duplicateAdapters = duplicates(options.adapters);
  if (duplicateAdapters.length > 0) {
    throw new Error(`Duplicate adapter(s): ${duplicateAdapters.join(", ")}`);
  }
  const duplicateScenarios = duplicates(options.scenarios);
  if (duplicateScenarios.length > 0) {
    throw new Error(`Duplicate scenario(s): ${duplicateScenarios.join(", ")}`);
  }
  if (options.adapters.length === 0) throw new Error("At least one adapter is required");
  if (options.scenarios.length === 0) throw new Error("At least one scenario is required");
  if (options.quiet && !options.outputPath) throw new Error("--quiet requires --output");
  if (!new Set(["rotating", "fixed"]).has(options.trialOrder)) {
    throw new Error("--order must be rotating or fixed");
  }
  if (options.childTimeoutMs <= options.timeoutMs) {
    throw new Error("--child-timeout-ms must be greater than --timeout-ms");
  }
  if (options.quick) {
    options.runs = 1;
    options.directoryCounts = [100];
    options.burstCount = 100;
    options.scenarios = options.scenarios.filter((name) => name !== "queue-overflow");
  }
  if (options.scenarios.length === 0) {
    throw new Error("No scenarios remain after applying command presets");
  }
  return options;
}

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

export function strictSummaryFailed(summary) {
  return (
    summary.errors > 0 ||
    summary.nonconforming > 0 ||
    summary.skipped > 0 ||
    summary.cleanupErrors > 0 ||
    summary.completed === 0
  );
}

export async function main(kind, argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseOptions(kind, argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${help(kind)}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(help(kind));
    return;
  }
  const report = await runSuite(kind, options);
  const serialized = `${JSON.stringify(report, null, options.pretty ? 2 : 0)}\n`;
  if (options.outputPath) {
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });
    fs.writeFileSync(options.outputPath, serialized);
  }
  if (!options.quiet) process.stdout.write(serialized);
  if (options.strict && strictSummaryFailed(report.summary)) {
    process.exitCode = 1;
  }
}
