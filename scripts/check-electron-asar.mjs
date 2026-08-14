import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPackageWithOptions, statFile } from "@electron/asar";
import { readPreparedArmhfRuntime } from "./lib/armhf-runtime.mjs";
import { loadNativeMatrix, targetForId } from "./lib/native-matrix.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const electron = path.resolve(options.electron);
const matrix = loadNativeMatrix(workspaceRoot);
const target = targetForId(matrix, options.target);
const expectedRuntime = options.runtime
  ? matrix.testedRuntimes.electron.find(({ id }) => id === options.runtime)
  : {
      id: "codex-upstream-reference",
      electron: matrix.codexRuntime.electron,
      node: matrix.codexRuntime.node,
      nodeApi: matrix.codexRuntime.nodeApi,
    };
assert.ok(expectedRuntime, `native matrix omits Electron runtime ${options.runtime}`);
if (options.runtime) {
  assert.equal(expectedRuntime.architecture, target.architecture);
}
const packageManifest = readJson(path.join(workspaceRoot, "dist/native-package-manifest.json"));
const packagedTarget = packageManifest.targets.find(({ id }) => id === target.id);
assert.ok(packagedTarget, `prepared package tree omits ${target.id}`);
const nativePath = path.join(workspaceRoot, "dist", packagedTarget.root, target.binary);
const nativeSha256 = sha256(nativePath);
assert.equal(nativeSha256, packagedTarget.sha256);
if (options["native-sha256"]) {
  assert.match(options["native-sha256"], /^[0-9a-f]{64}$/u);
  assert.equal(
    nativeSha256,
    options["native-sha256"],
    "prepared package does not contain the retained source-build addon",
  );
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-electron-asar-"));
const appRoot = path.join(scratch, "app");
const resourcesRoot = path.join(scratch, "resources");
const asarPath = path.join(resourcesRoot, "app.asar");
try {
  copyTree(path.join(workspaceRoot, "dist/npm/wrapper"), path.join(appRoot, "node_modules/watchbound"));
  copyTree(path.join(workspaceRoot, "dist/npm/node"), path.join(appRoot, "node_modules/@gadicc/watchbound-node"));
  copyTree(
    path.join(workspaceRoot, "dist", packagedTarget.root),
    path.join(appRoot, "node_modules", ...target.package.split("/")),
  );
  fs.copyFileSync(
    path.join(workspaceRoot, "scripts/fixtures/electron-asar-smoke.cjs"),
    path.join(appRoot, "index.cjs"),
  );
  fs.copyFileSync(
    path.join(workspaceRoot, "scripts/fixtures/exclusion-smoke-helpers.cjs"),
    path.join(appRoot, "exclusion-smoke-helpers.cjs"),
  );
  writeJson(path.join(appRoot, "package.json"), {
    private: true,
    main: "index.cjs",
  });
  fs.mkdirSync(resourcesRoot, { recursive: true });
  await createPackageWithOptions(appRoot, asarPath, { unpack: "*.node" });

  const archiveNative = path.join("node_modules", ...target.package.split("/"), target.binary);
  assert.equal(statFile(asarPath, archiveNative).unpacked, true);
  const unpackedNative = path.join(`${asarPath}.unpacked`, archiveNative);
  assert.ok(fs.existsSync(unpackedNative), "ASAR packer did not materialize the native addon");
  assert.equal(sha256(unpackedNative), nativeSha256);

  const versions = runElectron(electron, [
    "-p",
    "JSON.stringify(process.versions)",
  ]);
  const runtime = JSON.parse(versions.stdout.trim());
  assert.equal(runtime.electron, expectedRuntime.electron);
  assert.equal(runtime.node, expectedRuntime.node);
  assert.equal(Number(runtime.napi), expectedRuntime.nodeApi);

  const smoke = runElectron(electron, [asarPath], {
    WATCHBOUND_EXPECTED_TARGET: target.id,
    WATCHBOUND_EXPECTED_NATIVE_SHA256: nativeSha256,
    WATCHBOUND_EXPECTED_ELECTRON: expectedRuntime.electron,
    WATCHBOUND_EXPECTED_NODE: expectedRuntime.node,
    WATCHBOUND_EXPECTED_NODE_API: String(expectedRuntime.nodeApi),
  });
  const resultLine = smoke.stdout.split(/\r?\n/u)
    .find((line) => line.includes('"kind":"watchbound-electron-asar-smoke"'));
  assert.ok(resultLine, `Electron smoke omitted structured output:\n${smoke.stdout}`);
  const result = JSON.parse(resultLine);
  assert.equal(result.status, "passed");
  assert.equal(result.target, target.id);
  assert.equal(result.nativeSha256, nativeSha256);

  const evidence = {
    schemaVersion: 1,
    kind: "watchbound-electron-asar-qualification",
    status: "passed",
    target: target.id,
    runtimeId: expectedRuntime.id,
    runtime,
    archive: {
      name: matrix.codexRuntime.asar.archive,
      nativeDirectory: matrix.codexRuntime.asar.nativeDirectory,
      sha256: sha256(asarPath),
      unpackedNativeSha256: sha256(unpackedNative),
    },
    smoke: result,
    execution: options.emulator
      ? {
          mode: "qemu-user",
          emulator: path.basename(options.emulator),
          cpu: options["emulator-cpu"],
          rootfs: readPreparedArmhfRuntime(options.rootfs, target),
        }
      : { mode: "native" },
  };
  if (options.evidence) writeJson(path.resolve(options.evidence), evidence);
  process.stdout.write(`Electron ${runtime.electron} ASAR smoke passed for ${target.id}\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

function runElectron(executable, args, environment = {}) {
  const command = options.emulator ? path.resolve(options.emulator) : executable;
  const commandArguments = options.emulator
    ? [
        ...(options["emulator-cpu"] ? ["-cpu", options["emulator-cpu"]] : []),
        "-L",
        path.resolve(options.rootfs),
        "-E",
        `LD_LIBRARY_PATH=${path.dirname(executable)}`,
        executable,
        ...args,
      ]
    : args;
  const result = spawnSync(command, commandArguments, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, ...environment, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Electron failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("usage: check-electron-asar.mjs --electron <path> --target <id> [--runtime <id>] [--native-sha256 <digest>] [--evidence <path>] [--emulator <path> --emulator-cpu <cpu> --rootfs <path>]");
    }
    parsed[flag.slice(2)] = value;
  }
  assert.ok(parsed.electron, "--electron is required");
  assert.ok(parsed.target, "--target is required");
  if (parsed.emulator) {
    assert.ok(parsed.rootfs, "--rootfs is required with --emulator");
  } else {
    assert.equal(parsed.rootfs, undefined, "--rootfs requires --emulator");
    assert.equal(parsed["emulator-cpu"], undefined, "--emulator-cpu requires --emulator");
  }
  return parsed;
}

function copyTree(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function writeJson(destination, value) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}
