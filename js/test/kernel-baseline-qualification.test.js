import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCleanQemuCompletion,
} from "../../scripts/kernel-baseline-qualification-helpers.mjs";

test("kernel baseline accepts evidence only after a clean QEMU exit", () => {
  assert.doesNotThrow(() =>
    assertCleanQemuCompletion({
      error: undefined,
      status: 0,
      signal: null,
    }));

  assert.throws(
    () =>
      assertCleanQemuCompletion({
        error: undefined,
        status: 1,
        signal: null,
      }),
    /QEMU did not exit cleanly \(status=1, signal=null\)/u,
  );

  assert.throws(
    () =>
      assertCleanQemuCompletion({
        error: undefined,
        status: null,
        signal: "SIGABRT",
      }),
    /QEMU did not exit cleanly \(status=null, signal=SIGABRT\)/u,
  );
});

test("kernel baseline preserves QEMU spawn failures", () => {
  const failure = new Error("QEMU could not start");
  assert.throws(
    () =>
      assertCleanQemuCompletion({
        error: failure,
        status: null,
        signal: null,
      }),
    (error) => error === failure,
  );
});
