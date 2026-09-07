import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readQualifiedNativeStack } from "./lib/qualified-native-stack.mjs";
import { loadNativeMatrix, targetForRuntime } from "./lib/native-matrix.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(workspaceRoot, "dist");
const tarballRoot = path.join(distRoot, "tarballs");
const manifest = readJson(path.join(distRoot, "native-package-manifest.json"));
const baseline = readQualifiedNativeStack(workspaceRoot);
const matrix = loadNativeMatrix(workspaceRoot);
const currentTarget = targetForRuntime(matrix, process.platform, process.arch);
const qualifiedTarget = baseline.targets.find(({ id }) => id === currentTarget.id);
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-wrapper-release-"));

assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.releaseClass, "wrapper");
assert.equal(manifest.wrapperVersion, readJson(path.join(workspaceRoot, "package.json")).version);
assert.equal(manifest.nativeStackVersion, baseline.version);
assert.equal(manifest.loader, null);
assert.deepEqual(manifest.targets, []);
assert.ok(qualifiedTarget, `qualified native stack omits ${currentTarget.id}`);
assert.equal(
  readJson(path.join(distRoot, manifest.wrapper.root, "package.json"))
    .dependencies?.["@gadicc/watchbound-node"],
  baseline.version,
);
assert.equal(
  readJson(path.join(distRoot, "jsr", "package.json"))
    .dependencies?.["@gadicc/watchbound-node"],
  baseline.version,
);
assert.equal(fs.existsSync(path.join(distRoot, "npm", "node")), false);
assert.equal(fs.existsSync(path.join(distRoot, "npm", "targets")), false);

fs.rmSync(tarballRoot, { recursive: true, force: true });
fs.mkdirSync(tarballRoot, { recursive: true });

try {
  const wrapper = packWrapper();
  writeJson(path.join(smokeRoot, "package.json"), { private: true, type: "module" });
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    wrapper.tarball,
  ], smokeRoot);
  runInstalledSmoke(smokeRoot, "watchbound", "wrapper-npm-candidate");

  const jsrRoot = path.join(distRoot, "jsr");
  run("npm", [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    "--no-save",
    `${baseline.loader.name}@${baseline.version}`,
    `${qualifiedTarget.name}@${baseline.version}`,
  ], jsrRoot);
  run("deno", ["publish", "--dry-run", "--allow-dirty", "--no-check"], jsrRoot);
  runInstalledSmoke(jsrRoot, "@gadicc/watchbound", "wrapper-jsr-candidate", jsrRoot);
  fs.rmSync(path.join(jsrRoot, "node_modules"), { recursive: true, force: true });
  generateEvidence(wrapper.tarball);
} finally {
  fs.rmSync(smokeRoot, { recursive: true, force: true });
}

process.stdout.write(
  `Validated wrapper ${manifest.wrapperVersion} against qualified native stack ${manifest.nativeStackVersion}\n`,
);

function packWrapper() {
  const cwd = path.join(distRoot, manifest.wrapper.root);
  const result = run(
    "npm",
    ["pack", "--json", "--pack-destination", tarballRoot],
    cwd,
    true,
  );
  const [packed] = JSON.parse(result.stdout);
  assert.equal(packed.name, "watchbound");
  assert.equal(packed.version, manifest.wrapperVersion);
  assert.deepEqual(
    packed.files.map(({ path: file }) => file).sort(),
    [
      "LICENSE.txt",
      "README.md",
      "automatic-reconciliation.js",
      "capabilities.js",
      "errors.js",
      "index.d.ts",
      "index.js",
      "native-establishment.js",
      "observed-state.js",
      "package.json",
      "path-delivery.js",
    ].sort(),
  );
  return {
    tarball: path.join(tarballRoot, packed.filename),
    integrity: packed.integrity,
  };
}

function runInstalledSmoke(project, wrapper, route, wrapperPath) {
  const args = [
    path.join(workspaceRoot, "scripts", "check-installed-package.mjs"),
    "--project",
    project,
    "--wrapper",
    wrapper,
    "--version",
    manifest.wrapperVersion,
    "--native-stack-version",
    baseline.version,
    "--native-target",
    currentTarget.id,
    "--native-sha256",
    qualifiedTarget.nativeSha256,
    "--route",
    route,
    "--evidence",
    path.join(smokeRoot, `${route}.json`),
  ];
  if (wrapperPath) args.push("--wrapper-path", wrapperPath);
  run(process.execPath, args, workspaceRoot);
}

function generateEvidence(wrapperTarball) {
  const evidenceRoot = path.join(distRoot, "evidence");
  fs.rmSync(evidenceRoot, { recursive: true, force: true });
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const artifact = {
    path: path.relative(workspaceRoot, wrapperTarball),
    bytes: fs.statSync(wrapperTarball).size,
    sha256: sha256(wrapperTarball),
  };
  fs.writeFileSync(
    path.join(evidenceRoot, "SHA256SUMS"),
    `${artifact.sha256}  ${path.basename(artifact.path)}\n`,
  );
  const sourceSha = capture("git", ["rev-parse", "HEAD"]);
  writeJson(path.join(evidenceRoot, "release-metadata.json"), {
    schemaVersion: 3,
    package: "watchbound",
    releaseClass: "wrapper",
    wrapperVersion: manifest.wrapperVersion,
    nativeStackVersion: manifest.nativeStackVersion,
    commit: sourceSha,
    qualifiedNativeStack: {
      descriptorSha256: sha256(path.join(workspaceRoot, "config", "qualified-native-stack.json")),
      sourceSha: baseline.sourceSha,
      qualification: baseline.qualification,
      evidence: baseline.evidence,
      targets: baseline.targets.map(({ id, name, nativeSha256 }) => ({
        id,
        name,
        nativeSha256,
      })),
    },
    artifacts: [artifact],
    tools: {
      deno: toolVersion("deno", ["--version"]),
      node: toolVersion("node", ["--version"]),
      npm: toolVersion("npm", ["--version"]),
      pnpm: toolVersion("pnpm", ["--version"]),
    },
  });
  writeJson(
    path.join(evidenceRoot, `watchbound-${manifest.wrapperVersion}.cdx.json`),
    {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      version: 1,
      metadata: {
        component: {
          type: "library",
          "bom-ref": `pkg:npm/watchbound@${manifest.wrapperVersion}`,
          name: "watchbound",
          version: manifest.wrapperVersion,
          purl: `pkg:npm/watchbound@${manifest.wrapperVersion}`,
        },
        properties: [
          { name: "watchbound:release-class", value: "wrapper" },
          { name: "watchbound:native-stack-version", value: manifest.nativeStackVersion },
        ],
      },
      components: [
        {
          type: "library",
          "bom-ref": `pkg:npm/%40gadicc/watchbound-node@${manifest.nativeStackVersion}`,
          group: "@gadicc",
          name: "watchbound-node",
          version: manifest.nativeStackVersion,
          purl: `pkg:npm/%40gadicc/watchbound-node@${manifest.nativeStackVersion}`,
        },
        ...baseline.targets.map((target) => ({
          type: "library",
          "bom-ref": npmPurl(target.name, manifest.nativeStackVersion),
          group: "@gadicc",
          name: target.name.split("/").at(-1),
          version: manifest.nativeStackVersion,
          purl: npmPurl(target.name, manifest.nativeStackVersion),
          hashes: [{ alg: "SHA-256", content: target.nativeSha256 }],
        })),
      ],
      dependencies: [
        {
          ref: `pkg:npm/watchbound@${manifest.wrapperVersion}`,
          dependsOn: [`pkg:npm/%40gadicc/watchbound-node@${manifest.nativeStackVersion}`],
        },
        {
          ref: `pkg:npm/%40gadicc/watchbound-node@${manifest.nativeStackVersion}`,
          dependsOn: baseline.targets.map((target) =>
            npmPurl(target.name, manifest.nativeStackVersion)),
        },
      ],
    },
  );
}

function npmPurl(name, version) {
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function toolVersion(command, args) {
  return capture(command, args).split(/\r?\n/u, 1)[0];
}

function sha256(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}

function capture(command, args) {
  return run(command, args, workspaceRoot, true).stdout.trim();
}

function run(command, args, cwd, captureOutput = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: captureOutput ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (captureOutput) {
      process.stderr.write(result.stderr);
      process.stderr.write(result.stdout);
    }
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result;
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function writeJson(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}
