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
const hashes = [];

try {
  for (const buildNumber of [1, 2]) {
    const targetRoot = path.join(scratchRoot, `target-${buildNumber}`);
    run(process.execPath, ["scripts/build-node.mjs"], workspaceRoot, {
      ...process.env,
      CARGO_TARGET_DIR: targetRoot,
    });
    const binary = fs.readFileSync(
      path.join(workspaceRoot, "node", "watchbound.linux-x64-gnu.node"),
    );
    hashes.push(crypto.createHash("sha256").update(binary).digest("hex"));
  }

  assert.equal(
    hashes[0],
    hashes[1],
    "two clean builds on the same release runner produced different binaries",
  );
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

process.stdout.write(
  `Verified repeatable native build on this runner: ${hashes[0]}\n`,
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
