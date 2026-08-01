import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const distRoot = path.join(workspaceRoot, "dist");
const tarballRoot = path.join(distRoot, "tarballs");
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-packages-"));
const version = readJson(path.join(workspaceRoot, "package.json")).version;
const packageManifest = readJson(path.join(distRoot, "native-package-manifest.json"));
const matrix = readJson(path.join(workspaceRoot, "config", "native-matrix.json"));
const currentTarget = matrix.targets.find((target) =>
  target.platform === process.platform && target.architecture === process.arch);
assert.ok(currentTarget, `no package smoke target for ${process.platform}/${process.arch}`);

fs.rmSync(tarballRoot, { recursive: true, force: true });
fs.mkdirSync(tarballRoot, { recursive: true });

try {
  const loader = packAndCheck(packageManifest.loader.root, [
    "LICENSE.txt",
    "README.md",
    "index.d.ts",
    "index.js",
    "load-native.cjs",
    "native-matrix.json",
    "package.json",
  ]);
  const targets = packageManifest.targets.map((target) => ({
    ...target,
    ...packAndCheck(target.root, [
      "LICENSE.txt",
      "README.md",
      "package.json",
      target.binary,
    ]),
  }));
  const currentTargetPackage = targets.find(({ id }) => id === currentTarget.id);
  assert.ok(currentTargetPackage, `prepared packages omit current target ${currentTarget.id}`);
  const wrapper = packAndCheck(packageManifest.wrapper.root, [
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
  ]);

  writeJson(path.join(smokeRoot, "package.json"), { private: true, type: "module" });
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      currentTargetPackage.tarball,
      loader.tarball,
      wrapper.tarball,
    ],
    smokeRoot,
  );
  run(
    "node",
    [
      "--input-type=module",
      "--eval",
      [
        "import assert from 'node:assert/strict';",
        "import { capabilities } from 'watchbound';",
        `assert.equal(capabilities.versions.wrapper, ${JSON.stringify(version)});`,
        "assert.equal(capabilities.schemaVersion, 5);",
        `assert.equal(capabilities.build.packagedTarget.id, ${JSON.stringify(currentTarget.id)});`,
        "assert.equal(capabilities.build.delivery, 'bundled-native-package');",
        "assert.equal(capabilities.build.prebuilt, true);",
        "assert.equal(capabilities.support.delivery, 'bundled-native-package');",
      ].join(" "),
    ],
    smokeRoot,
  );
  const nativeSha256 = sha256(
    path.join(distRoot, currentTargetPackage.root, currentTarget.binary),
  );
  assert.equal(nativeSha256, currentTargetPackage.sha256);
  runInstalledSmoke(smokeRoot, "watchbound", nativeSha256, currentTarget.id, "local-npm-tarballs");

  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--no-package-lock",
      "--no-save",
      "--offline",
      currentTargetPackage.tarball,
      loader.tarball,
    ],
    path.join(distRoot, "jsr"),
  );
  run(
    "deno",
    ["publish", "--dry-run", "--allow-dirty", "--no-check"],
    path.join(distRoot, "jsr"),
  );
  runInstalledSmoke(
    path.join(distRoot, "jsr"),
    "@gadicc/watchbound",
    nativeSha256,
    currentTarget.id,
    "local-jsr-node-tree",
    path.join(distRoot, "jsr"),
  );
  const jsrManifestPath = path.join(distRoot, "jsr", "package.json");
  const preparedJsrManifest = readJson(jsrManifestPath);
  writeJson(jsrManifestPath, {
    name: "@jsr/gadicc__watchbound",
    version,
    type: "module",
    dependencies: { "@gadicc/watchbound-node": version },
    exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
  });
  runInstalledSmoke(
    path.join(distRoot, "jsr"),
    "@gadicc/watchbound",
    nativeSha256,
    currentTarget.id,
    "local-jsr-npm-compatibility-tree",
    path.join(distRoot, "jsr"),
  );
  writeJson(jsrManifestPath, preparedJsrManifest);
  fs.rmSync(path.join(distRoot, "jsr", "node_modules"), {
    recursive: true,
    force: true,
  });
  run("node", ["scripts/generate-release-evidence.mjs"], workspaceRoot);
} finally {
  fs.rmSync(smokeRoot, { recursive: true, force: true });
}

process.stdout.write(
  `Validated target-aware npm tarballs, installed package smoke, JSR dry run, and release evidence for ${version}\n`,
);

function runInstalledSmoke(project, wrapper, nativeSha256, targetId, route, wrapperPath) {
  const args = [
    path.join(workspaceRoot, "scripts/check-installed-package.mjs"),
    "--project",
    project,
    "--wrapper",
    wrapper,
    "--version",
    version,
    "--native-target",
    targetId,
    "--native-sha256",
    nativeSha256,
    "--route",
    route,
    "--evidence",
    path.join(smokeRoot, `${route}.json`),
  ];
  if (wrapperPath) args.push("--wrapper-path", wrapperPath);
  run(process.execPath, args, workspaceRoot);
}

function packAndCheck(relativeDirectory, expectedFiles) {
  const cwd = path.join(distRoot, relativeDirectory);
  const result = run(
    "npm",
    ["pack", "--json", "--pack-destination", tarballRoot],
    cwd,
    true,
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.length, 1);
  const [packed] = report;
  assert.equal(packed.version, version);
  assert.deepEqual(
    packed.files.map(({ path: file }) => file).sort(),
    [...expectedFiles].sort(),
  );
  return { tarball: path.join(tarballRoot, packed.filename), name: packed.name };
}

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stderr);
      process.stderr.write(result.stdout);
    }
    process.exit(result.status ?? 1);
  }
  return result;
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function writeJson(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}
