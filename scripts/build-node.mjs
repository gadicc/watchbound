import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadNativeMatrix,
  nativeArtifactEntries,
  targetForId,
  targetForRuntime,
} from "./lib/native-matrix.mjs";
import { validateNativeArtifact } from "./lib/native-artifact.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ownedFiles = ["node/index.js", "node/index.d.ts", "node/load-native.cjs"];
const before = new Map(ownedFiles.map((relativePath) => [
  relativePath,
  fs.readFileSync(path.join(workspaceRoot, relativePath)),
]));
const matrix = loadNativeMatrix(workspaceRoot);
const options = parseOptions(process.argv.slice(2));
const target = options.target
  ? targetForId(matrix, options.target)
  : targetForRuntime(matrix, process.platform, process.arch);
const rootVersion = JSON.parse(
  fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
).version;

const buildArguments = [
  "--dir",
  "node",
  "exec",
  "napi",
  "build",
  "--platform",
  "--release",
  "--output-dir",
  ".",
  "--no-js",
  "--dts",
  "native.generated.d.ts",
];
if (options.target) buildArguments.push("--target", target.rustTarget);
const build = spawnSync("pnpm", buildArguments, {
  cwd: workspaceRoot,
  stdio: "inherit",
});
if (build.error !== undefined) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

for (const [relativePath, original] of before) {
  const current = fs.readFileSync(path.join(workspaceRoot, relativePath));
  if (!current.equals(original)) {
    throw new Error(`native build modified hand-owned file: ${relativePath}`);
  }
}

const nativePath = path.join(workspaceRoot, "node", target.binary);
if (!fs.existsSync(nativePath)) {
  throw new Error(`native build did not produce ${target.binary}`);
}
const nativeFiles = nativeArtifactEntries(workspaceRoot);
if (nativeFiles.length !== 1 || nativeFiles[0] !== target.binary) {
  throw new Error(`native build produced unexpected artifacts: ${nativeFiles.join(", ")}`);
}

validateNativeArtifact(nativePath, target, { version: rootVersion });
if (target.platform === process.platform && target.architecture === process.arch) {
  const require = createRequire(import.meta.url);
  const binding = require(path.join(workspaceRoot, "node/index.js"));
  const metadata = binding.bindingMetadata();
  if (metadata.buildProfile !== "release") {
    throw new Error("native build did not load as a release-profile addon");
  }
  if (metadata.targetTriple !== target.rustTarget) {
    throw new Error(
      `native build target mismatch: expected ${target.rustTarget}, got ${metadata.targetTriple}`,
    );
  }
}

function parseOptions(args) {
  if (args.length === 0) return {};
  if (args.length !== 2 || args[0] !== "--target" || !args[1]) {
    throw new Error("usage: build-node.mjs [--target <native-target-id>]");
  }
  return { target: args[1] };
}
