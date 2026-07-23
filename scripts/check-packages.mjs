import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const version = JSON.parse(
  fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
).version;

fs.rmSync(tarballRoot, { recursive: true, force: true });
fs.mkdirSync(tarballRoot, { recursive: true });

try {
  const native = packAndCheck("node", [
    "LICENSE.txt",
    "README.md",
    "index.d.ts",
    "index.js",
    "load-native.cjs",
    "package.json",
    "watchbound.linux-x64-gnu.node",
  ]);
  const wrapper = packAndCheck("wrapper", [
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

  writeJson(path.join(smokeRoot, "package.json"), {
    private: true,
    type: "module",
  });
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      native.tarball,
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
        "import { capabilities } from '@gadicc/watchbound';",
        `assert.equal(capabilities.versions.wrapper, ${JSON.stringify(version)});`,
        "assert.equal(capabilities.support.operatingSystem.family, 'linux');",
        "assert.equal(capabilities.build.delivery, 'bundled-native-package');",
        "assert.equal(capabilities.build.prebuilt, true);",
        "assert.equal(capabilities.support.delivery, 'bundled-native-package');",
      ].join(" "),
    ],
    smokeRoot,
  );

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
      native.tarball,
    ],
    path.join(distRoot, "jsr"),
  );
  run(
    "deno",
    ["publish", "--dry-run", "--allow-dirty", "--no-check"],
    path.join(distRoot, "jsr"),
  );
  fs.rmSync(path.join(distRoot, "jsr", "node_modules"), {
    recursive: true,
    force: true,
  });
  run(
    "node",
    ["scripts/generate-release-evidence.mjs"],
    workspaceRoot,
  );
} finally {
  fs.rmSync(smokeRoot, { recursive: true, force: true });
}

process.stdout.write(
  `Validated npm tarballs, installed package smoke, JSR dry run, and release evidence for ${version}\n`,
);

function packAndCheck(directory, expectedFiles) {
  const cwd = path.join(distRoot, "npm", directory);
  const result = run(
    "npm",
    [
      "pack",
      "--json",
      "--pack-destination",
      tarballRoot,
    ],
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
  return {
    tarball: path.join(tarballRoot, packed.filename),
  };
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

function writeJson(destination, value) {
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}
