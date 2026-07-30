"use strict";

const path = require("node:path");

function hasInvalidatedPathAtOrBelow(batches, excludedPath) {
  const descendantPrefix = `${excludedPath}${path.sep}`;
  return batches.some((batch) =>
    batch.invalidatedPaths.some((candidate) =>
      candidate === excludedPath || candidate.startsWith(descendantPrefix)));
}

module.exports = { hasInvalidatedPathAtOrBelow };
