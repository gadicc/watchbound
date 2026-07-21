"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const binding = require("../../index.js");

let liveSubscription;
let changeReported = false;

async function main() {
  const expectedPath = Buffer.from(workerData.expectedPath);
  liveSubscription = await binding.subscribe(
    workerData.root,
    { batchWindowMs: 8 },
    (batch) => {
      if (
        !changeReported
        && batch.invalidatedPaths.some((value) => value.equals(expectedPath))
      ) {
        changeReported = true;
        setImmediate(() => parentPort.postMessage({ type: "change-observed" }));
      }
    },
  );

  parentPort.postMessage({
    type: "ready",
    initialCoverage: liveSubscription.initialCoverage,
  });
}

main().catch((error) => {
  parentPort.postMessage({
    type: "failure",
    name: error?.name,
    code: error?.code,
    message: error?.message ?? String(error),
  });
  process.exitCode = 1;
});
