import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WatchboundError,
  WatchboundErrorCode,
  isWatchboundError,
  normalizeWatchboundError,
  subscribe,
} from "../index.js";

const expectedCodes = Object.freeze({
  INVALID_ARGUMENT: "WATCHBOUND_INVALID_ARGUMENT",
  SUBSCRIPTION_CLOSED: "WATCHBOUND_SUBSCRIPTION_CLOSED",
  TOPOLOGY_TRANSACTION_CONFLICT: "WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT",
  OPERATION_INTERRUPTED: "WATCHBOUND_OPERATION_INTERRUPTED",
  OPERATION_CANCELLED: "WATCHBOUND_OPERATION_CANCELLED",
  CONSUMER_BACKPRESSURE: "WATCHBOUND_CONSUMER_BACKPRESSURE",
  ROOT_STATE_CONFLICT: "WATCHBOUND_ROOT_STATE_CONFLICT",
  ROOT_UNAVAILABLE: "WATCHBOUND_ROOT_UNAVAILABLE",
  RESOURCE_UNAVAILABLE: "WATCHBOUND_RESOURCE_UNAVAILABLE",
  RUNTIME_CONFIGURATION_CONFLICT: "WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT",
  INTERNAL: "WATCHBOUND_INTERNAL",
});

test("structured error constants are complete and immutable", () => {
  assert.deepEqual(WatchboundErrorCode, expectedCodes);
  assert.equal(Object.isFrozen(WatchboundErrorCode), true);
});

test("WatchboundError exposes stable machine-readable metadata", () => {
  const systemCause = { domain: "os", code: "ENOENT", message: "missing" };
  const error = new WatchboundError("root is missing", {
    code: WatchboundErrorCode.ROOT_UNAVAILABLE,
    operation: "subscribe",
    systemCause,
  });

  assert.equal(error.name, "WatchboundError");
  assert.equal(error.code, "WATCHBOUND_ROOT_UNAVAILABLE");
  assert.equal(error.operation, "subscribe");
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfter, "filesystem-state-changes");
  assert.deepEqual(error.systemCause, systemCause);
  assert.equal(Object.isFrozen(error.systemCause), true);
  assert.equal(isWatchboundError(error), true);
  assert.throws(() => {
    error.code = "WATCHBOUND_INTERNAL";
  }, TypeError);
});

test("WatchboundError derives retry metadata solely from its code", () => {
  const expectedRetryAfter = new Map([
    ["WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT", "topology-transaction-settles"],
    ["WATCHBOUND_CONSUMER_BACKPRESSURE", "delivery-drains"],
    ["WATCHBOUND_ROOT_STATE_CONFLICT", "root-state-changes"],
    ["WATCHBOUND_ROOT_UNAVAILABLE", "filesystem-state-changes"],
    ["WATCHBOUND_RESOURCE_UNAVAILABLE", "resources-available"],
    ["WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT", "runtime-disposed"],
  ]);

  for (const code of Object.values(WatchboundErrorCode)) {
    const error = new WatchboundError("derived metadata", {
      code,
      operation: "subscribe",
      retryable: !expectedRetryAfter.has(code),
      retryAfter: "delivery-drains",
    });
    assert.equal(error.retryable, expectedRetryAfter.has(code), code);
    assert.equal(error.retryAfter, expectedRetryAfter.get(code), code);
  }
});

test("native-shaped errors normalize without losing structured metadata", () => {
  const nativeError = Object.assign(new Error("topology transaction is busy"), {
    name: "WatchboundError",
    code: "WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT",
    operation: "reconcile",
    retryable: true,
    retryAfter: "topology-transaction-settles",
    systemCause: { domain: "node-api", message: "another transaction owns the lock" },
  });
  const normalized = normalizeWatchboundError(nativeError, "reconcile");

  assert.equal(normalized instanceof WatchboundError, true);
  assert.equal(normalized.code, nativeError.code);
  assert.equal(normalized.operation, nativeError.operation);
  assert.equal(normalized.retryable, true);
  assert.equal(normalized.retryAfter, nativeError.retryAfter);
  assert.deepEqual(normalized.systemCause, nativeError.systemCause);
  assert.equal(normalized.cause, nativeError);
});

test("unknown failures normalize conservatively to WATCHBOUND_INTERNAL", () => {
  const cause = new Error("opaque native failure");
  const normalized = normalizeWatchboundError(cause, "dispose");

  assert.equal(normalized.name, "WatchboundError");
  assert.equal(normalized.code, "WATCHBOUND_INTERNAL");
  assert.equal(normalized.operation, "dispose");
  assert.equal(normalized.retryable, false);
  assert.equal(normalized.retryAfter, undefined);
  assert.equal(normalized.systemCause, undefined);
  assert.equal(normalized.cause, cause);
});

test("contradictory native retry metadata normalizes to WATCHBOUND_INTERNAL", () => {
  const contradictory = Object.assign(new Error("bad native metadata"), {
    name: "WatchboundError",
    code: "WATCHBOUND_ROOT_STATE_CONFLICT",
    operation: "reconcile",
    retryable: false,
  });
  const normalized = normalizeWatchboundError(contradictory, "reconcile");

  assert.equal(normalized.code, "WATCHBOUND_INTERNAL");
  assert.equal(normalized.retryable, false);
  assert.equal(normalized.cause, contradictory);
});

test("wrapper argument validation uses WATCHBOUND_INVALID_ARGUMENT", async () => {
  await assert.rejects(
    subscribe("", () => {}),
    (error) => {
      assert.equal(error instanceof WatchboundError, true);
      assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
      assert.equal(error.operation, "subscribe");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("subscription method validation uses operation-specific structured errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-errors-"));
  let subscription;
  try {
    subscription = await subscribe(root, () => {});
    assert.throws(
      () => subscription.replaceExclusions(1, []),
      (error) => {
        assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
        assert.equal(error.operation, "replace-exclusions");
        return true;
      },
    );
    assert.throws(
      () => subscription.recoverRoot({ identityPolicy: "sometimes" }),
      (error) => {
        assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
        assert.equal(error.operation, "recover-root");
        return true;
      },
    );
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapper preserves structured native root and lifecycle failures", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-js-native-error-"));
  const root = path.join(parent, "root");
  try {
    await assert.rejects(
      subscribe(root, () => {}),
      (error) => {
        assert.equal(error instanceof WatchboundError, true);
        assert.equal(error.code, "WATCHBOUND_ROOT_UNAVAILABLE");
        assert.equal(error.operation, "subscribe");
        assert.equal(error.retryable, true);
        assert.equal(error.retryAfter, "filesystem-state-changes");
        assert.equal(error.systemCause?.domain, "os");
        return true;
      },
    );

    fs.mkdirSync(root);
    const subscription = await subscribe(root, () => {});
    await subscription.dispose();
    await assert.rejects(
      subscription.reconcile(),
      (error) => {
        assert.equal(error instanceof WatchboundError, true);
        assert.equal(error.code, "WATCHBOUND_SUBSCRIPTION_CLOSED");
        assert.equal(error.operation, "reconcile");
        assert.equal(error.retryable, false);
        return true;
      },
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
