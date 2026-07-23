"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const binding = require("../../index.js");

let subscription;
let blockOnce = workerData.blockControl instanceof SharedArrayBuffer;
const blockControl = blockOnce ? new Int32Array(workerData.blockControl) : undefined;

async function main() {
  subscription = await binding.subscribe(
    workerData.root,
    { batchWindowMs: 8 },
    () => {
      if (blockOnce) {
        blockOnce = false;
        parentPort.postMessage({ type: "callback-entered", label: workerData.label });
        Atomics.wait(blockControl, 0, 0);
      }
      parentPort.postMessage({ type: "observed", label: workerData.label });
    },
  );
  parentPort.postMessage({ type: "ready", label: workerData.label });
}

parentPort.on("message", async (message) => {
  if (message?.type !== "dispose") return;
  try {
    await subscription?.dispose();
    subscription = undefined;
    parentPort.postMessage({ type: "disposed", label: workerData.label });
  } catch (error) {
    parentPort.postMessage({
      type: "failure",
      name: error?.name,
      code: error?.code,
      message: error?.message ?? String(error),
    });
  }
});

main().catch((error) => {
  parentPort.postMessage({
    type: "failure",
    name: error?.name,
    code: error?.code,
    message: error?.message ?? String(error),
  });
  process.exitCode = 1;
});
