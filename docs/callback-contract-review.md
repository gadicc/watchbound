# Callback contract: review before v1

Status: implemented for the prospective `1.0.0` post-bootstrap candidate on
2026-07-24. This note records the deliberate maintainer review completed before
the v1 release boundary. It is not a publication or Codex Desktop integration
record.

## Implemented decision

- A non-Promise-like callback result completes synchronously without allocating
  a wrapper Promise.
- A Promise-like result retains the subscription's sole native delivery credit
  until fulfillment or rejection. Callbacks for one subscription cannot
  overlap.
- Synchronous throws, throwing `then` access or pre-settlement assimilation,
  and async rejections increment `callbackErrors`; rejection is observed and
  later delivery continues.
- Every callback receives one stable frozen `BatchCallbackContext` with an
  `AbortSignal` and idempotent `stop(): void`.
- Explicit disposal aborts the signal, closes admission, and joins the current
  callback completion. `stop()` requests that disposal without returning its
  promise; a later `subscription.dispose()` joins the same result.
- Environment teardown and subscription GC abandon an outstanding private
  completion ticket. They do not depend on a JavaScript Promise settling.
- Binding API 3 uses an opaque, environment-scoped, exactly-once delivery
  acknowledgement. Capability schema 3 publishes the completion, concurrency,
  error, disposal, and teardown policies.

## Review hazards

1. A callback that never settles makes explicit `dispose()` remain pending
   unless it cooperates with `context.signal`. That is the cost of a truthful
   joined-disposal contract.
2. Awaiting `subscription.dispose()` from the currently admitted callback is a
   self-deadlock. So is awaiting a later callback from the same subscription or
   an `observedState` advance that requires the held credit.
3. Reconciliation, exclusion replacement, and root-recovery acknowledgements
   can complete inside a callback, but any resulting authoritative batch waits
   for callback settlement. Consumer code must not confuse operation
   acknowledgement with callback observation.
4. A callback may enter before `subscribe()` resolves. Early `stop()` is
   latched and the constructed subscription immediately begins disposal.
   The implementation covers this path; a future deterministic wrapper-level
   race seam would make it easier to test directly.
5. `stop()` intentionally suppresses an unhandled rejection from its internal
   disposal request. Calling `subscription.dispose()` later returns the same
   promise and exposes the result to an explicit joiner.

## Delivery/lifecycle release-blocker investigation

The 2026-07-24 qualification investigation separated two unrelated flakes.
Neither was callback loss or an unbalanced product lifecycle.

### Dispatcher-entry readiness

The exact Node 24.18.0
`node/test/fixtures/uv-threadpool-cancellation.cjs` process failed 7 of 200
direct repetitions in the primary reproduction and 55 of 1,000 in an
independent repetition. Every failure reported one active thread-safe function
but zero dispatcher threads while the only libuv worker was blocked.

This was a truthful but previously unsynchronized diagnostic state.
`ensure_dispatcher()` publishes a successfully spawned `JoinHandle` and marks
the internal dispatcher lifecycle `Running`; the spawned thread increments the
process diagnostic only when it later enters its managed body. Thread-safe
function creation can occur between those points. JavaScript immediates have no
happens-before relationship with that Rust OS thread. The unpublished
registration keeps the dispatcher alive, so delayed entry did not lose a batch
or weaken joined cleanup.

The binding now publishes actual dispatcher entry under the environment mutex
after incrementing the entered-thread diagnostic. An unsupported hidden test
seam waits on that condition, and the fixture uses it before retaining its
exact resource assertion. Product establishment still requires only successful
thread creation; the diagnostic still counts only threads that have actually
entered. Timing delays, accepting either zero or one, incrementing the counter
from the spawning thread, and changing synchronous establishment to wait for
OS scheduling were rejected.

### Process-global callback diagnostic

The Rust failure was parallel-test contamination. The node library suite failed
104 of 300 primary repetitions, and the exact workspace command failed 38 of
100 independent repetitions. Each reported test passed 100 of 100 primary
isolated repetitions, while the node library passed 100 of 100 repetitions
with one test thread. Failures occurred both above and below the captured
baseline; paired failures were complementary.

Admission increments both its delivery-local count and the process-global
diagnostic before publishing the pending callback. Failed wakeup rolls both
back. Completion and abandonment share the same in-flight-ID-gated
`finish_delivery()` path, so exactly one contender decrements them. The failing
tests nevertheless captured a process-global baseline while another test could
legitimately enter or leave that interval.

The three unit tests that directly mutate and assert this one global diagnostic
now share a test-only scoped mutex from baseline through balance. Their
delivery-local assertions remain intact, and successful admission additionally
asserts the isolated global `+1` state. No production counter changed and the
rest of the Rust suite remains parallel. Resetting the atomic, weakening
equality, polling for an eventual value, or serializing the entire suite were
rejected.

Post-fix qualification repeated the exact Node fixture in 1,000 fresh
Node 24.18.0 processes and the normally parallel Rust node-library suite in
1,000 fresh test processes with no failures. The deterministic paused-entry
regression, `cargo test --workspace`, the exact Node 24.18.0 node tests,
`pnpm test`, `pnpm check`, and the ordinary 25-cycle `pnpm test:soak` gate also
passed. No forced-overflow, benchmark-recording, publication, or consumer
integration command was run.

## Deliberately deferred

- No Watchbound-owned detached callback mode. Consumer-owned fire-and-forget
  work remains outside Watchbound's ordering, bounds, diagnostics, and
  disposal contract.
- No configurable callback concurrency greater than one.
- No public acknowledgement/defer protocol.
- No AsyncIterable or pull API.
- No separate observer/processor callback APIs.

Those are possible later additions, but each creates a larger compatibility
surface and needs its own boundedness and lifecycle design.

## Release follow-up

- Exercise the callback model in a separately authorized real consumer pilot
  before calling the API v1-stable. In particular, test cancellation
  cooperation and operation calls made from callbacks.
- The public `0.0.1` bootstrap provides an earlier 0.x line but does not contain
  this callback contract. The prospective v1 wrapper/native/engine versions are
  committed in lockstep; the exact status-bearing commit must still obtain
  clean target-host evidence. Do not infer qualification from a local
  development run.
- Re-run final conformance and performance trials only on a confirmed quiet,
  prepared host. Forced-overflow evidence remains separately supervised.
- Revisit whether `PromiseLike<unknown>` should narrow to `PromiseLike<void>`
  at the v1 line. The current spelling intentionally ignores fulfillment
  values while the callable union preserves common expression callbacks such
  as `batch => batches.push(batch)`.
