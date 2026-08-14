import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { loadNativeMatrix, targetForId } from "./lib/native-matrix.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const matrix = loadNativeMatrix(workspaceRoot);
const target = targetForId(matrix, options.target);
const testedRuntime = matrix.testedRuntimes.node.find(
  ({ version }) => version === options.version,
);
assert.ok(testedRuntime, `Node ${options.version} is absent from tested runtime evidence`);
assert.ok(
  testedRuntime.architectures.includes(process.arch),
  `Node ${options.version} is not configured for ${process.arch}`,
);
assert.equal(testedRuntime.coverage, options.coverage);
assert.equal(process.versions.node, options.version);
assert.ok(Number(process.versions.napi) >= matrix.nodeApiMinimum);
assert.equal(process.platform, target.platform);
assert.equal(process.arch, target.architecture);

const version = readJson(path.join(workspaceRoot, "package.json")).version;
const prepared = readJson(path.join(workspaceRoot, "dist/native-package-manifest.json"));
const preparedTarget = prepared.targets.find(({ id }) => id === target.id);
assert.ok(preparedTarget, `prepared packages omit ${target.id}`);
const nativePath = path.join(workspaceRoot, "dist", preparedTarget.root, target.binary);
const nativeSha256 = sha256(nativePath);
assert.equal(nativeSha256, preparedTarget.sha256);
assert.equal(
  nativeSha256,
  options["native-sha256"],
  "prepared package does not contain the retained source-build addon",
);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-node-runtime-"));
try {
  writeJson(path.join(scratch, "package.json"), { private: true, type: "module" });
  const targetTarball = tarballPath(target.package, version);
  const loaderTarball = tarballPath("@gadicc/watchbound-node", version);
  const wrapperTarball = tarballPath("watchbound", version);
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--offline",
    targetTarball,
    loaderTarball,
    wrapperTarball,
  ], scratch);

  if (options.coverage === "full-lifecycle") {
    run(process.execPath, [
      path.join(workspaceRoot, "scripts/check-installed-package.mjs"),
      "--project",
      scratch,
      "--wrapper",
      "watchbound",
      "--version",
      version,
      "--native-target",
      target.id,
      "--native-sha256",
      nativeSha256,
      "--route",
      `node-${options.version}-${process.arch}`,
      ...(options.evidence ? ["--evidence", path.resolve(options.evidence)] : []),
    ], workspaceRoot);
  } else {
    const entry = path.join(scratch, "node_modules/watchbound/index.js");
    const watchbound = await import(pathToFileURL(entry));
    assert.equal(watchbound.capabilities.build.nodeApi, matrix.nodeApiMinimum);
    assert.equal(watchbound.capabilities.build.packagedTarget.id, target.id);
    assert.equal(watchbound.capabilities.build.packagedTarget.sha256, nativeSha256);
    assert.equal(watchbound.capabilities.support.nodeRange, matrix.nodeRange);
    assert.deepEqual(watchbound.createEngine().runtimeStats(), {
      active: false,
      inotifyInstances: 0,
      workerThreads: 0,
      nativeWatches: 0,
      nativeWatchBudget: null,
      deferredInterests: 0,
      subscriptions: 0,
    });
  }

  process.stdout.write(`${JSON.stringify({
    kind: "watchbound-node-runtime-compatibility",
    status: "passed",
    node: process.versions.node,
    nodeApi: Number(process.versions.napi),
    architecture: process.arch,
    target: target.id,
    coverage: options.coverage,
    nativeSha256,
  })}\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

function tarballPath(packageName, packageVersion) {
  const filename = `${packageName.replace(/^@/u, "").replaceAll("/", "-")}-${packageVersion}.tgz`;
  const result = path.join(workspaceRoot, "dist/tarballs", filename);
  assert.ok(fs.existsSync(result), `prepared tarball is missing: ${filename}`);
  return result;
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: check-node-runtime.mjs --target <id> --version <version> --coverage <admission|full-lifecycle> --native-sha256 <digest> [--evidence <path>]",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  assert.ok(parsed.target, "--target is required");
  assert.ok(parsed.version, "--version is required");
  assert.match(parsed["native-sha256"] ?? "", /^[0-9a-f]{64}$/u);
  assert.ok(
    parsed.coverage === "admission" || parsed.coverage === "full-lifecycle",
    "--coverage must be admission or full-lifecycle",
  );
  return parsed;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function writeJson(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}
