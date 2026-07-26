import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeMatrix } from "./lib/native-matrix.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const matrix = loadNativeMatrix(workspaceRoot);
const build = matrix.targets.flatMap((target) => ["builder-a", "builder-b"].map((builder) => ({
  builder,
  target: target.id,
  architecture: target.architecture,
  runner: target.runner,
  binary: target.binary,
})));
const source = matrix.targets.map((target) => ({
  target: target.id,
  architecture: target.architecture,
  runner: target.runner,
  binary: target.binary,
  overflowRunner: target.overflowRunner,
  electronArchitecture: target.codexElectron.archiveArchitecture,
  electronSha256SRI: target.codexElectron.sha256SRI,
}));
const qualification = matrix.qualificationLanes
  .filter(({ family }) => family !== "nix")
  .flatMap((lane) => lane.architectures.map((architecture) => {
    const target = matrix.targets.find((candidate) => candidate.architecture === architecture);
    assert.ok(target, `${lane.id} references unconfigured ${architecture}`);
    return {
      lane: lane.id,
      target: target.id,
      architecture,
      runner: target.runner,
      binary: target.binary,
      image: lane.image,
    };
  }));
const kernel = matrix.targets.map((target) => {
  const baseline = matrix.kernelBaselineQualification;
  const artifactSet = baseline.artifacts[target.architecture];
  assert.ok(artifactSet, `kernel baseline omits ${target.architecture}`);
  return {
    target: target.id,
    architecture: target.architecture,
    runner: target.runner,
    binary: target.binary,
    image: baseline.image,
    kernelRelease: baseline.kernelRelease,
    qemuPackage: artifactSet.qemuPackage,
  };
});
const nix = matrix.targets.map((target) => ({
  target: target.id,
  architecture: target.architecture,
  runner: target.runner,
  system: target.nixSystem,
}));
const registry = matrix.targets.flatMap((target) => ["npm", "jsr-node"].map((route) => ({
  route,
  target: target.id,
  architecture: target.architecture,
  runner: target.runner,
  binary: target.binary,
})));

const outputs = { source, build, qualification, kernel, nix, registry };
if (options["github-output"]) {
  const destination = path.resolve(options["github-output"]);
  fs.appendFileSync(
    destination,
    `${Object.entries(outputs).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n")}\n`,
  );
} else {
  process.stdout.write(`${JSON.stringify(outputs, null, 2)}\n`);
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("usage: ci-matrix.mjs [--github-output <path>]");
    }
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}
