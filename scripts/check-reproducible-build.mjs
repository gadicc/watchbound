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
const scratchRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "watchbound-reproducible-build-"),
);
const nativePath = path.join(
  workspaceRoot,
  "node",
  "watchbound.linux-x64-gnu.node",
);
const builds = [];
const expectedSha256 = process.env.WATCHBOUND_EXPECTED_NATIVE_SHA256 ?? null;
const sourceSha = capture("git", ["rev-parse", "HEAD"]);
const version = JSON.parse(
  fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
).version;

try {
  for (const buildNumber of [1, 2]) {
    const targetRoot = path.join(scratchRoot, `target-${buildNumber}`);
    fs.rmSync(nativePath, { force: true });
    run(process.execPath, ["scripts/build-node.mjs"], workspaceRoot, {
      ...process.env,
      CARGO_INCREMENTAL: "0",
      CARGO_TARGET_DIR: targetRoot,
    });
    const binary = fs.readFileSync(nativePath);
    const sha256 = crypto.createHash("sha256").update(binary).digest("hex");
    const retainedPath = path.join(
      scratchRoot,
      `watchbound.linux-x64-gnu-${buildNumber}.node`,
    );
    fs.writeFileSync(retainedPath, binary);
    builds.push({
      buildNumber,
      bytes: binary.length,
      sha256,
    });
  }

  assert.equal(
    builds[0].sha256,
    builds[1].sha256,
    "two clean builds on the same release runner produced different binaries",
  );
  assert.equal(
    fs.readFileSync(
      path.join(scratchRoot, "watchbound.linux-x64-gnu-1.node"),
    ).equals(
      fs.readFileSync(
        path.join(scratchRoot, "watchbound.linux-x64-gnu-2.node"),
      ),
    ),
    true,
    "two clean builds on the same release runner were not byte-identical",
  );
  if (expectedSha256 !== null) {
    assert.match(expectedSha256, /^[0-9a-f]{64}$/u);
    assert.equal(
      builds[0].sha256,
      expectedSha256,
      "same-runner build differs from the independently approved native binary",
    );
  }

  if (process.env.WATCHBOUND_REPRODUCIBLE_OUTPUT) {
    fs.writeFileSync(
      path.resolve(
        workspaceRoot,
        process.env.WATCHBOUND_REPRODUCIBLE_OUTPUT,
      ),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "watchbound-same-runner-reproducibility",
        sourceSha,
        version,
        expectedSha256,
        rustFlags: process.env.RUSTFLAGS ?? null,
        builds,
        byteIdentical: true,
      }, null, 2)}\n`,
    );
  }
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

process.stdout.write(
  `Verified repeatable native build on this runner: ${builds[0].sha256}\n`,
);

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}
