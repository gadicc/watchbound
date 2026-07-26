import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadNativeMatrix } from "./lib/native-matrix.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const rootPackage = readJson(path.join(workspaceRoot, "package.json"));
const version = rootPackage.version;
const packageManifest = readJson(
  path.join(workspaceRoot, "dist", "native-package-manifest.json"),
);
const matrix = loadNativeMatrix(workspaceRoot);
const tarballRoot = path.join(workspaceRoot, "dist", "tarballs");
const evidenceRoot = path.join(workspaceRoot, "dist", "evidence");
const packageNames = [
  packageManifest.wrapper.name,
  packageManifest.loader.name,
  ...packageManifest.targets.map(({ name }) => name),
];
const expectedTarballs = packageNames.map((name) =>
  path.join(tarballRoot, npmTarballName(name, version)));
const nativeArtifacts = packageManifest.targets.map((packagedTarget) => {
  const target = matrix.targets.find(({ id }) => id === packagedTarget.id);
  assert.ok(target, `package manifest contains unknown target ${packagedTarget.id}`);
  const binaryPath = path.join(
    workspaceRoot,
    "dist",
    packagedTarget.root,
    packagedTarget.binary,
  );
  assert.ok(fs.existsSync(binaryPath), `missing native artifact: ${binaryPath}`);
  assert.equal(sha256(binaryPath), packagedTarget.sha256);
  return inspectNative(binaryPath, target);
});

for (const tarball of expectedTarballs) {
  assert.ok(fs.existsSync(tarball), `missing release tarball: ${tarball}`);
}

fs.rmSync(evidenceRoot, { recursive: true, force: true });
fs.mkdirSync(evidenceRoot, { recursive: true });

const artifacts = [
  ...nativeArtifacts.map(({ path: artifactPath }) => ({
    path: path.relative(workspaceRoot, artifactPath),
    mediaType: "application/vnd.node.node-api",
  })),
  ...expectedTarballs.map((artifactPath) => ({
    path: path.relative(workspaceRoot, artifactPath),
    mediaType: "application/gzip",
  })),
].map((artifact) => ({
  ...artifact,
  bytes: fs.statSync(path.join(workspaceRoot, artifact.path)).size,
  sha256: sha256(path.join(workspaceRoot, artifact.path)),
}));

fs.writeFileSync(
  path.join(evidenceRoot, "SHA256SUMS"),
  `${artifacts
    .map(({ path: artifactPath, sha256: digest }) =>
      `${digest}  ${path.basename(artifactPath)}`)
    .sort()
    .join("\n")}\n`,
);

const cargoMetadata = JSON.parse(
  capture("cargo", ["metadata", "--format-version", "1", "--locked"]),
);
const commit = capture("git", ["rev-parse", "HEAD"]);
const independentReproducibility = readOptionalEvidence(
  process.env.WATCHBOUND_INDEPENDENT_REPRODUCIBILITY,
  "watchbound-independent-native-matrix-comparison",
);
if (independentReproducibility !== null) {
  assert.equal(independentReproducibility.sourceSha, commit);
  assert.equal(independentReproducibility.version, version);
  for (const native of nativeArtifacts) {
    const compared = independentReproducibility.targets.find(
      ({ target }) => target === native.target,
    );
    assert.ok(compared, `independent comparison omits ${native.target}`);
    assert.equal(compared.sha256, sha256(native.path));
  }
  fs.copyFileSync(
    path.resolve(process.env.WATCHBOUND_INDEPENDENT_REPRODUCIBILITY),
    path.join(evidenceRoot, "independent-reproducibility.json"),
  );
}

const tools = {
  cargo: toolVersion("cargo", ["--version"]),
  deno: toolVersion("deno", ["--version"]),
  node: toolVersion("node", ["--version"]),
  npm: toolVersion("npm", ["--version"]),
  pnpm: toolVersion("pnpm", ["--version"]),
  rustc: toolVersion("rustc", ["--version"]),
};

writeJson(path.join(evidenceRoot, "release-metadata.json"), {
  schemaVersion: 2,
  package: "watchbound",
  version,
  commit,
  delivery: "target-native-packages",
  baseline: matrix.releaseBaseline,
  codexRuntime: matrix.codexRuntime,
  nativeInspection: nativeArtifacts.map((native) => ({
    target: native.target,
    package: native.package,
    file: native.file,
    neededLibraries: native.neededLibraries,
    glibcRequiredVersions: native.glibcRequiredVersions,
    maximumRequiredGlibc: native.maximumRequiredGlibc,
    nodeApi: native.nodeApi,
    strippedSymbols: native.strippedSymbols,
    maximumBytes: 8 * 1024 * 1024,
  })),
  reproducibility: {
    level: independentReproducibility === null
      ? "not-checked"
      : "two-independent-clean-builders-per-target",
    independent: independentReproducibility,
  },
  tools,
  artifacts,
});

writeJson(
  path.join(evidenceRoot, `watchbound-${version}.cdx.json`),
  createCycloneDx(cargoMetadata, tools, artifacts),
);

process.stdout.write(
  `Inspected ${nativeArtifacts.length} native target artifact(s) and wrote release evidence for ${version}\n`,
);

function inspectNative(binaryPath, target) {
  const fileReport = capture("file", ["--brief", binaryPath]);
  assert.match(fileReport, /\bELF 64-bit LSB shared object\b/u);
  assert.match(fileReport, new RegExp(`\\b${escapeRegExp(target.elf.fileMachineName)}\\b`, "u"));
  assert.match(fileReport, /\bstripped\b/u);

  const headerReport = capture("readelf", ["--file-header", binaryPath]);
  assert.match(headerReport, new RegExp(`Machine:\\s+${escapeRegExp(target.elf.machineName)}`, "u"));
  const dynamicReport = capture("readelf", ["--dynamic", binaryPath]);
  const neededLibraries = [
    ...dynamicReport.matchAll(/\(NEEDED\).*Shared library: \[([^\]]+)\]/gu),
  ].map((match) => match[1]).sort();
  assert.deepEqual(
    neededLibraries,
    [...target.elf.neededLibraries].sort(),
    `${target.id} has an unexpected dynamic-library dependency`,
  );
  assert.doesNotMatch(dynamicReport, /\((?:RPATH|RUNPATH)\)/u);

  const symbolReport = capture("readelf", ["--wide", "--dyn-syms", binaryPath]);
  const exportedNodeApiSymbols = [...symbolReport.matchAll(
    /\bGLOBAL\s+DEFAULT\s+\d+\s+((?:napi|node_api)_[A-Za-z0-9_]+)\b/gu,
  )].map((match) => match[1]).sort();
  const undefinedNodeApiSymbols = [...symbolReport.matchAll(
    /\bGLOBAL\s+DEFAULT\s+UND\s+((?:napi|node_api)_[A-Za-z0-9_]+)\b/gu,
  )].map((match) => match[1]).sort();
  assert.deepEqual(exportedNodeApiSymbols, ["napi_register_module_v1"]);
  assert.deepEqual(
    undefinedNodeApiSymbols,
    [],
    `${target.id} unexpectedly links Node-API symbols instead of napi-rs runtime lookup`,
  );
  const sectionReport = capture("readelf", ["--sections", "--wide", binaryPath]);
  assert.doesNotMatch(sectionReport, /\.(?:debug|symtab)\b/u);
  const versionReport = capture("readelf", ["--version-info", "--wide", binaryPath]);
  const glibcRequiredVersions = [...new Set(
    [...versionReport.matchAll(/\bGLIBC_(\d+\.\d+)\b/gu)].map((match) => match[1]),
  )].sort(compareVersions);
  const maximumRequiredGlibc = glibcRequiredVersions.at(-1) ?? null;
  assert.ok(maximumRequiredGlibc, `${target.id} has no auditable GLIBC requirements`);
  assert.ok(
    compareVersions(maximumRequiredGlibc, matrix.releaseBaseline.glibcMaximum) <= 0,
    `${target.id} requires GLIBC_${maximumRequiredGlibc}, above ${matrix.releaseBaseline.glibcMaximum}`,
  );
  const binarySize = fs.statSync(binaryPath).size;
  assert.ok(binarySize > 0 && binarySize <= 8 * 1024 * 1024);
  return {
    target: target.id,
    package: target.package,
    path: binaryPath,
    file: fileReport,
    neededLibraries,
    glibcRequiredVersions,
    maximumRequiredGlibc,
    nodeApi: {
      exportedSymbols: exportedNodeApiSymbols,
      undefinedSymbols: undefinedNodeApiSymbols,
      resolution: "napi-rs-runtime-lookup",
    },
    strippedSymbols: {
      fileReportsStripped: true,
      staticSymbolTablePresent: false,
      debugSectionsPresent: false,
    },
  };
}

function createCycloneDx(cargoMetadata, tools, artifacts) {
  const cargoComponents = cargoMetadata.packages
    .map((pkg) => ({
      type: "library",
      "bom-ref": cargoPurl(pkg),
      name: pkg.name,
      version: pkg.version,
      purl: cargoPurl(pkg),
      ...(pkg.license ? { licenses: [{ expression: pkg.license }] } : {}),
    }))
    .sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
  const cargoRefs = new Map(cargoMetadata.packages.map((pkg) => [pkg.id, cargoPurl(pkg)]));
  const wrapperRef = `pkg:npm/watchbound@${version}`;
  const loaderRef = `pkg:npm/%40gadicc/watchbound-node@${version}`;
  const nativeCargo = cargoMetadata.packages.find(
    (pkg) => pkg.name === "watchbound-node" && pkg.version === version,
  );
  assert.ok(nativeCargo, "Cargo metadata is missing watchbound-node");
  const targetRefs = packageManifest.targets.map(({ name }) => npmPurl(name, version));
  const dependencies = cargoMetadata.resolve.nodes
    .map((node) => ({
      ref: cargoRefs.get(node.id),
      dependsOn: node.dependencies.map((id) => cargoRefs.get(id)).sort(),
    }))
    .filter(({ ref }) => ref)
    .sort((a, b) => a.ref.localeCompare(b.ref));
  dependencies.unshift(...targetRefs.map((ref) => ({
    ref,
    dependsOn: [cargoPurl(nativeCargo)],
  })));
  dependencies.unshift({ ref: loaderRef, dependsOn: targetRefs });
  dependencies.unshift({ ref: wrapperRef, dependsOn: [loaderRef] });
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: { type: "library", "bom-ref": wrapperRef, name: "watchbound", version, purl: wrapperRef },
      tools: { components: Object.entries(tools).map(([name, value]) => ({ type: "application", name, version: value })) },
      properties: [
        { name: "watchbound:delivery", value: "target-native-packages" },
        { name: "watchbound:targets", value: packageManifest.targets.map(({ id }) => id).join(",") },
      ],
    },
    components: [
      {
        type: "library",
        "bom-ref": loaderRef,
        group: "@gadicc",
        name: "watchbound-node",
        version,
        purl: loaderRef,
      },
      ...packageManifest.targets.map((target) => ({
        type: "library",
        "bom-ref": npmPurl(target.name, version),
        group: "@gadicc",
        name: target.name.split("/").at(-1),
        version,
        purl: npmPurl(target.name, version),
        hashes: artifacts
          .filter(({ path: artifactPath }) => artifactPath.endsWith(target.binary))
          .map(({ sha256: digest }) => ({ alg: "SHA-256", content: digest })),
      })),
      ...cargoComponents,
    ],
    dependencies,
  };
}

function npmTarballName(name, packageVersion) {
  return `${name.replace(/^@/u, "").replaceAll("/", "-")}-${packageVersion}.tgz`;
}

function npmPurl(name, packageVersion) {
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(packageVersion)}`;
}

function cargoPurl(pkg) {
  return `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`;
}

function sha256(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function toolVersion(command, args) {
  return capture(command, args).split(/\r?\n/u, 1)[0];
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: workspaceRoot, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stderr.write(result.stdout);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function readOptionalEvidence(source, expectedKind) {
  if (!source) return null;
  const value = readJson(path.resolve(source));
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, expectedKind);
  return value;
}

function writeJson(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}
