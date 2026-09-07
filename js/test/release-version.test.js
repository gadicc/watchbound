import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SOURCE_VERSION,
  VERSION_FILES,
  assertCommittedSourceVersion,
  assertWorkspaceVersion,
  materializeReleaseCandidate,
  verifyReleaseCandidate,
} from "../../scripts/lib/release-version.mjs";
import {
  orderReleasePackages,
  preflightNpmNamespaces,
  publicationResumePlan,
  verifyExistingJsrPackage,
  verifyPublishPreconditions,
} from "../../scripts/semantic-release-watchbound.mjs";
import { createReleasePackagePlan } from "../../scripts/lib/release-package-plan.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("committed workspace versions are permanent development placeholders", () => {
  assert.equal(SOURCE_VERSION, "0.0.0-development");
  if (process.env.WATCHBOUND_CANDIDATE_VERSION) {
    assertCommittedSourceVersion(workspaceRoot);
    verifyReleaseCandidate(workspaceRoot, {
      sourceSha: process.env.WATCHBOUND_CANDIDATE_SHA,
      wrapperVersion: process.env.WATCHBOUND_CANDIDATE_VERSION,
      nativeStackVersion: process.env.WATCHBOUND_NATIVE_STACK_VERSION ??
        process.env.WATCHBOUND_CANDIDATE_VERSION,
      releaseClass: process.env.WATCHBOUND_RELEASE_CLASS ?? "native",
    });
  } else {
    assertWorkspaceVersion(workspaceRoot, SOURCE_VERSION);
  }
});

test("semantic-release publish preflight validates the exact generated candidate", async () => {
  const fixture = createFixture({ qualifyTargets: true });
  const version = "9.8.7";
  const previousPlannedVersion = process.env.WATCHBOUND_PLANNED_VERSION;
  try {
    const sourceSha = capture(fixture, "git", ["rev-parse", "HEAD"]);
    materializeReleaseCandidate(fixture, { sourceSha, version });
    process.env.WATCHBOUND_PLANNED_VERSION = version;
    const candidate = await verifyPublishPreconditions(version, fixture);
    assert.equal(candidate.kind, "watchbound-materialized-release-candidate");
    assert.equal(candidate.sourceVersion, SOURCE_VERSION);
    assert.equal(candidate.version, version);
  } finally {
    if (previousPlannedVersion === undefined) {
      delete process.env.WATCHBOUND_PLANNED_VERSION;
    } else {
      process.env.WATCHBOUND_PLANNED_VERSION = previousPlannedVersion;
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("npm publication preflights every namespace and requires target bootstraps", async () => {
  const packages = [
    { kind: "target", targetId: "linux-x64-gnu", name: "@gadicc/x64" },
    {
      kind: "target",
      targetId: "linux-arm-gnueabihf",
      name: "@gadicc/armhf",
    },
    { kind: "loader", name: "@gadicc/loader" },
    { kind: "wrapper", name: "wrapper" },
  ];
  const requested = [];
  const packageState = async (specifier) => {
    requested.push(specifier);
    const name = specifier.replace(/@0\.0\.0-bootstrap\.0$/u, "");
    if (name === "@gadicc/armhf") return null;
    if (specifier.endsWith("@0.0.0-bootstrap.0")) {
      return {
        name,
        version: "0.0.0-bootstrap.0",
        deprecated: "Inert namespace bootstrap only; do not depend on this version.",
        "dist-tags": { bootstrap: "0.0.0-bootstrap.0" },
        repository: { url: "git+https://github.com/gadicc/watchbound.git" },
      };
    }
    return { name };
  };

  await assert.rejects(
    preflightNpmNamespaces(packages, { packageState }),
    /lacks inert bootstrap @gadicc\/armhf@0\.0\.0-bootstrap\.0/u,
  );
  assert.deepEqual(requested, [
    "@gadicc/x64@0.0.0-bootstrap.0",
    "@gadicc/armhf@0.0.0-bootstrap.0",
    "@gadicc/loader",
    "wrapper",
  ]);
});

test("npm publication contains a new native namespace failure before stable packages", () => {
  assert.deepEqual(
    orderReleasePackages([
      { kind: "wrapper", name: "wrapper" },
      { kind: "target", targetId: "linux-x64-gnu", name: "x64" },
      { kind: "loader", name: "loader" },
      { kind: "target", targetId: "linux-arm-gnueabihf", name: "armhf" },
      { kind: "target", targetId: "linux-arm64-gnu", name: "arm64" },
    ]).map(({ name }) => name),
    ["armhf", "x64", "arm64", "loader", "wrapper"],
  );
});

test("release versions are deterministic generated candidates", () => {
  const fixture = createFixture();
  try {
    const sourceSha = capture(fixture, "git", ["rev-parse", "HEAD"]);
    const candidate = materializeReleaseCandidate(fixture, {
      sourceSha,
      version: "9.8.7",
    });

    assert.equal(candidate.schemaVersion, 1);
    assert.equal(candidate.kind, "watchbound-materialized-release-candidate");
    assert.equal(candidate.sourceSha, sourceSha);
    assert.equal(candidate.sourceVersion, SOURCE_VERSION);
    assert.equal(candidate.version, "9.8.7");
    assert.equal(candidate.wrapperVersion, "9.8.7");
    assert.equal(candidate.nativeStackVersion, "9.8.7");
    assert.equal(candidate.releaseClass, "native");
    assert.equal(candidate.gitDirty, true);
    assert.deepEqual(
      candidate.files.map(({ path: relativePath }) => relativePath),
      VERSION_FILES,
    );
    assertWorkspaceVersion(fixture, "9.8.7");
    assert.deepEqual(
      verifyReleaseCandidate(fixture, { sourceSha, version: "9.8.7" }),
      candidate,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("wrapper candidates stamp only wrapper identity and exact-pin an older loader", () => {
  const fixture = createFixture();
  try {
    const sourceSha = capture(fixture, "git", ["rev-parse", "HEAD"]);
    const candidate = materializeReleaseCandidate(fixture, {
      sourceSha,
      wrapperVersion: "9.8.7",
      nativeStackVersion: "2.1.2",
      releaseClass: "wrapper",
    });
    assert.equal(candidate.wrapperVersion, "9.8.7");
    assert.equal(candidate.nativeStackVersion, "2.1.2");
    assert.equal(candidate.releaseClass, "wrapper");
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture, "package.json"))).version, "9.8.7");
    const wrapper = JSON.parse(fs.readFileSync(path.join(fixture, "js/package.json")));
    assert.equal(wrapper.version, "9.8.7");
    assert.equal(wrapper.dependencies["@gadicc/watchbound-node"], "2.1.2");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(fixture, "node/package.json"))).version,
      SOURCE_VERSION,
    );
    assert.match(
      fs.readFileSync(path.join(fixture, "Cargo.toml"), "utf8"),
      /^version = "0\.0\.0-development"$/mu,
    );
    assert.deepEqual(
      capture(fixture, "git", ["diff", "--name-only"]).split("\n").sort(),
      ["js/package.json", "package.json"],
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("release package plans preserve wrapper/native identities and exact target pins", () => {
  const targets = [
    { id: "linux-x64-gnu", package: "@gadicc/watchbound-node-linux-x64-gnu" },
    { id: "linux-arm64-gnu", package: "@gadicc/watchbound-node-linux-arm64-gnu" },
  ];
  const wrapper = createReleasePackagePlan({
    releaseClass: "wrapper",
    wrapperVersion: "9.8.7",
    nativeStackVersion: "2.1.2",
    targets,
  });
  assert.deepEqual(wrapper.wrapper.dependencies, {
    "@gadicc/watchbound-node": "2.1.2",
  });
  assert.equal(wrapper.loader, null);
  assert.deepEqual(wrapper.targets, []);

  const full = createReleasePackagePlan({
    releaseClass: "native",
    wrapperVersion: "9.8.7",
    nativeStackVersion: "9.8.7",
    targets,
  });
  assert.equal(full.wrapper.dependencies["@gadicc/watchbound-node"], "9.8.7");
  assert.deepEqual(full.loader.optionalDependencies, {
    "@gadicc/watchbound-node-linux-x64-gnu": "9.8.7",
    "@gadicc/watchbound-node-linux-arm64-gnu": "9.8.7",
  });
  assert.deepEqual(full.targets.map(({ version }) => version), ["9.8.7", "9.8.7"]);
  assert.throws(
    () => createReleasePackagePlan({
      releaseClass: "native",
      wrapperVersion: "9.8.7",
      nativeStackVersion: "2.1.2",
      targets,
    }),
    /must remain lockstep/u,
  );
  for (const nativeStackVersion of ["9.8.7", "10.0.0"]) {
    assert.throws(
      () => createReleasePackagePlan({
        releaseClass: "wrapper",
        wrapperVersion: "9.8.7",
        nativeStackVersion,
        targets,
      }),
      /require an older native stack/u,
    );
  }
  assert.doesNotThrow(() => createReleasePackagePlan({
    releaseClass: "wrapper",
    wrapperVersion: "9.8.7",
    nativeStackVersion: "9.8.7-rc.1",
    targets,
  }));
});

test("publication resume plans remain ordered for wrapper and native releases", () => {
  const wrapperPackages = [
    { kind: "wrapper", name: "watchbound", version: "9.8.7" },
  ];
  assert.deepEqual(
    publicationResumePlan({
      releaseClass: "wrapper",
      packages: wrapperPackages,
      states: new Map([["watchbound", { version: "9.8.7" }]]),
      jsrExists: false,
    }),
    { npm: [], jsr: true },
  );
  assert.throws(
    () => publicationResumePlan({
      releaseClass: "wrapper",
      packages: wrapperPackages,
      states: new Map([["watchbound", null]]),
      jsrExists: true,
    }),
    /JSR wrapper exists before its exact npm wrapper/u,
  );

  const nativePackages = [
    { kind: "target", targetId: "x64", name: "target", version: "9.8.7" },
    { kind: "loader", name: "loader", version: "9.8.7" },
    { kind: "wrapper", name: "watchbound", version: "9.8.7" },
  ];
  assert.deepEqual(
    publicationResumePlan({
      releaseClass: "native",
      packages: nativePackages,
      states: new Map([
        ["target", { version: "9.8.7" }],
        ["loader", null],
        ["watchbound", null],
      ]),
      jsrExists: false,
    }),
    { npm: ["loader", "watchbound"], jsr: true },
  );
  assert.throws(
    () => publicationResumePlan({
      releaseClass: "native",
      packages: nativePackages,
      states: new Map([
        ["target", null],
        ["loader", { version: "9.8.7" }],
        ["watchbound", null],
      ]),
      jsrExists: false,
    }),
    /without exact native targets/u,
  );
});

test("JSR publication resume rejects registry exports that differ from the package", () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-jsr-resume-"));
  try {
    const files = {
      "README.md": "readme\n",
      "LICENSE.txt": "license\n",
      "package.json": "{}\n",
      "jsr.json": `${JSON.stringify({ exports: { ".": "./index.js" } })}\n`,
      "index.js": "export const value = 1;\n",
      "index.d.ts": "export declare const value: 1;\n",
    };
    const manifest = {};
    for (const [relativePath, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(packageRoot, relativePath), contents);
      manifest[`/${relativePath}`] = {
        checksum: `sha256-${crypto.createHash("sha256").update(contents).digest("hex")}`,
        size: Buffer.byteLength(contents),
      };
    }
    const metadata = { exports: { ".": "./index.js" }, manifest };
    assert.doesNotThrow(() => verifyExistingJsrPackage(metadata, packageRoot));
    assert.throws(
      () => verifyExistingJsrPackage({ ...metadata, exports: { ".": "./other.js" } }, packageRoot),
      /existing JSR package exports/u,
    );
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("generated candidates reject any mutation outside the version transform", () => {
  const fixture = createFixture();
  try {
    const sourceSha = capture(fixture, "git", ["rev-parse", "HEAD"]);
    materializeReleaseCandidate(fixture, { sourceSha, version: "9.8.7" });
    fs.appendFileSync(path.join(fixture, "package.json"), "\n");
    assert.throws(
      () => verifyReleaseCandidate(fixture, { sourceSha, version: "9.8.7" }),
      /materialized candidate differs/iu,
    );

    fs.writeFileSync(
      path.join(fixture, "package.json"),
      `${JSON.stringify({
        ...JSON.parse(capture(fixture, "git", ["show", "HEAD:package.json"])),
        version: "9.8.7",
      }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(fixture, "unexpected.txt"), "unexpected\n");
    assert.throws(
      () => verifyReleaseCandidate(fixture, { sourceSha, version: "9.8.7" }),
      /untracked files/iu,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function createFixture({ qualifyTargets = false } = {}) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-release-version-"));
  const fixtureFiles = [...VERSION_FILES, "config/native-matrix.json"];
  for (const relativePath of fixtureFiles) {
    const destination = path.join(fixture, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const source = process.env.WATCHBOUND_CANDIDATE_VERSION
      ? captureRaw(workspaceRoot, "git", ["show", `HEAD:${relativePath}`])
      : fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
    fs.writeFileSync(destination, source);
  }
  if (qualifyTargets) {
    const matrixPath = path.join(fixture, "config/native-matrix.json");
    const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
    for (const target of matrix.targets) target.qualification = "supported";
    fs.writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`);
  }
  run(fixture, "git", ["init", "--quiet"]);
  run(fixture, "git", ["add", ...fixtureFiles]);
  run(fixture, "git", [
    "-c",
    "user.name=Watchbound Test",
    "-c",
    "user.email=watchbound@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "test: source placeholder",
  ]);
  return fixture;
}

function capture(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function captureRaw(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
}
