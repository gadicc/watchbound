import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeMatrix } from "./lib/native-matrix.mjs";
import { verifyReleaseCandidate } from "./lib/release-version.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseOptions(process.argv.slice(2));
const inputRoot = path.resolve(workspaceRoot, options.input);
const outputRoot = path.resolve(workspaceRoot, options.output);
const matrix = loadNativeMatrix(workspaceRoot);
const version = readJson(path.join(workspaceRoot, "package.json")).version;
const sourceSha = captureGitHead();
const candidate = verifyReleaseCandidate(workspaceRoot, { sourceSha, version });

fs.mkdirSync(outputRoot, { recursive: true });
const targets = matrix.targets.map((target) => {
  const targetRoot = path.join(inputRoot, target.id);
  const comparison = readJson(
    path.join(targetRoot, "independent-reproducibility.json"),
  );
  const binaryPath = path.join(targetRoot, target.binary);
  const binary = fs.readFileSync(binaryPath);
  const observedSha256 = crypto.createHash("sha256").update(binary).digest("hex");
  assert.equal(comparison.schemaVersion, 2);
  assert.equal(comparison.kind, "watchbound-independent-native-comparison");
  assert.equal(comparison.sourceSha, sourceSha);
  assert.equal(comparison.version, version);
  assert.deepEqual(comparison.candidate, candidate);
  assert.equal(comparison.targetId, target.id);
  assert.equal(comparison.target, target.rustTarget);
  assert.equal(comparison.sha256, observedSha256);
  assert.equal(comparison.bytes, binary.length);
  assert.equal(comparison.byteIdentical, true);
  fs.copyFileSync(binaryPath, path.join(outputRoot, target.binary));
  return {
    target: target.id,
    targetTriple: target.rustTarget,
    architecture: target.architecture,
    filename: target.binary,
    sha256: observedSha256,
    bytes: binary.length,
    byteIdentical: true,
    builders: comparison.builders,
  };
});

const aggregate = {
  schemaVersion: 2,
  kind: "watchbound-independent-native-matrix-comparison",
  sourceSha,
  version,
  candidate,
  targets,
};
const outputPath = path.join(outputRoot, "independent-reproducibility.json");
fs.writeFileSync(outputPath, `${JSON.stringify(aggregate, null, 2)}\n`);
if (options["github-output"]) {
  fs.appendFileSync(
    path.resolve(workspaceRoot, options["github-output"]),
    `native-matrix=${JSON.stringify(targets.map(({ target, sha256 }) => ({ target, sha256 })))}\n`,
  );
}
process.stdout.write(`Aggregated ${targets.length} independently reproduced native targets\n`);

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: aggregate-native-builds.mjs --input <directory> --output <directory> [--github-output <path>]",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  assert.ok(parsed.input, "--input is required");
  assert.ok(parsed.output, "--output is required");
  return parsed;
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function captureGitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
