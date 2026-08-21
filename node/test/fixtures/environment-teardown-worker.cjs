"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const binding = require(workerData.bindingPath ?? "../../index.js");

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
        setImmediate(() => {
          parentPort.postMessage({ type: "change-observed" });
          if (workerData.startExplicitDispose === true) {
            const disposal = liveSubscription.dispose();
            if (liveSubscription.dispose() !== disposal) {
              parentPort.postMessage({
                type: "failure",
                message: "repeated dispose did not return the same Promise",
              });
              return;
            }
            disposal.then(
              () => parentPort.postMessage({ type: "dispose-settled" }),
              (error) => parentPort.postMessage({
                type: "failure",
                name: error?.name,
                code: error?.code,
                message: error?.message ?? String(error),
              }),
            );
            parentPort.postMessage({ type: "dispose-started" });
          }
        });
      }
      // Private binding seam: returning true transfers completion ownership to
      // the wrapper. This fixture deliberately never acknowledges the ticket
      // so Worker teardown must abandon it without waiting on JavaScript.
      return workerData.holdDeliveryCompletion === true;
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
