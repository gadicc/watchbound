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
  architecture: target.buildArchitecture ?? target.architecture,
  targetArchitecture: target.architecture,
  buildMode: target.buildMode ?? "native",
  runner: target.runner,
  binary: target.binary,
})));
const compare = matrix.targets.map((target) => ({
  target: target.id,
  architecture: target.buildArchitecture ?? target.architecture,
  targetArchitecture: target.architecture,
  runner: target.runner,
  binary: target.binary,
}));
const source = matrix.targets
  .filter((target) => target.buildMode !== "cross")
  .map((target) => ({
    target: target.id,
    architecture: target.architecture,
    runner: target.runner,
    binary: target.binary,
    overflowRunner: target.overflowRunner,
    electronArchitecture: target.codexElectron.archiveArchitecture,
    electronSha256SRI: target.codexElectron.sha256SRI,
  }));
const cross = matrix.targets
  .filter((target) => target.buildMode === "cross")
  .map((target) => ({
    target: target.id,
    architecture: target.buildArchitecture,
    targetArchitecture: target.architecture,
    runner: target.runner,
    binary: target.binary,
    rustTarget: target.rustTarget,
    linker: target.linker,
  }));
const runtime = matrix.targets
  .filter((target) => target.runtimeQualification === "qemu-user-electron")
  .map((target) => ({
    target: target.id,
    architecture: target.buildArchitecture,
    targetArchitecture: target.architecture,
    runner: target.runtimeRunner,
    binary: target.binary,
    electronArchitecture: target.codexElectron.archiveArchitecture,
    electronSha256SRI: target.codexElectron.sha256SRI,
    emulator: target.runtimeEmulator,
    emulatorCpu: target.runtimeCpu,
    rootfsImage: target.runtimeRootfs.image,
    binfmtImage: target.runtimeRootfs.binfmtImage,
    rootfsSnapshot: target.runtimeRootfs.snapshot,
  }));
const qualification = matrix.qualificationLanes
  .filter(({ evidence }) => evidence === "runtime-qualification-required")
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
const kernel = matrix.targets
  .filter((target) => matrix.kernelBaselineQualification.artifacts[target.architecture])
  .map((target) => {
    const baseline = matrix.kernelBaselineQualification;
    const artifactSet = baseline.artifacts[target.architecture];
    assert.ok(artifactSet, `kernel baseline omits ${target.architecture}`);
    return {
      target: target.id,
      architecture: target.buildArchitecture ?? target.architecture,
      targetArchitecture: target.architecture,
      runner: target.kernelRunner,
      binary: target.binary,
      image: baseline.image,
      kernelRelease: artifactSet.kernelRelease ?? baseline.kernelRelease,
      qemuPackage: artifactSet.qemuPackage,
      ...(artifactSet.rootfs
        ? {
            rootfsImage: target.runtimeRootfs.image,
            rootfsSnapshot: target.runtimeRootfs.snapshot,
            binfmtImage: target.runtimeRootfs.binfmtImage,
            electronArchitecture: target.codexElectron.archiveArchitecture,
            electronSha256SRI: target.codexElectron.sha256SRI,
          }
        : {}),
    };
  });
const nix = matrix.targets.filter((target) => target.nixSystem).map((target) => ({
  target: target.id,
  architecture: target.architecture,
  runner: target.runner,
  system: target.nixSystem,
}));
const registry = matrix.targets
  .filter((target) => target.runtimeQualification !== "qemu-user-electron")
  .flatMap((target) => ["npm", "jsr-node"].map((route) => ({
    route,
    target: target.id,
    architecture: target.architecture,
    runner: target.runner,
    binary: target.binary,
  })));
const registryEmulated = matrix.targets
  .filter((target) => target.runtimeQualification === "qemu-user-electron")
  .flatMap((target) => ["npm", "jsr-node"].map((route) => ({
    route,
    target: target.id,
    architecture: target.buildArchitecture,
    targetArchitecture: target.architecture,
    runner: target.runtimeRunner,
    binary: target.binary,
    electronArchitecture: target.codexElectron.archiveArchitecture,
    electronSha256SRI: target.codexElectron.sha256SRI,
    emulator: target.runtimeEmulator,
    emulatorCpu: target.runtimeCpu,
    rootfsImage: target.runtimeRootfs.image,
    binfmtImage: target.runtimeRootfs.binfmtImage,
    rootfsSnapshot: target.runtimeRootfs.snapshot,
  })));
const nodeRuntime = matrix.testedRuntimes.node.flatMap((runtime) =>
  runtime.architectures.map((architecture) => {
    const target = matrix.targets.find((candidate) =>
      candidate.architecture === architecture && candidate.buildMode !== "cross");
    assert.ok(target, `Node runtime ${runtime.version} omits target ${architecture}`);
    return {
      target: target.id,
      architecture,
      runner: target.runner,
      binary: target.binary,
      nodeVersion: runtime.version,
      coverage: runtime.coverage,
      role: runtime.role,
    };
  }));
const electronRuntime = matrix.testedRuntimes.electron.map((runtime) => {
  const target = matrix.targets.find((candidate) =>
    candidate.architecture === runtime.architecture);
  assert.ok(target, `Electron runtime ${runtime.id} omits ${runtime.architecture}`);
  return {
    target: target.id,
    architecture: target.architecture,
    runner: target.runner,
    binary: target.binary,
    runtime: runtime.id,
    electron: runtime.electron,
    node: runtime.node,
    nodeApi: runtime.nodeApi,
    electronArchitecture: runtime.archiveArchitecture,
    electronSha256: runtime.archiveSha256,
  };
});

export const outputs = {
  buildNode: matrix.buildNode,
  source,
  cross,
  runtime,
  build,
  compare,
  qualification,
  kernel,
  nix,
  registry,
  registryEmulated,
  nodeRuntime,
  electronRuntime,
};
if (import.meta.main && options["github-output"]) {
  const destination = path.resolve(options["github-output"]);
  fs.appendFileSync(
    destination,
    `${Object.entries(outputs).map(([name, value]) =>
      `${name}=${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n")}\n`,
  );
} else if (import.meta.main) {
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
