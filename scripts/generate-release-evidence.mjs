import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const rootPackage = readJson(path.join(workspaceRoot, "package.json"));
const version = rootPackage.version;
const binaryPath = path.join(
  workspaceRoot,
  "dist",
  "npm",
  "node",
  "watchbound.linux-x64-gnu.node",
);
const tarballRoot = path.join(workspaceRoot, "dist", "tarballs");
const evidenceRoot = path.join(workspaceRoot, "dist", "evidence");
const expectedTarballs = [
  `gadicc-watchbound-node-${version}.tgz`,
  `watchbound-${version}.tgz`,
].map((filename) => path.join(tarballRoot, filename));

assert.ok(fs.existsSync(binaryPath), `missing native artifact: ${binaryPath}`);
for (const tarball of expectedTarballs) {
  assert.ok(fs.existsSync(tarball), `missing release tarball: ${tarball}`);
}

const fileReport = capture("file", ["--brief", binaryPath]);
assert.match(fileReport, /\bELF 64-bit LSB shared object\b/);
assert.match(fileReport, /\bx86-64\b/);
assert.match(fileReport, /\bstripped\b/);

const dynamicReport = capture("readelf", ["--dynamic", binaryPath]);
const neededLibraries = [
  ...dynamicReport.matchAll(/\(NEEDED\).*Shared library: \[([^\]]+)\]/g),
].map((match) => match[1]);
assert.deepEqual(
  [...neededLibraries].sort(),
  ["ld-linux-x86-64.so.2", "libc.so.6", "libgcc_s.so.1"].sort(),
  "native artifact has an unexpected dynamic-library dependency",
);
assert.doesNotMatch(
  dynamicReport,
  /\((?:RPATH|RUNPATH)\)/,
  "native artifact must not contain RPATH or RUNPATH",
);

const symbolReport = capture("readelf", ["--wide", "--dyn-syms", binaryPath]);
assert.match(
  symbolReport,
  /\bnapi_register_module_v1\b/,
  "native artifact does not export the expected Node-API registration symbol",
);

const binarySize = fs.statSync(binaryPath).size;
assert.ok(binarySize > 0 && binarySize <= 8 * 1024 * 1024);

fs.rmSync(evidenceRoot, { recursive: true, force: true });
fs.mkdirSync(evidenceRoot, { recursive: true });

const independentReproducibility = readOptionalEvidence(
  process.env.WATCHBOUND_INDEPENDENT_REPRODUCIBILITY,
  "watchbound-independent-native-comparison",
);
const sameRunnerReproducibility = readOptionalEvidence(
  process.env.WATCHBOUND_REPRODUCIBLE_OUTPUT,
  "watchbound-same-runner-reproducibility",
);

const artifacts = [
  {
    path: path.relative(workspaceRoot, binaryPath),
    mediaType: "application/vnd.node.node-api",
  },
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
    .map(
      ({ path: artifactPath, sha256: digest }) =>
        `${digest}  ${path.basename(artifactPath)}`,
    )
    .sort()
    .join("\n")}\n`,
);

const cargoMetadata = JSON.parse(
  capture("cargo", ["metadata", "--format-version", "1", "--locked"]),
);
const commit = capture("git", ["rev-parse", "HEAD"]);
if (independentReproducibility !== null) {
  assert.equal(independentReproducibility.sourceSha, commit);
  assert.equal(independentReproducibility.version, version);
  assert.equal(
    independentReproducibility.sha256,
    artifacts.find(({ path: artifactPath }) =>
      artifactPath.endsWith(".node"))?.sha256,
  );
  fs.copyFileSync(
    path.resolve(process.env.WATCHBOUND_INDEPENDENT_REPRODUCIBILITY),
    path.join(evidenceRoot, "independent-reproducibility.json"),
  );
}
if (sameRunnerReproducibility !== null) {
  const expectedNativeSha256 =
    independentReproducibility?.sha256 ??
    sameRunnerReproducibility.builds?.[0]?.sha256;
  assert.equal(sameRunnerReproducibility.sourceSha, commit);
  assert.equal(sameRunnerReproducibility.version, version);
  assert.equal(sameRunnerReproducibility.byteIdentical, true);
  assert.equal(sameRunnerReproducibility.builds?.length, 2);
  assert.equal(sameRunnerReproducibility.builds[0].sha256, expectedNativeSha256);
  assert.equal(sameRunnerReproducibility.builds[1].sha256, expectedNativeSha256);
  assert.equal(
    sameRunnerReproducibility.expectedSha256,
    independentReproducibility?.sha256 ?? null,
  );
  fs.copyFileSync(
    path.resolve(process.env.WATCHBOUND_REPRODUCIBLE_OUTPUT),
    path.join(evidenceRoot, "same-runner-reproducibility.json"),
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
  schemaVersion: 1,
  package: "watchbound",
  version,
  commit,
  target: "x86_64-unknown-linux-gnu",
  delivery: "bundled-native-package",
  nativeInspection: {
    file: fileReport,
    neededLibraries,
    exports: ["napi_register_module_v1"],
    maximumBytes: 8 * 1024 * 1024,
  },
  reproducibility: {
    level: independentReproducibility !== null
      ? "two-independent-clean-builders"
      : sameRunnerReproducibility !== null
        ? "same-runner-two-clean-builds"
        : "not-checked",
    independent: independentReproducibility === null
      ? null
      : {
          sourceSha: independentReproducibility.sourceSha,
          sha256: independentReproducibility.sha256,
          bytes: independentReproducibility.bytes,
          builders: independentReproducibility.builders.map(
            ({ builder, runner }) => ({ builder, runner }),
          ),
        },
    sameRunner: sameRunnerReproducibility,
  },
  tools,
  artifacts,
});

writeJson(
  path.join(evidenceRoot, `watchbound-${version}.cdx.json`),
  createCycloneDx(cargoMetadata, tools, artifacts),
);

process.stdout.write(
  `Inspected native artifact and wrote release evidence for ${version}\n`,
);

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
  const cargoRefs = new Map(
    cargoMetadata.packages.map((pkg) => [pkg.id, cargoPurl(pkg)]),
  );
  const nativeRef = `pkg:npm/%40gadicc/watchbound-node@${version}`;
  const wrapperRef = `pkg:npm/watchbound@${version}`;
  const nativeCargo = cargoMetadata.packages.find(
    (pkg) => pkg.name === "watchbound-node" && pkg.version === version,
  );
  assert.ok(nativeCargo, "Cargo metadata is missing watchbound-node");

  const dependencies = cargoMetadata.resolve.nodes
    .map((node) => ({
      ref: cargoRefs.get(node.id),
      dependsOn: node.dependencies.map((id) => cargoRefs.get(id)).sort(),
    }))
    .filter(({ ref }) => ref)
    .sort((a, b) => a.ref.localeCompare(b.ref));
  dependencies.unshift({
    ref: nativeRef,
    dependsOn: [cargoPurl(nativeCargo)],
  });
  dependencies.unshift({ ref: wrapperRef, dependsOn: [nativeRef] });

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "library",
        "bom-ref": wrapperRef,
        name: "watchbound",
        version,
        purl: wrapperRef,
      },
      tools: {
        components: Object.entries(tools).map(([name, toolVersionValue]) => ({
          type: "application",
          name,
          version: toolVersionValue,
        })),
      },
      properties: [
        { name: "watchbound:delivery", value: "bundled-native-package" },
        {
          name: "watchbound:target",
          value: "x86_64-unknown-linux-gnu",
        },
      ],
    },
    components: [
      {
        type: "library",
        "bom-ref": nativeRef,
        group: "@gadicc",
        name: "watchbound-node",
        version,
        purl: nativeRef,
        hashes: artifacts
          .filter(({ path: artifactPath }) => artifactPath.endsWith(".node"))
          .map(({ sha256: digest }) => ({ alg: "SHA-256", content: digest })),
      },
      ...cargoComponents,
    ],
    dependencies,
  };
}

function cargoPurl(pkg) {
  return `pkg:cargo/${encodeURIComponent(pkg.name)}@${encodeURIComponent(pkg.version)}`;
}

function sha256(source) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(source))
    .digest("hex");
}

function toolVersion(command, args) {
  return capture(command, args).split(/\r?\n/, 1)[0];
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
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
