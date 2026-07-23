import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import nativeBinding from "@gadicc/watchbound-node";
import {
  WatchboundError,
  WatchboundErrorCode,
} from "../errors.js";
import { createEngine, subscribe as publicSubscribe } from "../index.js";
import { establishNativeSubscription } from "../native-establishment.js";

class FakeAbortSignal {
  constructor(aborted = false) {
    this.aborted = aborted;
    this.added = 0;
    this.removed = 0;
    this.listeners = new Set();
  }

  addEventListener(type, listener, options) {
    assert.equal(type, "abort");
    assert.deepEqual(options, { once: true });
    this.added += 1;
    this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    assert.equal(type, "abort");
    this.removed += 1;
    this.listeners.delete(listener);
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    const listeners = [...this.listeners];
    this.listeners.clear();
    for (const listener of listeners) listener.call(this, { type: "abort" });
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function liveDeliveryResources(diagnostics) {
  const { environmentGenerations: _environmentGenerations, ...resources } =
    diagnostics;
  return resources;
}

function cancellationError() {
  return Object.assign(new Error("subscription establishment was cancelled"), {
    name: "WatchboundError",
    code: "WATCHBOUND_OPERATION_CANCELLED",
    operation: "subscribe",
    retryable: false,
  });
}

function createFixture({
  subscribe,
  commitPublicSuccess = () => true,
  cancel = () => {},
} = {}) {
  const calls = {
    createToken: 0,
    subscribe: 0,
    cancel: 0,
    commit: 0,
  };
  const token = {
    cancel() {
      calls.cancel += 1;
      cancel();
    },
    commitPublicSuccess() {
      calls.commit += 1;
      return commitPublicSuccess();
    },
  };
  const nativeEngine = {
    createEstablishmentCancellation() {
      calls.createToken += 1;
      return token;
    },
    async subscribe(...args) {
      calls.subscribe += 1;
      return subscribe?.(...args) ?? { dispose: async () => {} };
    },
  };
  return { calls, nativeEngine, token };
}

async function establish(nativeEngine, options, buildSubscription = (value) => value) {
  return establishNativeSubscription({
    nativeEngine,
    root: "/tmp/watchbound-cancellation-test",
    options,
    callback: () => {},
    buildSubscription,
  });
}

test("already-aborted input rejects before token or native resource creation", async () => {
  const signal = new FakeAbortSignal(true);
  const { calls, nativeEngine } = createFixture();

  await assert.rejects(
    establish(nativeEngine, { signal }),
    (error) => {
      assert.equal(error instanceof WatchboundError, true);
      assert.equal(error.name, "WatchboundError");
      assert.equal(error.code, "WATCHBOUND_OPERATION_CANCELLED");
      assert.equal(error.operation, "subscribe");
      assert.equal(error.retryable, false);
      assert.equal(error.retryAfter, undefined);
      return true;
    },
  );
  assert.deepEqual(calls, {
    createToken: 0,
    subscribe: 0,
    cancel: 0,
    commit: 0,
  });
  assert.equal(signal.added, 0);
  assert.equal(signal.removed, 0);
});

test("public subscribe accepts AbortSignal and rejects an already-aborted request at baseline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-public-cancel-"));
  const observer = createEngine();
  const deliveryBefore = nativeBinding.deliveryDiagnostics();
  const runtimeBefore = observer.runtimeStats();
  const controller = new AbortController();
  controller.abort();
  let callbacks = 0;
  try {
    await assert.rejects(
      publicSubscribe(root, () => {
        callbacks += 1;
      }, { signal: controller.signal }),
      (error) => {
        assert.equal(error instanceof WatchboundError, true);
        assert.equal(error.code, WatchboundErrorCode.OPERATION_CANCELLED);
        assert.equal(error.operation, "subscribe");
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(callbacks, 0);
    assert.deepEqual(observer.runtimeStats(), runtimeBefore);
    assert.deepEqual(nativeBinding.deliveryDiagnostics(), deliveryBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public subscribe joins a live signal aborted immediately after native queuing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-public-live-cancel-"));
  fs.mkdirSync(path.join(root, "one", "two", "three"), { recursive: true });
  const observer = createEngine();
  const deliveryBefore = nativeBinding.deliveryDiagnostics();
  const runtimeBefore = observer.runtimeStats();
  const controller = new AbortController();
  let callbacks = 0;
  try {
    const establishment = publicSubscribe(root, () => {
      callbacks += 1;
    }, { signal: controller.signal });
    controller.abort();

    await assert.rejects(
      establishment,
      (error) => {
        assert.equal(error instanceof WatchboundError, true);
        assert.equal(error.code, WatchboundErrorCode.OPERATION_CANCELLED);
        assert.equal(error.operation, "subscribe");
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(callbacks, 0);
    assert.deepEqual(observer.runtimeStats(), runtimeBefore);
    assert.deepEqual(
      liveDeliveryResources(nativeBinding.deliveryDiagnostics()),
      liveDeliveryResources(deliveryBefore),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pure numeric option errors precede an already-aborted signal", async () => {
  const signal = new FakeAbortSignal(true);
  const { calls, nativeEngine } = createFixture();

  await assert.rejects(
    establish(nativeEngine, { signal, outputQueueCapacity: 0 }),
    (error) => {
      assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
      assert.equal(error.operation, "subscribe");
      return true;
    },
  );
  assert.equal(calls.createToken, 0);
  assert.equal(calls.subscribe, 0);
});

test("throwing option accessors are structured before token or native allocation", async () => {
  const failures = ["signal", "watchLimit", "automaticReconciliation"].map(
    (name) => Object.defineProperty({}, name, {
      enumerable: true,
      get() {
        throw new Error(`${name} getter failed`);
      },
    }),
  );
  failures.push(new Proxy({}, {
    ownKeys() {
      throw new Error("ownKeys failed");
    },
  }));

  for (const options of failures) {
    const { calls, nativeEngine } = createFixture();

    await assert.rejects(
      establish(nativeEngine, options),
      (error) => {
        assert.equal(error instanceof WatchboundError, true);
        assert.equal(error.code, WatchboundErrorCode.INVALID_ARGUMENT);
        assert.equal(error.operation, "subscribe");
        return true;
      },
    );
    assert.deepEqual(calls, {
      createToken: 0,
      subscribe: 0,
      cancel: 0,
      commit: 0,
    });
  }
});

test("public option accessor failures preserve the exact native baseline", async () => {
  const observer = createEngine();
  const deliveryBefore = nativeBinding.deliveryDiagnostics();
  const runtimeBefore = observer.runtimeStats();

  const failures = ["signal", "watchLimit", "automaticReconciliation"].map(
    (name) => [
      name,
      Object.defineProperty({}, name, {
        enumerable: true,
        get() {
          throw new Error(`${name} getter failed`);
        },
      }),
    ],
  );
  failures.push([
    "ownKeys",
    new Proxy({}, {
      ownKeys() {
        throw new Error("ownKeys failed");
      },
    }),
  ]);

  for (const [name, options] of failures) {
    await assert.rejects(
      publicSubscribe("/tmp", () => {}, options),
      (error) => {
        assert.equal(error instanceof WatchboundError, true);
        assert.equal(error.code, WatchboundErrorCode.INVALID_ARGUMENT);
        assert.equal(error.operation, "subscribe");
        return true;
      },
    );
    assert.deepEqual(observer.runtimeStats(), runtimeBefore);
    assert.deepEqual(nativeBinding.deliveryDiagnostics(), deliveryBefore);
  }

  let automaticReads = 0;
  const oneReadOptions = {};
  Object.defineProperties(oneReadOptions, {
    automaticReconciliation: {
      enumerable: true,
      get() {
        automaticReads += 1;
        return false;
      },
    },
    signal: {
      enumerable: true,
      get() {
        throw new Error("signal getter failed");
      },
    },
  });
  await assert.rejects(
    publicSubscribe("/tmp", () => {}, oneReadOptions),
    (error) => {
      assert.equal(error instanceof WatchboundError, true);
      assert.equal(error.code, WatchboundErrorCode.INVALID_ARGUMENT);
      assert.equal(error.operation, "subscribe");
      return true;
    },
  );
  assert.equal(automaticReads, 1);
  assert.deepEqual(observer.runtimeStats(), runtimeBefore);
  assert.deepEqual(nativeBinding.deliveryDiagnostics(), deliveryBefore);
});

test("strict signal validation rejects malformed compatible-looking objects", async () => {
  const invalidSignals = [
    null,
    {},
    { aborted: "false", addEventListener() {}, removeEventListener() {} },
    { aborted: false, addEventListener: 1, removeEventListener() {} },
    { aborted: false, addEventListener() {}, removeEventListener: 1 },
  ];

  for (const signal of invalidSignals) {
    const { calls, nativeEngine } = createFixture();
    await assert.rejects(
      establish(nativeEngine, { signal }),
      (error) => {
        assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
        assert.equal(error.operation, "subscribe");
        return true;
      },
    );
    assert.equal(calls.createToken, 0);
    assert.equal(calls.subscribe, 0);
  }
});

test("omitting signal preserves the three-argument raw subscribe path", async () => {
  let receivedArguments;
  const provisional = { dispose: async () => {} };
  const { calls, nativeEngine } = createFixture({
    subscribe(...args) {
      receivedArguments = args;
      return provisional;
    },
  });

  assert.equal(
    await establish(nativeEngine, { batchWindowMs: 7 }),
    provisional,
  );
  assert.equal(receivedArguments.length, 3);
  assert.deepEqual(receivedArguments[1], { batchWindowMs: 7 });
  assert.deepEqual(calls, {
    createToken: 0,
    subscribe: 1,
    cancel: 0,
    commit: 0,
  });
});

test("a native AbortSignal satisfies strict establishment validation", async () => {
  const controller = new AbortController();
  const { calls, nativeEngine } = createFixture();
  const subscription = await establish(nativeEngine, {
    signal: controller.signal,
  });

  assert.equal(typeof subscription.dispose, "function");
  assert.equal(calls.createToken, 1);
  assert.equal(calls.commit, 1);
  controller.abort();
  assert.equal(calls.cancel, 0);
});

test("the signal is stripped, its listener is temporary, and success commits once", async () => {
  const signal = new FakeAbortSignal();
  let receivedArguments;
  const provisional = { dispose: async () => {} };
  const { calls, nativeEngine, token } = createFixture({
    subscribe(...args) {
      receivedArguments = args;
      return provisional;
    },
  });

  const publicSubscription = await establish(
    nativeEngine,
    { signal, batchWindowMs: 7, unknownConsumerField: "preserved" },
    (nativeSubscription) => ({ nativeSubscription }),
  );

  assert.deepEqual(publicSubscription, { nativeSubscription: provisional });
  assert.equal(receivedArguments.length, 4);
  assert.equal(receivedArguments[0], "/tmp/watchbound-cancellation-test");
  assert.deepEqual(receivedArguments[1], {
    batchWindowMs: 7,
    unknownConsumerField: "preserved",
  });
  assert.equal(typeof receivedArguments[2], "function");
  assert.equal(receivedArguments[3], token);
  assert.deepEqual(calls, {
    createToken: 1,
    subscribe: 1,
    cancel: 0,
    commit: 1,
  });
  assert.equal(signal.added, 1);
  assert.equal(signal.removed, 1);
  assert.equal(signal.listeners.size, 0);

  signal.abort();
  assert.equal(calls.cancel, 0, "post-success abort must be a no-op");
});

test("throwing listener removal cancels and joins provisional disposal before rejection", async () => {
  const signal = new FakeAbortSignal();
  const disposal = deferred();
  let disposed = 0;
  let removalAttempts = 0;
  signal.removeEventListener = () => {
    removalAttempts += 1;
    throw new Error("removal failed");
  };
  const { calls, nativeEngine } = createFixture({
    subscribe: () => ({
      dispose() {
        disposed += 1;
        return disposal.promise;
      },
    }),
  });
  let settled = false;
  const result = establish(nativeEngine, { signal }).finally(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, 1);
  assert.equal(settled, false, "listener-removal failure must await joined disposal");
  assert.equal(removalAttempts, 1);
  disposal.resolve();

  await assert.rejects(
    result,
    (error) => {
      assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
      assert.equal(error.operation, "subscribe");
      return true;
    },
  );
  assert.equal(calls.cancel, 1);
  assert.equal(calls.commit, 0);
  assert.equal(removalAttempts, 2, "finalization did not retry listener removal");
  assert.equal(signal.listeners.size, 1, "a lying signal cannot be forced to remove its listener");
});

test("native cancellation rejection is normalized and removes the listener", async () => {
  const signal = new FakeAbortSignal();
  const pending = deferred();
  const { calls, nativeEngine } = createFixture({
    subscribe: () => pending.promise,
  });
  const result = establish(nativeEngine, { signal });
  signal.abort();
  pending.reject(cancellationError());

  await assert.rejects(
    result,
    (error) => {
      assert.equal(error instanceof WatchboundError, true);
      assert.equal(error.code, WatchboundErrorCode.OPERATION_CANCELLED);
      assert.equal(error.operation, "subscribe");
      return true;
    },
  );
  assert.equal(calls.cancel, 1);
  assert.equal(calls.commit, 0);
  assert.equal(signal.removed, 1);
});

test("cancellation after provisional native success joins disposal before rejection", async () => {
  const signal = new FakeAbortSignal();
  const disposal = deferred();
  let disposed = 0;
  const provisional = {
    dispose() {
      disposed += 1;
      return disposal.promise;
    },
  };
  const { calls, nativeEngine } = createFixture({
    subscribe() {
      signal.abort();
      return provisional;
    },
    commitPublicSuccess: () => false,
  });
  let settled = false;
  const result = establish(nativeEngine, { signal }).finally(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, 1);
  assert.equal(settled, false, "cancellation must wait for joined native disposal");
  disposal.resolve();
  await assert.rejects(
    result,
    (error) => {
      assert.equal(error.code, "WATCHBOUND_OPERATION_CANCELLED");
      assert.equal(error.operation, "subscribe");
      return true;
    },
  );
  assert.equal(calls.cancel, 1);
  assert.equal(calls.commit, 1);
  assert.equal(signal.removed, 1);
});

test("joined disposal failure supersedes provisional cancellation", async () => {
  const signal = new FakeAbortSignal();
  const disposalFailure = Object.assign(new Error("runtime join failed"), {
    name: "WatchboundError",
    code: "WATCHBOUND_INTERNAL",
    operation: "dispose",
    retryable: false,
  });
  const { nativeEngine } = createFixture({
    subscribe() {
      signal.abort();
      return {
        dispose: async () => {
          throw disposalFailure;
        },
      };
    },
    commitPublicSuccess: () => false,
  });

  await assert.rejects(
    establish(nativeEngine, { signal }),
    (error) => {
      assert.equal(error.code, "WATCHBOUND_INTERNAL");
      assert.equal(error.operation, "dispose");
      return true;
    },
  );
});

test("a malformed native commit result fails closed after joined disposal", async () => {
  const signal = new FakeAbortSignal();
  let disposed = 0;
  const { nativeEngine } = createFixture({
    subscribe: () => ({
      dispose: async () => {
        disposed += 1;
      },
    }),
    commitPublicSuccess: () => undefined,
  });

  await assert.rejects(
    establish(nativeEngine, { signal }),
    (error) => {
      assert.equal(error.code, "WATCHBOUND_INTERNAL");
      assert.equal(error.operation, "subscribe");
      return true;
    },
  );
  assert.equal(disposed, 1);
  assert.equal(signal.removed, 1);
});

test("a thrown native commit failure joins provisional disposal", async () => {
  const signal = new FakeAbortSignal();
  let disposed = 0;
  const { nativeEngine } = createFixture({
    subscribe: () => ({
      dispose: async () => {
        disposed += 1;
      },
    }),
    commitPublicSuccess: () => {
      throw new Error("commit failed");
    },
  });

  await assert.rejects(
    establish(nativeEngine, { signal }),
    (error) => {
      assert.equal(error.code, "WATCHBOUND_INTERNAL");
      assert.equal(error.operation, "subscribe");
      return true;
    },
  );
  assert.equal(disposed, 1);
  assert.equal(signal.removed, 1);
});

test("a post-handoff signal getter failure joins provisional disposal", async () => {
  let reads = 0;
  let disposed = 0;
  const signal = {
    get aborted() {
      reads += 1;
      if (reads >= 4) throw new Error("getter failed");
      return false;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const { calls, nativeEngine } = createFixture({
    subscribe: () => ({
      dispose: async () => {
        disposed += 1;
      },
    }),
  });

  await assert.rejects(
    establish(nativeEngine, { signal }),
    (error) => {
      assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
      assert.equal(error.operation, "subscribe");
      return true;
    },
  );
  assert.equal(disposed, 1);
  assert.equal(calls.commit, 0);
});

test("public wrapper construction failure joins native disposal", async () => {
  const signal = new FakeAbortSignal();
  let disposed = 0;
  const constructionFailure = new Error("wrapper construction failed");
  const { calls, nativeEngine } = createFixture({
    subscribe: () => ({
      dispose: async () => {
        disposed += 1;
      },
    }),
  });

  await assert.rejects(
    establish(nativeEngine, { signal }, () => {
      throw constructionFailure;
    }),
    (error) => {
      assert.equal(error.code, "WATCHBOUND_INTERNAL");
      assert.equal(error.operation, "subscribe");
      assert.equal(error.cause, constructionFailure);
      return true;
    },
  );
  assert.equal(calls.commit, 1);
  assert.equal(disposed, 1);
  assert.equal(signal.removed, 1);
});

test("listener registration failure cancels the unbound token and never subscribes", async () => {
  const signal = new FakeAbortSignal();
  signal.addEventListener = () => {
    throw new Error("registration failed");
  };
  const { calls, nativeEngine } = createFixture();

  await assert.rejects(
    establish(nativeEngine, { signal }),
    (error) => {
      assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
      assert.equal(error.operation, "subscribe");
      return true;
    },
  );
  assert.equal(calls.createToken, 1);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.subscribe, 0);
});

test("side-effecting listener registration failure still removes the retained listener", async () => {
  const signal = new FakeAbortSignal();
  signal.addEventListener = function addThenFail(type, listener, options) {
    FakeAbortSignal.prototype.addEventListener.call(this, type, listener, options);
    throw new Error("registration failed after retaining listener");
  };
  const { calls, nativeEngine } = createFixture();

  await assert.rejects(
    establish(nativeEngine, { signal }),
    (error) => {
      assert.equal(error.code, "WATCHBOUND_INVALID_ARGUMENT");
      assert.equal(error.operation, "subscribe");
      return true;
    },
  );
  assert.equal(calls.cancel, 1);
  assert.equal(calls.subscribe, 0);
  assert.equal(signal.removed, 1);
  assert.equal(signal.listeners.size, 0);
});
