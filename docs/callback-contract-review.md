# Callback contract: review before v1

Status: implemented for the maintained unpublished candidate on 2026-07-24.
This note records the decisions that deserve a deliberate maintainer review
before a v1 release. It is not a publication or Codex Desktop integration
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
- Ship it in a 0.x candidate first, with wrapper/native/engine versions moved in
  lockstep and clean target-host evidence. Do not infer qualification from the
  local development run.
- Re-run final conformance and performance trials only on a confirmed quiet,
  prepared host. Forced-overflow evidence remains separately supervised.
- Revisit whether `PromiseLike<unknown>` should narrow to `PromiseLike<void>`
  at the v1 line. The current spelling intentionally ignores fulfillment
  values while the callable union preserves common expression callbacks such
  as `batch => batches.push(batch)`.
