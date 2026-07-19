import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export function nowMs() {
  return performance.now();
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitFor(predicate, timeoutMs, intervalMs = 10) {
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline) {
    if (await predicate()) return true;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - nowMs())));
  }
  return Boolean(await predicate());
}

export function forceGc() {
  if (typeof globalThis.gc !== "function") return false;
  globalThis.gc();
  return true;
}

export function processSample({ collectInotify = true } = {}) {
  const memory = process.memoryUsage();
  return {
    atMs: nowMs(),
    memory: {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
    inotify: collectInotify ? readInotifyUsage() : null,
  };
}

export function memoryDelta(before, after) {
  const result = {};
  for (const key of Object.keys(after.memory)) {
    result[key] = after.memory[key] - before.memory[key];
  }
  return result;
}

export function inotifyDelta(before, after) {
  if (!before?.supported || !after?.supported) {
    return {
      supported: false,
      reason: after?.reason ?? before?.reason ?? "inotify accounting is unavailable",
    };
  }
  return {
    supported: true,
    instances: after.instances - before.instances,
    watches: after.watches - before.watches,
  };
}

export function cpuDelta(before) {
  const usage = process.cpuUsage(before);
  return {
    userMicros: usage.user,
    systemMicros: usage.system,
    totalMicros: usage.user + usage.system,
  };
}

export function readInotifyUsage() {
  if (process.platform !== "linux") {
    return { supported: false, reason: "Linux /proc fdinfo is required" };
  }
  const fdDirectory = "/proc/self/fd";
  const fdInfoDirectory = "/proc/self/fdinfo";
  try {
    const fds = [];
    for (const entry of fs.readdirSync(fdDirectory)) {
      if (!/^\d+$/u.test(entry)) continue;
      let target;
      try {
        target = fs.readlinkSync(path.join(fdDirectory, entry));
      } catch {
        continue;
      }
      if (!target.includes("inotify")) continue;
      let contents = "";
      try {
        contents = fs.readFileSync(path.join(fdInfoDirectory, entry), "utf8");
      } catch (error) {
        fds.push({ fd: Number(entry), watches: null, error: error?.code ?? "read-failed" });
        continue;
      }
      const watches = contents
        .split("\n")
        .filter((line) => line.startsWith("inotify wd:"))
        .length;
      fds.push({ fd: Number(entry), watches });
    }
    fds.sort((left, right) => left.fd - right.fd);
    if (fds.some((entry) => entry.watches == null)) {
      return {
        supported: false,
        reason: "At least one inotify fdinfo entry could not be read",
        fds,
      };
    }
    return {
      supported: true,
      instances: fds.length,
      watches: fds.reduce((sum, entry) => sum + entry.watches, 0),
      fds,
    };
  } catch (error) {
    return {
      supported: false,
      reason: `Could not inspect /proc/self/fdinfo: ${error?.code ?? error?.message ?? String(error)}`,
    };
  }
}

export function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code ?? null,
    stack: error?.stack ?? null,
  };
}
