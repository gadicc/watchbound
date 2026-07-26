import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeMatrix, targetForId } from "./lib/native-matrix.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const matrix = loadNativeMatrix(workspaceRoot);
const target = targetForId(matrix, options.target);
const lane = matrix.qualificationLanes.find(({ id }) => id === options.lane);
assert.ok(lane && lane.family !== "nix", `unknown container qualification lane: ${options.lane}`);
assert.equal(options.image, lane.image, "workflow image differs from the pinned matrix");
assert.ok(lane.architectures.includes(target.architecture));
const version = readJson(path.join(workspaceRoot, "package.json")).version;
const packageManifest = readJson(path.join(workspaceRoot, "dist/native-package-manifest.json"));
const packagedTarget = packageManifest.targets.find(({ id }) => id === target.id);
assert.ok(packagedTarget, `prepared tree omits ${target.id}`);
const tarballRoot = path.join(workspaceRoot, "dist/tarballs");
const targetTarball = tarballName(target.package, version);
const loaderTarball = tarballName(packageManifest.loader.name, version);
const wrapperTarball = tarballName(packageManifest.wrapper.name, version);
for (const filename of [targetTarball, loaderTarball, wrapperTarball]) {
  assert.ok(fs.existsSync(path.join(tarballRoot, filename)), `missing ${filename}`);
}
const nativePath = path.join(workspaceRoot, "dist", packagedTarget.root, target.binary);
const nativeSha256 = sha256(nativePath);
assert.equal(nativeSha256, packagedTarget.sha256);
const evidence = path.resolve(options.evidence);
fs.mkdirSync(path.dirname(evidence), { recursive: true });

run("docker", [
  "run", "--rm", "--platform", `linux/${target.architecture === "x64" ? "amd64" : "arm64"}`,
  "--volume", `${workspaceRoot}:/work:ro`,
  "--volume", `${tarballRoot}:/packages:ro`,
  "--volume", `${path.resolve(options["node-root"])}:/watchbound-node:ro`,
  "--volume", `${path.dirname(evidence)}:/evidence`,
  "--env", `WATCHBOUND_TARGET_ID=${target.id}`,
  "--env", `WATCHBOUND_TARGET_PACKAGE=${target.package}`,
  "--env", `WATCHBOUND_NODE_ARCH=${target.architecture}`,
  "--env", `WATCHBOUND_VERSION=${version}`,
  "--env", `WATCHBOUND_NATIVE_SHA256=${nativeSha256}`,
  "--env", `WATCHBOUND_LANE=${lane.id}`,
  "--env", `WATCHBOUND_TARGET_TARBALL=${targetTarball}`,
  "--env", `WATCHBOUND_LOADER_TARBALL=${loaderTarball}`,
  "--env", `WATCHBOUND_WRAPPER_TARBALL=${wrapperTarball}`,
  "--env", `WATCHBOUND_EVIDENCE=/evidence/${path.basename(evidence)}`,
  lane.image,
  "bash", "/work/scripts/fixtures/distro-package-smoke.sh",
]);

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("usage: run-distro-qualification.mjs --lane <id> --target <id> --image <digest> --node-root <path> --evidence <path>");
    }
    parsed[flag.slice(2)] = value;
  }
  for (const required of ["lane", "target", "image", "node-root", "evidence"]) {
    assert.ok(parsed[required], `--${required} is required`);
  }
  return parsed;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: workspaceRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function tarballName(name, version) {
  return `${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function sha256(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}
