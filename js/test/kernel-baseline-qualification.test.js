import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCleanQemuCompletion,
  copyTreePreservingSymlinks,
} from "../../scripts/kernel-baseline-qualification-helpers.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("kernel baseline accepts evidence only after a clean QEMU exit", () => {
  assert.doesNotThrow(() =>
    assertCleanQemuCompletion({
      error: undefined,
      status: 0,
      signal: null,
    }));

  assert.throws(
    () =>
      assertCleanQemuCompletion({
        error: undefined,
        status: 1,
        signal: null,
      }),
    /QEMU did not exit cleanly \(status=1, signal=null\)/u,
  );

  assert.throws(
    () =>
      assertCleanQemuCompletion({
        error: undefined,
        status: null,
        signal: "SIGABRT",
      }),
    /QEMU did not exit cleanly \(status=null, signal=SIGABRT\)/u,
  );
});

test("kernel baseline preserves QEMU spawn failures", () => {
  const failure = new Error("QEMU could not start");
  assert.throws(
    () =>
      assertCleanQemuCompletion({
        error: failure,
        status: null,
        signal: null,
      }),
    (error) => error === failure,
  );
});

test("kernel guest assembly preserves relative Node runtime symlinks", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-kernel-copy-"));
  try {
    const source = path.join(fixtureRoot, "source");
    const destination = path.join(fixtureRoot, "destination");
    fs.mkdirSync(path.join(source, "bin"), { recursive: true });
    fs.writeFileSync(path.join(source, "electron"), "runtime");
    fs.symlinkSync("../electron", path.join(source, "bin/node"));

    copyTreePreservingSymlinks(source, destination);

    assert.equal(fs.readlinkSync(path.join(destination, "bin/node")), "../electron");
    assert.equal(fs.readFileSync(path.join(destination, "electron"), "utf8"), "runtime");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("kernel baseline reports host and guest phase boundaries", () => {
  const runner = fs.readFileSync(
    path.join(workspaceRoot, "scripts/run-kernel-baseline-qualification.mjs"),
    "utf8",
  );
  const guestInit = fs.readFileSync(
    path.join(workspaceRoot, "scripts/fixtures/kernel-baseline-init.sh"),
    "utf8",
  );
  const packageSmoke = fs.readFileSync(
    path.join(workspaceRoot, "scripts/fixtures/distro-package-smoke.sh"),
    "utf8",
  );
  const installedSmoke = fs.readFileSync(
    path.join(workspaceRoot, "scripts/check-installed-package.mjs"),
    "utf8",
  );

  assert.match(runner, /WATCHBOUND_KERNEL_BASELINE_HOST_PHASE=/u);
  assert.match(runner, /logPhase\("qemu-start"/u);
  assert.match(runner, /logPhase\("qemu-complete"/u);
  assert.match(guestInit, /WATCHBOUND_KERNEL_BASELINE_GUEST_PHASE=/u);
  assert.match(guestInit, /phase package-smoke-start/u);
  assert.match(packageSmoke, /WATCHBOUND_PACKAGE_SMOKE_PHASE=/u);
  assert.match(packageSmoke, /phase installed-smoke-start/u);
  assert.match(installedSmoke, /WATCHBOUND_INSTALLED_SMOKE_PHASE=/u);
  assert.match(installedSmoke, /logPhase\("exclusions-recovery-start"/u);
  assert.match(installedSmoke, /logPhase\("joined-disposal-start"/u);
});
