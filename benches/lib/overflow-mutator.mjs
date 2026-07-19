import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const payload = JSON.parse(process.argv[2]);
validatePayload(payload);

const startedAt = performance.now();
let watcherStopped = false;
let stopConfirmed = false;
let resumeAttempted = false;

function resumeWatcher() {
  if (!watcherStopped) return;
  resumeAttempted = true;
  try {
    process.kill(payload.watcherPid, "SIGCONT");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  } finally {
    watcherStopped = false;
  }
}

for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.once(signal, () => {
    try {
      resumeWatcher();
    } finally {
      process.exit(exitCode);
    }
  });
}
process.once("exit", resumeWatcher);

try {
  // Do not stop the watcher until the trial's controller has been told which
  // detached process group supervises this helper.
  await waitForReadySignal();
  process.kill(payload.watcherPid, "SIGSTOP");
  watcherStopped = true;
  const stopConfirmationMs = await waitUntilStopped(payload.watcherPid, 2_000);
  stopConfirmed = true;

  for (let index = 0; index < payload.count; index += 1) {
    const name = `overflow-${String(index).padStart(6, "0")}.txt`;
    fs.writeFileSync(path.join(payload.root, name), "overflow\n");
  }

  resumeWatcher();
  process.stdout.write(
    JSON.stringify({
      generated: payload.count,
      kernelQueueLimit: payload.kernelQueueLimit,
      exceededQueueBy: payload.count - payload.kernelQueueLimit,
      stopConfirmed,
      stopConfirmationMs,
      resumeAttempted,
      durationMs: performance.now() - startedAt,
    }),
  );
} finally {
  resumeWatcher();
}

function waitForReadySignal() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const command = input.slice(0, newline).trim();
      if (command === "ready") resolve();
      else reject(new Error(`Unexpected overflow-mutator command: ${command}`));
    });
    process.stdin.once("end", () => reject(new Error("Overflow mutator stdin closed before ready")));
    process.stdin.once("error", reject);
  });
}

async function waitUntilStopped(pid, timeoutMs) {
  const started = performance.now();
  const deadline = started + timeoutMs;
  while (performance.now() < deadline) {
    let status;
    try {
      status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    } catch (error) {
      const wrapped = new Error(`Could not confirm watcher stop state: ${error.message}`);
      wrapped.code = "WATCHBOUND_OVERFLOW_STOP_CHECK_FAILED";
      throw wrapped;
    }
    const state = /^State:\s+([A-Za-z])/mu.exec(status)?.[1] ?? null;
    if (state === "T" || state === "t") return performance.now() - started;
    await delay(5);
  }
  const error = new Error(`Watcher process ${pid} did not enter a stopped state within ${timeoutMs} ms`);
  error.code = "WATCHBOUND_OVERFLOW_STOP_TIMEOUT";
  throw error;
}

function validatePayload(value) {
  if (!Number.isSafeInteger(value?.watcherPid) || value.watcherPid <= 1) {
    throw new TypeError("watcherPid must be a process id greater than one");
  }
  if (typeof value?.root !== "string" || !path.isAbsolute(value.root)) {
    throw new TypeError("root must be an absolute path");
  }
  if (!Number.isSafeInteger(value?.count) || value.count <= 0) {
    throw new TypeError("count must be a positive integer");
  }
  if (!Number.isSafeInteger(value?.kernelQueueLimit) || value.kernelQueueLimit <= 0) {
    throw new TypeError("kernelQueueLimit must be a positive integer");
  }
}
