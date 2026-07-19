#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAdapter } from "./adapters/index.mjs";
import {
  cpuDelta,
  forceGc,
  memoryDelta,
  nowMs,
  processSample,
  serializeError,
} from "./lib/metrics.mjs";
import {
  prepareScenario,
  runScenario,
  SkipScenarioError,
} from "./lib/scenarios.mjs";
import { outcomeFromChecks } from "./lib/outcomes.mjs";

let activeRunDirectory = null;

function send(message) {
  if (typeof process.send === "function") {
    return new Promise((resolve) => process.send(message, resolve));
  }
  process.stdout.write(`${JSON.stringify(message.result ?? message)}\n`);
  return Promise.resolve();
}

async function measuredAdapterLoad(adapterId) {
  const gcBefore = forceGc();
  const before = processSample();
  const cpuBefore = process.cpuUsage();
  const startedAtMs = nowMs();
  const adapter = await loadAdapter(adapterId);
  const latencyMs = nowMs() - startedAtMs;
  const cpu = cpuDelta(cpuBefore);
  const gcAfter = forceGc();
  const after = processSample();
  return {
    adapter,
    measurement: {
      latencyMs,
      cpu,
      gcAvailable: gcBefore && gcAfter,
      memoryBefore: before.memory,
      memoryAfter: after.memory,
      memoryDelta: memoryDelta(before, after),
      inotifyBefore: before.inotify,
      inotifyAfter: after.inotify,
    },
  };
}

async function runProbe(payload) {
  if (process.platform !== "linux") {
    return {
      kind: "probe",
      adapterId: payload.adapterId,
      status: "skipped",
      reason: "The Watchbound feasibility harness is Linux-only",
    };
  }
  const loaded = await measuredAdapterLoad(payload.adapterId);
  if (!loaded.adapter.available) {
    return {
      kind: "probe",
      adapterId: payload.adapterId,
      status: "skipped",
      reason: loaded.adapter.reason,
      adapter: loaded.adapter,
      adapterLoad: loaded.measurement,
    };
  }
  return {
    kind: "probe",
    adapterId: payload.adapterId,
    status: "available",
    adapter: {
      metadata: loaded.adapter.metadata,
      capabilities: loaded.adapter.capabilities,
    },
    adapterLoad: loaded.measurement,
  };
}

async function runTrial(payload) {
  if (process.platform !== "linux") {
    return {
      kind: "trial",
      adapterId: payload.adapterId,
      scenario: payload.scenario,
      run: payload.run,
      status: "skipped",
      reason: "The Watchbound feasibility harness is Linux-only",
    };
  }

  const tempParent = path.resolve(payload.config.tempDir || os.tmpdir());
  fs.mkdirSync(tempParent, { recursive: true });
  const runDirectory = fs.mkdtempSync(path.join(tempParent, "watchbound-bench-"));
  activeRunDirectory = runDirectory;
  await send({ type: "started", runDirectory });
  const processAtStart = processSample();
  const preparationStartedAtMs = nowMs();
  let prepared;
  try {
    prepared = prepareScenario(payload.scenario, payload.config, runDirectory);
  } catch (error) {
    if (error instanceof SkipScenarioError) {
      return {
        kind: "trial",
        adapterId: payload.adapterId,
        scenario: payload.scenario,
        run: payload.run,
        status: "skipped",
        reason: error.message,
        details: error.details,
      };
    }
    throw error;
  }
  const preparationMs = nowMs() - preparationStartedAtMs;
  const loaded = await measuredAdapterLoad(payload.adapterId);
  if (!loaded.adapter.available) {
    return {
      kind: "trial",
      adapterId: payload.adapterId,
      scenario: payload.scenario,
      run: payload.run,
      status: "skipped",
      reason: loaded.adapter.reason,
      adapter: loaded.adapter,
      preparationMs,
      adapterLoad: loaded.measurement,
    };
  }

  const scenarioResult = await runScenario(
    payload.scenario,
    loaded.adapter,
    prepared,
    payload.config,
  );
  return {
    kind: "trial",
    adapterId: payload.adapterId,
    adapter: loaded.adapter.metadata,
    scenario: payload.scenario,
    run: payload.run,
    status: "completed",
    outcome: outcomeFromChecks(scenarioResult.checks),
    config: {
      directories: payload.config.directories,
      burstCount: payload.config.burstCount,
      maxWatches: payload.config.maxWatches,
      timeoutMs: payload.config.timeoutMs,
      settleMs: payload.config.settleMs,
      topologyDelayMs: payload.config.topologyDelayMs,
      exclusionObservationMs: payload.config.exclusionObservationMs,
      disposalObservationMs: payload.config.disposalObservationMs,
    },
    preparationMs,
    adapterLoad: loaded.measurement,
    processAtStart,
    result: scenarioResult,
  };
}

async function main() {
  const rawPayload = process.argv[2];
  if (!rawPayload) throw new Error("Missing child payload");
  const payload = JSON.parse(rawPayload);

  let result;
  try {
    result = payload.kind === "probe" ? await runProbe(payload) : await runTrial(payload);
  } catch (error) {
    result = {
      kind: payload.kind,
      adapterId: payload.adapterId,
      scenario: payload.scenario ?? null,
      run: payload.run ?? null,
      status: "error",
      error: serializeError(error),
    };
  } finally {
    if (activeRunDirectory) {
      try {
        fs.rmSync(activeRunDirectory, { recursive: true, force: true });
      } catch (error) {
        if (result) result.cleanupError = serializeError(error);
      }
      activeRunDirectory = null;
    }
  }
  await send({ type: "result", result });
}

main().then(
  () => {
    if (typeof process.send === "function") process.exit(0);
  },
  async (error) => {
    await send({
      type: "result",
      result: { kind: "unknown", status: "error", error: serializeError(error) },
    });
    if (typeof process.send === "function") process.exit(1);
    process.exitCode = 1;
  },
);
