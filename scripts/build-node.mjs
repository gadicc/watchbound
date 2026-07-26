import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadNativeMatrix,
  nativeArtifactEntries,
  targetForRuntime,
} from "./lib/native-matrix.mjs";

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
const target = targetForRuntime(matrix, process.platform, process.arch);

const build = spawnSync("pnpm", ["--dir", "node", "build"], {
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
