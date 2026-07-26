import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  loadNativeMatrix,
  nativeArtifactEntries,
  targetForId,
  targetForRuntime,
} from "./lib/native-matrix.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseOptions(process.argv.slice(2));
const matrix = loadNativeMatrix(workspaceRoot);
const target = options.target
  ? targetForId(matrix, options.target)
  : targetForRuntime(matrix, process.platform, process.arch);
const artifactPath = path.resolve(
  workspaceRoot,
  options.artifact ?? path.join("node", target.binary),
);
const outputPath = path.resolve(workspaceRoot, options.output);
const rootPackage = readJson(path.join(workspaceRoot, "package.json"));
const status = capture("git", [
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
]);
const nativeFiles = nativeArtifactEntries(workspaceRoot);

assert.equal(status, "", "native build evidence requires a clean source checkout");
assert.deepEqual(
  nativeFiles,
  [target.binary],
  "native build evidence requires exactly the intended addon",
);
assert.ok(fs.existsSync(artifactPath), `missing native artifact: ${artifactPath}`);

const require = createRequire(import.meta.url);
const binding = require(path.join(workspaceRoot, "node/index.js"));
const metadata = binding.bindingMetadata();
assert.equal(metadata.nativeVersion, rootPackage.version);
assert.equal(metadata.engineVersion, rootPackage.version);
assert.equal(metadata.targetTriple, target.rustTarget);
assert.equal(metadata.buildProfile, "release");

const osRelease = readOsRelease();
const manifest = {
  schemaVersion: 1,
  kind: "watchbound-independent-native-build",
  builder: options.builder,
  source: {
    gitHead: capture("git", ["rev-parse", "HEAD"]),
    gitDirty: false,
    locks: {
      cargo: sha256(path.join(workspaceRoot, "Cargo.lock")),
      pnpm: sha256(path.join(workspaceRoot, "pnpm-lock.yaml")),
    },
  },
  release: {
    version: rootPackage.version,
    targetId: target.id,
    target: metadata.targetTriple,
    architecture: target.architecture,
    profile: metadata.buildProfile,
    nodeApi: metadata.nodeApiVersion,
  },
  buildEnvironment: {
    cargoIncremental: requiredEnvironment("CARGO_INCREMENTAL"),
    rustFlags: requiredEnvironment("RUSTFLAGS"),
    sourceDateEpoch: requiredEnvironment("SOURCE_DATE_EPOCH"),
    timezone: requiredEnvironment("TZ"),
  },
  isolation: {
    cargoHome: requiredEnvironment("CARGO_HOME"),
    cargoTargetDirectory: requiredEnvironment("CARGO_TARGET_DIR"),
    corepackHome: requiredEnvironment("COREPACK_HOME"),
    pnpmStoreDirectory: requiredEnvironment("PNPM_STORE_DIR"),
    rustupHome: requiredEnvironment("RUSTUP_HOME"),
  },
  artifact: {
    filename: path.basename(artifactPath),
    bytes: fs.statSync(artifactPath).size,
    sha256: sha256(artifactPath),
  },
  host: {
    distribution: `${osRelease.ID ?? "unknown"} ${osRelease.VERSION_ID ?? "unknown"}`,
    kernel: capture("uname", ["-r"]),
    architecture: capture("uname", ["-m"]),
    glibc: capture("getconf", ["GNU_LIBC_VERSION"]),
  },
  tools: {
    node: process.version,
    pnpm: capture("pnpm", ["--version"]),
    rustc: capture("rustc", ["--version", "--verbose"]),
    cargo: capture("cargo", ["--version"]),
    cc: capture("cc", ["--version"]),
    ld: capture("ld", ["--version"]),
  },
  runner: {
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    os: process.env.RUNNER_OS ?? null,
    architecture: process.env.RUNNER_ARCH ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null,
  },
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(
  `Recorded ${options.builder} native build ${manifest.artifact.sha256}\n`,
);

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: record-native-build.mjs --builder <id> --output <path> [--target <id>] [--artifact <path>]",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  assert.match(parsed.builder ?? "", /^[a-z][a-z0-9-]*$/u);
  assert.ok(parsed.output, "--output is required");
  return parsed;
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function sha256(source) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(source))
    .digest("hex");
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function readOsRelease() {
  const fields = {};
  const source = fs.readFileSync("/etc/os-release", "utf8");
  for (const line of source.split(/\r?\n/u)) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line);
    if (!match) continue;
    fields[match[1]] = match[2].replace(/^"(.*)"$/u, "$1");
  }
  return fields;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} must identify the isolated builder environment`);
  return value;
}
