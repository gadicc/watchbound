import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCleanQemuCompletion,
  assertNoQemuSemanticFailure,
  copyTreePreservingSymlinks,
  qemuExecutionPolicy,
  runBoundedProcess,
} from "../../scripts/kernel-baseline-qualification-helpers.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const childEnvironment = { ...process.env };
delete childEnvironment.NODE_TEST_CONTEXT;

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

test("kernel baseline gives captured semantic failures precedence over host timeout", () => {
  for (const marker of [
    'WATCHBOUND_INSTALLED_SMOKE_SEMANTIC_DEADLINE={"message":"callback did not enter"}',
    "WATCHBOUND_KERNEL_BASELINE_STATUS=failed",
  ]) {
    assert.throws(
      () => assertNoQemuSemanticFailure(`boot output\n${marker}\n`),
      (error) => error.message.includes(marker),
    );
  }
  assert.doesNotThrow(() =>
    assertNoQemuSemanticFailure("WATCHBOUND_KERNEL_BASELINE_STATUS=passed\n"));
});

test("kernel baseline keeps one vCPU while isolating the ARM64 MTTCG mitigation", () => {
  assert.deepEqual(qemuExecutionPolicy({
    id: "linux-arm64-gnu",
    architecture: "arm64",
  }), {
    acceleration: "tcg-multi-threaded",
    acceleratorArgument: "tcg,thread=multi",
    vcpus: 1,
  });
  for (const target of [
    { id: "linux-x64-gnu", architecture: "x64" },
    { id: "linux-arm-gnueabihf", architecture: "arm" },
    { id: "future-arm64-target", architecture: "arm64" },
  ]) {
    assert.deepEqual(qemuExecutionPolicy(target), {
      acceleration: "tcg-single-threaded",
      acceleratorArgument: "tcg,thread=single",
      vcpus: 1,
    });
  }
});

test("bounded process drains through log backpressure and retains split serial bytes", async () => {
  const forwarded = [];
  const sink = new EventEmitter();
  sink.write = (chunk) => {
    forwarded.push(Buffer.from(chunk));
    return false;
  };

  const result = await runBoundedProcess(
    process.execPath,
    [
      "-e",
      "process.stdout.write('WATCHBOUND_KERNEL_'); setTimeout(() => process.stdout.write('BASELINE_STATUS=passed\\n'), 10)",
    ],
    {
      env: childEnvironment,
      timeoutMs: 2_000,
      stdoutSink: sink,
      stderrSink: null,
    },
  );

  assertCleanQemuCompletion(result);
  assert.equal(
    result.stdout,
    "WATCHBOUND_KERNEL_BASELINE_STATUS=passed\n",
  );
  assert.equal(Buffer.concat(forwarded).toString("utf8"), result.stdout);
  assert.equal(result.stderr, "");
});

test("bounded process joins the child when live log forwarding throws", async () => {
  const failure = new Error("log sink failed");
  const result = await runBoundedProcess(
    process.execPath,
    ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
    {
      env: childEnvironment,
      timeoutMs: 2_000,
      killGraceMs: 25,
      stdoutSink: {
        write: () => {
          throw failure;
        },
      },
      stderrSink: null,
    },
  );

  assert.equal(result.error, failure);
  assert.equal(result.stdout, "ready");
  assert.ok(result.status !== 0 || result.signal !== null);
  assert.throws(
    () => assertCleanQemuCompletion(result),
    (error) => error === failure,
  );
});

test("bounded process joins the child when a live log sink emits an error", async () => {
  const failure = new Error("log sink emitted an error");
  const sink = new EventEmitter();
  sink.write = () => {
    setImmediate(() => sink.emit("error", failure));
    return true;
  };
  const result = await runBoundedProcess(
    process.execPath,
    ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"],
    {
      env: childEnvironment,
      timeoutMs: 2_000,
      killGraceMs: 25,
      stdoutSink: sink,
      stderrSink: null,
    },
  );

  assert.equal(result.error, failure);
  assert.ok(result.status !== 0 || result.signal !== null);
  assert.throws(
    () => assertCleanQemuCompletion(result),
    (error) => error === failure,
  );
});

test("bounded process preserves emulator-adjacent timeout after joined termination", async () => {
  const result = await runBoundedProcess(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ],
    {
      env: childEnvironment,
      timeoutMs: 1_000,
      killGraceMs: 25,
      stdoutSink: null,
      stderrSink: null,
    },
  );

  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.match(result.error?.message ?? "", /node(?:js)? ETIMEDOUT/u);
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGKILL");
  assert.throws(
    () => assertCleanQemuCompletion(result),
    (error) => error === result.error,
  );
});

test("bounded process cannot turn a handled timeout into a clean result", async () => {
  const forwarded = [];
  const result = await runBoundedProcess(
    process.execPath,
    [
      "-e",
      "const fs = require('node:fs'); process.on('SIGTERM', () => { fs.writeSync(1, 'WATCHBOUND_INSTALLED_SMOKE_SEMANTIC_DEADLINE=tail\\n'); process.exit(0) }); setInterval(() => {}, 1000)",
    ],
    {
      env: childEnvironment,
      timeoutMs: 1_000,
      killGraceMs: 100,
      stdoutSink: {
        write: (chunk) => {
          forwarded.push(Buffer.from(chunk));
          return true;
        },
      },
      stderrSink: null,
    },
  );

  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /WATCHBOUND_INSTALLED_SMOKE_SEMANTIC_DEADLINE=tail/u);
  assert.equal(Buffer.concat(forwarded).toString("utf8"), result.stdout);
  assert.throws(
    () => assertCleanQemuCompletion(result),
    (error) => error === result.error,
  );
});

test("bounded process kills and joins output that exceeds its capture bound", async () => {
  const result = await runBoundedProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)"],
    {
      env: childEnvironment,
      timeoutMs: 2_000,
      maxOutputBytes: 64,
      killGraceMs: 25,
      stdoutSink: null,
      stderrSink: null,
    },
  );

  assert.equal(result.error?.code, "ENOBUFS");
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 64);
  assert.ok(result.status !== 0 || result.signal !== null);
  assert.throws(
    () => assertCleanQemuCompletion(result),
    (error) => error === result.error,
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
