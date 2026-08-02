const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function normalizePathInvalidations(root, nativePaths) {
  const invalidatedPathBytes = nativePaths.map((value) => Uint8Array.from(value));
  const invalidatedPaths = [];
  let pathEncodingCollapsed = false;
  for (const bytes of invalidatedPathBytes) {
    try {
      invalidatedPaths.push(fatalUtf8Decoder.decode(bytes));
    } catch {
      pathEncodingCollapsed = true;
    }
  }

  let pathEncoding = "complete";
  if (pathEncodingCollapsed && root === null) {
    invalidatedPaths.length = 0;
    pathEncoding = "bytes-only";
  } else if (pathEncodingCollapsed) {
    if (!invalidatedPaths.includes(root)) invalidatedPaths.push(root);
    pathEncoding = "root-collapsed";
  }

  return Object.freeze({
    invalidatedPaths: Object.freeze([...new Set(invalidatedPaths)]),
    invalidatedPathBytes: Object.freeze(invalidatedPathBytes),
    pathEncoding,
    pathEncodingCollapsed,
  });
}

export function createSingleCreditDeliveryBuffer({ deliver, abandon }) {
  let state = "waiting";
  let pending = null;
  return Object.freeze({
    accept(batch, deliveryId) {
      if (state === "ready") {
        deliver(batch, deliveryId);
      } else if (state === "closed") {
        abandon(batch, deliveryId);
      } else if (pending === null) {
        pending = { batch, deliveryId };
      } else {
        // The native single-credit contract makes this unreachable. Fail
        // closed without growing an early-delivery queue if it is violated.
        abandon(batch, deliveryId);
      }
    },
    ready() {
      if (state !== "waiting") return;
      state = "ready";
      const admitted = pending;
      pending = null;
      if (admitted !== null) deliver(admitted.batch, admitted.deliveryId);
    },
    close() {
      if (state === "closed") return;
      state = "closed";
      const admitted = pending;
      pending = null;
      if (admitted !== null) abandon(admitted.batch, admitted.deliveryId);
    },
  });
}
