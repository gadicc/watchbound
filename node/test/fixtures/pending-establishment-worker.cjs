"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const binding = require("../../index.js");

const token = binding.createEstablishmentCancellation();
const establishment = binding.subscribe(workerData.root, {}, () => {}, token);
establishment.catch(() => {});
parentPort.postMessage({ type: "queued" });

// Keep the JavaScript environment alive until the parent deliberately tears it
// down while the native AsyncTask is still queued behind the occupied worker.
setInterval(() => {}, 1_000);
