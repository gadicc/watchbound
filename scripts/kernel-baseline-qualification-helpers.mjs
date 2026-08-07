import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";

const DEFAULT_MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;

export function assertCleanQemuCompletion(result) {
  if (result.error) throw result.error;
  if (result.status === 0 && result.signal === null) return;
  throw new Error(
    `QEMU did not exit cleanly (status=${result.status}, signal=${result.signal})`,
  );
}

export function assertNoQemuSemanticFailure(serial) {
  const marker = serial.match(
    /^(?:WATCHBOUND_INSTALLED_SMOKE_(?:PROCESS|SEMANTIC)_DEADLINE=.*|WATCHBOUND_KERNEL_BASELINE_STATUS=failed)\r?$/mu,
  )?.[0];
  if (marker !== undefined) {
    throw new Error(`QEMU guest reported a semantic failure: ${marker}`);
  }
}

export function qemuExecutionPolicy(target) {
  // The recurring stalls are isolated to the native ARM64 hosted lane. MTTCG
  // changes its legacy scheduler loop, but -smp 1 remains the actual guest CPU
  // and shared-runner resource bound. This is a controlled mitigation, not
  // performance evidence or permission to add vCPUs. Re-audit QEMU support
  // before extending it to another host/guest pair.
  const tcgThreadMode = target.id === "linux-arm64-gnu" ? "multi" : "single";
  return {
    acceleration: tcgThreadMode === "multi"
      ? "tcg-multi-threaded"
      : "tcg-single-threaded",
    acceleratorArgument: `tcg,thread=${tcgThreadMode}`,
    vcpus: 1,
  };
}

export async function runBoundedProcess(command, args, {
  cwd,
  env = process.env,
  timeoutMs,
  maxOutputBytes = DEFAULT_MAX_PROCESS_OUTPUT_BYTES,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  stdoutSink = process.stdout,
  stderrSink = process.stderr,
} = {}) {
  assert.equal(typeof command, "string");
  assert.ok(command.length > 0, "bounded process command is required");
  assert.ok(Array.isArray(args), "bounded process arguments must be an array");
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  assert.ok(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0);
  assert.ok(Number.isSafeInteger(killGraceMs) && killGraceMs >= 0);

  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const sinkErrorHandlers = new Map();
    let outputBytes = 0;
    let error;
    let closed = false;
    let terminating = false;
    let forceKillTimer;

    const terminate = (nextError) => {
      error ??= nextError;
      if (terminating || closed || child.pid === undefined) return;
      terminating = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, killGraceMs);
    };

    const observeSinkErrors = (sink) => {
      if (
        sinkErrorHandlers.has(sink) ||
        typeof sink.on !== "function"
      ) return;
      const onError = (sinkError) => terminate(sinkError);
      sinkErrorHandlers.set(sink, onError);
      sink.on("error", onError);
    };

    const forward = (sink, chunk) => {
      if (sink === null || sink === undefined) return;
      observeSinkErrors(sink);
      try {
        // Writable.write(false) still accepts the bytes. Do not pause QEMU's
        // serial pipe: runner-log backpressure must not stall the guest. The
        // shared capture cap bounds both retained and sink-queued output.
        sink.write(chunk);
      } catch (sinkError) {
        terminate(sinkError);
      }
    };

    const capture = (sink, chunks, value) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = maxOutputBytes - outputBytes;
      if (remaining > 0) {
        const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
        chunks.push(retained);
        outputBytes += retained.length;
        forward(sink, retained);
      }
      if (chunk.length > remaining) {
        const overflow = new Error(
          `spawn ${command} ENOBUFS: output exceeded ${maxOutputBytes} bytes`,
        );
        overflow.code = "ENOBUFS";
        overflow.path = command;
        overflow.spawnargs = args;
        terminate(overflow);
      }
    };

    child.stdout.on("data", (chunk) => {
      capture(stdoutSink, stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      capture(stderrSink, stderr, chunk);
    });
    child.on("error", (spawnError) => {
      error ??= spawnError;
    });

    const timeoutTimer = setTimeout(() => {
      const timeout = new Error(`spawn ${command} ETIMEDOUT`);
      timeout.code = "ETIMEDOUT";
      timeout.path = command;
      timeout.spawnargs = args;
      timeout.syscall = `spawn ${command}`;
      terminate(timeout);
    }, timeoutMs);

    child.on("close", (status, signal) => {
      closed = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      for (const [sink, onError] of sinkErrorHandlers) {
        if (typeof sink.off === "function") sink.off("error", onError);
        else sink.removeListener?.("error", onError);
      }
      sinkErrorHandlers.clear();
      resolve({
        error,
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export function copyTreePreservingSymlinks(source, destination) {
  assert.ok(fs.statSync(source).isDirectory(), `missing directory ${source}`);
  fs.cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
  });
}
