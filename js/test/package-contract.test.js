import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8"));
}

test("private package manifests match the narrow maintained source-build target", () => {
  const root = readJson("package.json");
  const wrapper = readJson("js/package.json");
  const native = readJson("node/package.json");
  const { version } = root;
  assert.equal(version, "1.0.0");

  assert.equal(wrapper.name, "watchbound");
  assert.equal(native.name, "@gadicc/watchbound-node");
  for (const manifest of [root, wrapper, native]) {
    assert.equal(manifest.private, true);
    assert.equal(manifest.version, version);
    assert.equal(manifest.license, "MIT");
    assert.equal(manifest.author, "Gadi Cohen <dragon@wastelands.net>");
    assert.match(manifest.repository.url, /github\.com\/gadicc\/watchbound/u);
    assert.deepEqual(manifest.engines, { node: ">=24.18.0 <25" });
    assert.equal(manifest.scripts?.preinstall, undefined);
    assert.equal(manifest.scripts?.install, undefined);
    assert.equal(manifest.scripts?.postinstall, undefined);
    assert.equal(manifest.optionalDependencies, undefined);
  }

  for (const manifest of [wrapper, native]) {
    assert.deepEqual(manifest.os, ["linux"]);
    assert.deepEqual(manifest.cpu, ["x64"]);
    assert.deepEqual(manifest.libc, ["glibc"]);
    assert.deepEqual(manifest.watchbound, {
      delivery: "controlled-source-build",
    });
  }

  assert.deepEqual(native.exports, {
    ".": {
      types: "./index.d.ts",
      require: "./index.js",
      import: "./index.js",
      default: "./index.js",
    },
  });
  assert.equal(
    wrapper.dependencies["@gadicc/watchbound-node"],
    `workspace:${version}`,
  );
  assert.equal(root.scripts["build:node"], "node scripts/build-node.mjs");
  assert.deepEqual(root.workspaces, ["js", "node"]);
  assert.equal(
    root.scripts["test:packages"],
    "pnpm package:prepare && pnpm package:check",
  );
  assert.equal(
    root.scripts["test:baseline"],
    "node scripts/run-local-baseline.mjs",
  );
  assert.equal(
    root.scripts["check:registry-packages"],
    "node scripts/check-registry-packages.mjs",
  );
  assert.equal(root.scripts.release, "semantic-release");
  assert.equal(root.devDependencies["semantic-release"], "25.0.8");
  for (const crate of ["engine/Cargo.toml", "node/Cargo.toml"]) {
    const source = fs.readFileSync(path.join(workspaceRoot, crate), "utf8");
    assert.match(source, /^publish = false$/mu);
  }
});

test("semantic release stays main-only, OIDC-scoped, and version-aware", () => {
  const release = fs.readFileSync(
    path.join(workspaceRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  const ci = fs.readFileSync(
    path.join(workspaceRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  const config = fs.readFileSync(
    path.join(workspaceRoot, "release.config.mjs"),
    "utf8",
  );
  const plugin = fs.readFileSync(
    path.join(workspaceRoot, "scripts/semantic-release-watchbound.mjs"),
    "utf8",
  );
  const recordNativeBuild = fs.readFileSync(
    path.join(workspaceRoot, "scripts/record-native-build.mjs"),
    "utf8",
  );
  const compareNativeBuilds = fs.readFileSync(
    path.join(workspaceRoot, "scripts/compare-native-builds.mjs"),
    "utf8",
  );
  assert.match(release, /^  push:\n    branches: \[main\]$/mu);
  assert.match(
    release,
    /^  plan:\n    name: Plan exact candidate\n    runs-on: ubuntu-24\.04\n    timeout-minutes: 15\n    permissions:\n      # semantic-release verifies push access even when dryRun is enabled\.\n      contents: write$/mu,
  );
  assert.match(release, /github\.event_name == 'push'/u);
  assert.match(release, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(release, /needs\.plan\.outputs\.will-release == 'true'/u);
  assert.doesNotMatch(release, /^    environment:/mu);
  assert.match(release, /^      id-token: write$/mu);
  assert.match(release, /^          fetch-depth: 0$/mu);
  assert.match(release, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/u);
  assert.match(release, /run: pnpm release/u);
  assert.match(release, /^  repro-build:$/mu);
  assert.match(release, /^  repro-compare:$/mu);
  assert.match(release, /^  registry-smoke:$/mu);
  assert.match(release, /compare-native-builds\.mjs/u);
  assert.match(release, /check-registry-packages\.mjs/u);
  assert.match(release, /WATCHBOUND_EXPECTED_NATIVE_SHA256/u);
  assert.match(release, /watchbound-approved-native/u);
  assert.equal(
    release.match(
      /echo "RUSTFLAGS=--remap-path-prefix=\$cargo_home=\/watchbound\/cargo-home" >> "\$GITHUB_ENV"/gu,
    )?.length,
    2,
  );
  assert.doesNotMatch(release, /NPM_BOOTSTRAP_TOKEN/u);
  assert.doesNotMatch(release, /workflow_dispatch/u);
  assert.doesNotMatch(ci, /workflow_dispatch/u);
  assert.match(ci, /^  push:\n    branches-ignore: \[main\]$/mu);

  assert.match(config, /branches: \["main"\]/u);
  assert.match(config, /@semantic-release\/commit-analyzer/u);
  assert.match(config, /@semantic-release\/release-notes-generator/u);
  assert.match(config, /semantic-release-watchbound\.mjs/u);
  assert.match(config, /@semantic-release\/github/u);
  assert.match(config, /dist\/evidence\/SHA256SUMS/u);

  assert.match(plugin, /scripts\/set-release-version\.mjs/u);
  assert.match(plugin, /pnpm", \["check:reproducible"\]/u);
  assert.match(plugin, /pnpm", \["test:packages"\]/u);
  assert.match(plugin, /installCanonicalNative/u);
  assert.match(plugin, /registry integrity mismatch/u);
  assert.match(plugin, /publication-ledger\.json/u);
  assert.match(plugin, /npm", \["view"/u);
  assert.match(plugin, /deno", \["info"/u);
  assert.match(plugin, /"publish"/u);
  assert.match(plugin, /"--provenance"/u);
  assert.doesNotMatch(plugin, /NPM_TOKEN|NODE_AUTH_TOKEN/u);
  assert.match(
    recordNativeBuild,
    /rustFlags: requiredEnvironment\("RUSTFLAGS"\)/u,
  );
  assert.match(
    compareNativeBuilds,
    /--remap-path-prefix=\$\{manifest\.isolation\.cargoHome\}=\/watchbound\/cargo-home/u,
  );
});

test("the wrapper resolves the native package boundary and asserts lockstep versions", () => {
  const source = fs.readFileSync(path.join(workspaceRoot, "js/index.js"), "utf8");
  assert.match(source, /from "@gadicc\/watchbound-node"/u);
  assert.doesNotMatch(source, /from "\.\.\/node\/index\.js"/u);
  assert.match(
    source,
    /nativeBinding\.assertWrapperVersion\(WRAPPER_VERSION, WRAPPER_DELIVERY\)/u,
  );
});
