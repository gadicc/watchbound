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

  for (const manifest of [root, wrapper, native]) {
    assert.equal(manifest.private, true);
    assert.equal(manifest.version, "0.2.0");
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
    "workspace:0.2.0",
  );
  assert.equal(root.scripts["build:node"], "node scripts/build-node.mjs");
  assert.deepEqual(root.workspaces, ["js", "node"]);
  assert.equal(
    root.scripts["test:packages"],
    "pnpm package:prepare && pnpm package:check",
  );
  for (const crate of ["engine/Cargo.toml", "node/Cargo.toml"]) {
    const source = fs.readFileSync(path.join(workspaceRoot, crate), "utf8");
    assert.match(source, /^publish = false$/mu);
  }
});

test("release publishing stays explicit, OIDC-scoped, and tag-locked", () => {
  const release = fs.readFileSync(
    path.join(workspaceRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  assert.match(release, /^  release:\n    types: \[published\]$/mu);
  assert.match(release, /^    if: github\.event_name == 'release'$/mu);
  assert.match(release, /^    environment: release$/mu);
  assert.match(release, /^      id-token: write$/mu);
  assert.match(release, /pnpm check:release-tag/u);
  assert.match(release, /pnpm check:reproducible/u);
  assert.match(release, /dist\/evidence\/SHA256SUMS/u);
  assert.match(release, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.match(release, /actions\/download-artifact@[0-9a-f]{40}/u);
  assert.match(release, /sha256sum --check/u);
  assert.match(release, /gh release upload/u);
  assert.match(release, /NPM_BOOTSTRAP_TOKEN/u);
  assert.match(release, /npm publish/u);
  assert.match(release, /deno publish/u);
  assert.doesNotMatch(release, /push:\s*\n\s*branches:/u);
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
