import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeMatrix, targetForId } from "./lib/native-matrix.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const outputRoot = path.resolve(options.output);
const artifact = path.resolve(options.artifact);
const matrix = loadNativeMatrix(workspaceRoot);
const target = targetForId(matrix, options.target);
const rootPackage = readJson("package.json");
const wrapperSource = readJson("js/package.json");
const loaderSource = readJson("node/package.json");
const version = rootPackage.version;
const modules = path.join(outputRoot, "lib/node_modules");
const wrapperRoot = path.join(modules, "watchbound");
const loaderRoot = path.join(modules, "@gadicc/watchbound-node");
const targetRoot = path.join(modules, ...target.package.split("/"));
const nativeSha256 = sha256(artifact);

for (const destination of [wrapperRoot, loaderRoot, targetRoot]) {
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(path.join(workspaceRoot, "README.md"), path.join(destination, "README.md"));
  fs.copyFileSync(path.join(workspaceRoot, "LICENSE.txt"), path.join(destination, "LICENSE.txt"));
}
for (const file of fs.readdirSync(path.join(workspaceRoot, "js"))
  .filter((file) => /\.(?:js|d\.ts)$/u.test(file))) {
  fs.copyFileSync(path.join(workspaceRoot, "js", file), path.join(wrapperRoot, file));
}
for (const file of ["index.js", "index.d.ts", "load-native.cjs"]) {
  fs.copyFileSync(path.join(workspaceRoot, "node", file), path.join(loaderRoot, file));
}
fs.copyFileSync(path.join(workspaceRoot, "config/native-matrix.json"), path.join(loaderRoot, "native-matrix.json"));
fs.copyFileSync(artifact, path.join(targetRoot, target.binary));

const common = {
  version,
  license: rootPackage.license,
  engines: { node: matrix.nodeRange },
  os: ["linux"],
};
writeJson(path.join(wrapperRoot, "package.json"), {
  name: "watchbound",
  ...common,
  type: "module",
  main: "./index.js",
  types: "./index.d.ts",
  exports: wrapperSource.exports,
  dependencies: { "@gadicc/watchbound-node": version },
  watchbound: { delivery: "bundled-native-package" },
});
writeJson(path.join(loaderRoot, "package.json"), {
  name: "@gadicc/watchbound-node",
  ...common,
  main: "./index.js",
  types: "./index.d.ts",
  exports: loaderSource.exports,
  optionalDependencies: Object.fromEntries(matrix.targets.map(({ package: name }) => [name, version])),
  watchbound: { delivery: "bundled-native-package", nativeMatrixSchema: matrix.schemaVersion },
});
writeJson(path.join(targetRoot, "package.json"), {
  name: target.package,
  ...common,
  cpu: [target.architecture],
  libc: [target.libc],
  main: `./${target.binary}`,
  exports: { ".": `./${target.binary}`, "./package.json": "./package.json" },
  watchbound: {
    delivery: "target-native-package",
    target: target.id,
    targetTriple: target.rustTarget,
    architecture: target.architecture,
    armAbi: target.armAbi ?? null,
    libc: target.libc,
    binary: target.binary,
    nativeSha256,
  },
});
process.stdout.write(`${nativeSha256}\n`);

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("usage: generate-nix-package.mjs --target <id> --artifact <path> --output <path>");
    }
    parsed[flag.slice(2)] = value;
  }
  for (const required of ["target", "artifact", "output"]) assert.ok(parsed[required]);
  return parsed;
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8"));
}

function writeJson(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}
