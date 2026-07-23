# Cancellable establishment and shared native delivery

Status: implementation complete; both adversarial reviews and the final
independent audit have been applied; final serial verification passed. The
first review stopped the initial design because its proposed `QueueFull` retry,
environment identity, dispatcher ownership, and global reaper were not safe.
Those designs are replaced below. The second review stopped the first
implementation until its code-level fairness, bounded-cleanup, pending-attempt,
and joined-thread races were fixed.

This plan covers two coupled private-API `0.x` changes:

1. cancelling a subscription attempt after native establishment work has
   started; and
2. replacing one `watchbound-node-bridge` OS thread per subscription with
   bounded, fair, per-Node-environment dispatch.

It does not authorize Codex integration, package publication, prebuilds,
artifact upload, forced overflow, benchmark execution, or benchmark-result
replacement.

## Pre-change lifecycle trace

This is the baseline trace that motivated the change. The selected design and
implementation sections below supersede its bridge/reaper ownership.

### JavaScript thread

- `js/index.js::subscribeWithEngine` validates the root, callback, options, and
  automatic-reconciliation policy, preserves the lexical root spelling, creates
  a weak callback holder, and calls `NativeEngine::subscribe`.
- `node/src/lib.rs::prepare_subscribe` resolves a relative root synchronously,
  validates numeric options, creates a one-entry Node-API thread-safe function,
  creates the shutdown gate, and adds a weak registration to the one cleanup
  hook for that `napi_env`.
- napi-rs queues `SubscribeTask` as libuv async work. Its `resolve` or error
  conversion settles the native Promise on this thread.
- Thread-safe-function callbacks convert the batch, advance wrapper
  `observedState`, run automatic policy observation, and then invoke user code.
  A callback may enter before the wrapper subscribe Promise resolves.
- Explicit exclusion replacement, reconciliation, root recovery, and disposal
  each create a napi-rs async task. Native object finalization invokes Rust
  `Drop`; the baseline created a reaper thread when cleanup was unfinished.

### Node shared libuv worker pool

- `SubscribeTask::compute` calls synchronous `Engine::subscribe`, occupying one
  libuv worker until root validation, runtime acquisition, initial traversal,
  watch allocation, final validation, and the runtime acknowledgement finish.
- After acknowledgement it starts `watchbound-node-bridge`, then returns an
  `Arc<SubscriptionState>` for Promise resolution.
- Exclusion replacement, reconciliation, root recovery, and explicit disposal
  also occupy one libuv worker while waiting on their runtime acknowledgement
  and any required join.

### `watchbound-linux-runtime`

- The first provisional runtime lease creates one inotify fd, one eventfd, and
  one process-wide worker.
- `Command::Subscribe` allocates a subscription ID, records a pending
  establishment, and schedules bounded breadth-first topology turns.
- The worker owns all descriptor interests, watches, deferred interests,
  topology jobs, exclusions, recovery state, coverage, sequence numbers, and
  bounded engine output senders.
- `finish_topology_job` performs final identity validation, publishes gauges,
  and sends the establishment acknowledgement.
- Exclusion replacement, reconciliation, and recovery use the same bounded
  subscription-local topology scheduler and acknowledgement mechanism.
- Disposal removes logical interests, pending topology/operation state, and
  output admission before acknowledgement. Releasing the final lease sends
  shutdown and joins the worker.

### `watchbound-node-bridge`

- Every established subscription moves its engine `Subscription` into one
  dedicated bridge thread.
- That thread polls the bounded engine receiver, increments callback admission,
  and makes a blocking call into a one-entry thread-safe-function queue.
- On shutdown or bridge failure it disposes the engine subscription. Explicit
  disposal joins the bridge, waits for admitted callbacks, releases the
  thread-safe function and cleanup registration, and settles once.

### GC reaper and environment teardown

- Dropping an unfinished `NativeSubscription` signals its shutdown gate and
  starts one `watchbound-node-reaper` thread for that object. Concurrent GC
  churn can therefore create linearly many transient reaper threads.
- The one cleanup hook per `napi_env` removes that environment's weak
  registrations and signals every still-live shutdown gate. It does not wait
  for JavaScript callbacks. Bridge/reaper cleanup subsequently removes native
  state.

## Observable contracts in scope

The following are compatibility-sensitive and must either stay byte-for-byte
equivalent or be called out as private-minor changes:

- wrapper and raw Node subscribe signatures;
- option validation, lexical root capture, and exact path bytes;
- Promise resolution/rejection and callback-before-resolution behavior;
- structured error codes, operation, retryability, and bounded diagnostics;
- `initialCoverage`, `initialRootState`, ordered batches, `observedState`, live
  root/exclusion getters, and operation-result lead;
- subscription-local sequence, exclusion generation, root generation, root
  attachment/loss evidence, and coverage ordering;
- callback exception and native delivery error accounting;
- engine and subscription statistics;
- capabilities and their schema version;
- explicit disposal, repeated/concurrent disposal, GC cleanup, and environment
  teardown;
- process runtime configuration/lease behavior; and
- the frozen private `0.x` compatibility policy.

Adding `signal`, a cancellation error code, cancellation capability metadata,
and a changed raw binding signature requires a lockstep private minor. The
planned version is `0.2.0`. The binding API version becomes 2. Capability
schema 2 adds cancellable-establishment and shared-delivery facts; the loader
metadata schema remains independently versioned and need not change merely
because capability schema changes.

## Selected cancellation API

### Wrapper

`SubscriptionOptions` gains:

```ts
signal?: AbortSignal;
```

It is establishment-only. The wrapper validates an AbortSignal-compatible
object by identity/behavior, checks `signal.aborted` after all pure argument
validation but before native resource creation, and registers one temporary
`abort` listener. Removal is attempted on every terminal path and succeeds for
a conforming signal; a malformed structural substitute cannot replace the
authoritative result by throwing or lying during removal.

An already-aborted valid request rejects with:

```text
name       WatchboundError
code       WATCHBOUND_OPERATION_CANCELLED
operation  subscribe
retryable  false
retryAfter undefined
```

The same exact error is used when cancellation wins later. Human text is
bounded and never used for policy.

### Raw Node and engine

The raw shape is deliberately explicit so the wrapper owns the cancellation
object before async work can be queued:

```text
token = nativeEngine.createEstablishmentCancellation()
promise = nativeEngine.subscribe(root, nativeOptions, callback, token)
token.cancel()
```

The module-level `subscribe` has the same optional final token argument and a
module-level token factory. Calls without a token remain valid. The wrapper
creates a token only after pure argument validation, registers its temporary
AbortSignal listener, strips `signal` from `nativeOptions`, and passes the token
to the native call. The token is single-bind and attempt-scoped. Binding it to
a second subscribe fails synchronously with `WATCHBOUND_INVALID_ARGUMENT`;
`cancel()` is allocation-free and idempotent.

Rust gains an attempt-scoped `EstablishmentCancellation` token and a split
operation:

```text
Engine::begin_subscribe(...) -> PendingSubscription
PendingSubscription::cancellation_handle()
PendingSubscription::wait() -> Result<Subscription>
```

Existing `Engine::subscribe` delegates through this path with an uncancelled
token, preserving Rust source behavior for callers that do not opt in. The
attempt control contains a checked, globally monotonic ID, fixed-size atomic
terminal state, and an optional weak reference to the exact runtime wakeup.
Cancellation never enqueues a command, closure, Promise, or traversal item.

The raw Node subscribe surface accepts the attempt token as an optional final
argument. The hand-owned declarations expose the token shape because the raw
Node package is the wrapper boundary, even though it is not a separately
supported consumer package.

The design deliberately does not depend on `AsyncTask::with_signal`. napi-rs
can ask Node-API to cancel queued work, but Node-API cannot cancel work after
`Task::compute` starts, and napi-rs's queued cancellation rejects with a generic
`AbortError`. One cooperative token provides the same structured terminal
result at every native phase. Establishment continues to occupy one libuv pool
slot from `compute` entry through rollback/acknowledgement. This avoids a second
cancel task and therefore avoids `UV_THREADPOOL_SIZE=1` self-deadlock.

Queued libuv work observes the already-cancelled token before filesystem or
runtime admission when its worker turn begins. Its Promise cannot finish until
the queued task receives that turn, so unrelated work ahead of it can delay
settlement. This retained libuv contention is an explicit limitation and is
tested.

Only Watchbound's internal observation/bookkeeping is bounded. A token whose
work command is already admitted is observed through the capacity-64 work lane
and its fixed 16-command turns; once the subscription state is runnable,
topology checks cancellation at bounded traversal points. Teardown then
consumes fixed work quanta. Wall-clock settlement is intentionally not claimed
to be bounded. It may wait for libuv scheduling, an in-progress filesystem
syscall, an already-admitted user callback, and final runtime shutdown/join.
The `UV_THREADPOOL_SIZE=1` test therefore uses an isolated child and
deterministic blocker/release handshake rather than a timing assertion.

## Cancellation state machine and precedence

There are two deliberately separate arbiters and exactly one public terminal
result.

The engine attempt control has:

```text
Created -> Bound -> Queued -> Admitted -> Cleaning -> Cancelled
                              |          -> Failed
                              `-> Succeeded
```

`Created -> Bound` is a checked single bind. An atomic cancel-request bit may be
set in any nonterminal state, but only the Linux worker commits
`Admitted -> Cleaning|Succeeded`; failure and cancellation acknowledgements are
sent only after cleanup. An acknowledgement sender is retained through
rollback. If its receiver disappears, success is converted into worker-owned
cleanup rather than leaving an ownerless subscription.

The Node attempt record has:

```text
Unbound -> PendingEngine -> EngineSucceededProvisional
        -> NodeReadyProvisional -> PublicCommitted

any provisional state -> Cancelling -> TerminalError
any provisional state -> EnvironmentClosing -> TerminalError
```

One mutex/CAS-protected transition owns each edge. The native task may return a
provisional subscription, but the wrapper calls the token's synchronous
`commitPublicSuccess()` immediately before returning it. That call wins only
from `NodeReadyProvisional`. It returns `false` when cancellation already won;
the wrapper then owns and joins `nativeSubscription.dispose()` before throwing
the stored cancellation error. Once `PublicCommitted` is set, later `cancel()`
and signal delivery are no-ops. The wrapper attempts AbortSignal listener
removal in `finally`; a conforming signal removes it, while a malformed
structural substitute cannot replace the authoritative result by throwing or
lying during removal. Listener registration failure synchronously
cancels/unbinds the token and allocates no native resources.

The public linearization rules are:

1. Pure JavaScript representation errors win before cancellation is consulted.
2. Environment teardown wins over user cancellation because no JavaScript
   settlement can safely be required from a closing environment. It returns or
   records `WATCHBOUND_OPERATION_INTERRUPTED` where a Promise can still settle.
3. Before native success, whichever of cancellation or establishment failure
   the Linux-worker terminal CAS commits first wins. A final check attempts the
   success CAS immediately before handing off ownership. Failure/cancellation
   acknowledgement follows bounded rollback, never precedes it.
4. Native acknowledgement is provisional with respect to the public wrapper
   Promise. Cancellation observed after acknowledgement, during dispatcher
   registration, or before `commitPublicSuccess()` triggers joined disposal
   and then rejects with
   `WATCHBOUND_OPERATION_CANCELLED`.
5. A callback may enter before cancellation wins, matching the existing
   callback-before-resolution contract. Cancellation does not settle until
   dispatcher admission is closed, native disposal is joined, and every
   already-admitted callback has finished. No callback can newly enter after
   rejection.
6. Once the public subscribe Promise has resolved, success is terminal.
   Aborting that establishment signal afterward is a no-op; callers use
   `subscription.dispose()` for an established subscription.
7. Repeated cancellation is idempotent and creates no additional native work,
   acknowledgement, Promise, or cleanup job.
8. Cleanup failure is not hidden as successful cancellation. Runtime release
   and final worker join errors are propagated and supersede cancellation. The
   current path that discards `release_runtime` errors after failed
   establishment is removed. An invariant or join failure surfaces its exact
   stronger structured error, with the original cancellation retained only as
   bounded diagnostic context if representable.

Cancellation checks occur:

- after pure option validation and before root filesystem access;
- before and after root ancestry/metadata validation;
- before runtime lease acquisition;
- while waiting for bounded runtime command admission;
- when the worker receives the subscribe command;
- before and after root identity capture;
- at each bounded topology turn and within its bounded entry loop;
- after sharing or allocating a native watch;
- before final root validation;
- immediately before acknowledgement;
- immediately after acknowledgement on the libuv worker;
- before and after per-environment dispatcher registration; and
- in the wrapper before public Promise success.

If cancellation wins, worker-owned cleanup progresses in round-robin fixed
quanta through:

```text
StopAdmission
InterruptTransactions
RemoveWatchedInterests
DrainDeferredMap
DrainDeferredOrder
DrainPromotions
DrainTopologyJobs
DropOutputAndState
PublishCounters
AcknowledgeTerminal
```

Each collection and each nested topology-directory queue is drained explicitly;
dropping a large container is not hidden in one turn. Closing state rejects
new events/topology. `remove_interest` preserves peer interests and removes a
native watch only when its final logical interest disappears. Teardown attempts
share a round-robin runnable queue with topology work, so a large rollback
cannot monopolize peer delivery.

Node cleanup subsequently removes callback, environment, and dispatcher
registration. The provisional runtime lease is released only after worker
rollback acknowledgement. A final provisional lease performs joined runtime
shutdown and restores the inactive zero baseline.

Subscription IDs and attempt IDs use checked monotonic allocation. Exhaustion
fails closed; `saturating_add` is removed and a live map entry is never
overwritten. Environment IDs are process-global monotonic generations.
Dispatcher registration IDs are checked and scoped to one retained environment
record. Inotify watch descriptors retain their existing lifetime-generation
defence.

The process runtime replaces its unbounded command channel with two bounded
FIFO lanes: a capacity-64 control lane for disposal, reconciliation, recovery,
and shutdown, and a capacity-64 work lane for subscription admission. Every
successful send wakes the existing eventfd. The worker takes at most a fixed
control quantum and a fixed work quantum per scheduler turn, so neither lane
starves. Subscribe uses `try_send` plus the cancellation bit and a bounded
park/poll fallback; the other operations may block their existing libuv worker
until FIFO capacity is available. Cancellation is out-of-band, so a full work
lane cannot prevent it. Every admitted envelope retains exactly one bounded
acknowledgement sender until success or joined rollback; failed acknowledgement
delivery triggers rollback.

## Shared-delivery alternatives

### One process-wide Rust dispatcher

Advantages: one delivery thread for every environment and subscription.

Rejected for this milestone: it creates a process-wide failure and
head-of-line domain across independent `napi_env` values. Environment teardown,
one slow cleanup, or an accidental blocking Node-API call could affect every
Worker. It also complicates correct per-environment Node-API resource release.

### One dispatcher per Node environment

Advantages: Node-API resources and failure domains match `napi_env`; a closing
Worker cannot stop another Worker's dispatcher; same-environment subscriptions
share one thread; fairness can be explicit.

Selected.

### Direct libuv async handle

Advantages: no Rust delivery thread.

Rejected for now: napi-rs intentionally keeps this binding on portable
Node-API rather than direct libuv/V8 APIs. A custom async handle would add
environment ownership and teardown FFI at exactly the riskiest boundary.

### Direct nonblocking thread-safe-function admission from the filesystem worker

Advantages: no additional dispatcher thread.

Rejected: Node callback pressure or Node-API teardown would run in the
process-wide filesystem scheduler's failure domain. Even nonblocking calls add
representation/admission work to the thread that must preserve filesystem peer
fairness. Delivery remains a Node-layer responsibility.

## Selected shared-delivery design

Each active Node environment owns at most one
`watchbound-node-dispatcher` thread. Every subscription retains its own:

- bounded engine output channel;
- one-entry thread-safe-function queue;
- one callback-admission credit;
- callback admission gate/tracker;
- callback and delivery-error counters;
- shutdown/environment state; and
- native subscription/cleanup result.

Raw `napi_env` is lookup-only, never identity. The first registration allocates
a process-global checked `EnvironmentId` and an `Arc<EnvironmentRecord>`.
Registrations and the cleanup-hook payload retain that exact record/generation.
The hook removes the raw-pointer lookup only if it still points to that Arc, so
pointer reuse cannot target a later environment. The environment lifecycle is:

```text
Starting -> Running -> Closing
    `------> Failed
```

Its dispatcher separately follows
`Stopped -> Starting -> Running -> Stopping -> Stopped` and can restart within
the same live environment generation. Registration versus final removal is
serialized by the environment record, but no global/environment registry lock
is held across thread creation, a Node-API call, callback wait, engine
operation, or join. Concurrent first registrations share the same environment
startup and dispatcher result; a registration racing dispatcher stop waits for
that exact handle to join before a replacement starts. The cleanup hook closes
the environment admission barrier, detaches the exact generation, signals all
gates, and wakes native cleanup; it does not wait or join.

The dispatcher uses an ordered live-registration map and frozen high-water
rounds. Each turn inspects at most `K=64` total registrations and performs at
most one `Subscription::try_recv` for each selected active registration.
Completion, registration, removal, and shutdown notify one condition variable;
a 5 ms bounded poll fallback covers engine receivers, which have no readiness
handle. A round freezes the greatest registration ID present when it begins;
newer IDs wait for the next round and therefore cannot starve an older quiet
peer. That peer is inspected within
`ceil(registrations-at-round-start / K)` turns. Removal simply shortens the
round. No ready-ID queue exists and therefore duplicate readiness cannot
accumulate.

Admission credit, not `QueueFull`, is the flow-control mechanism:

- a registration begins with one credit;
- while it lacks credit, the dispatcher does not receive from its engine queue;
- under the subscription admission mutex and the environment admission barrier,
  the dispatcher rechecks shutdown, consumes the credit, increments
  `outstandingCallbacks`, and performs exactly one blocking-mode call to the
  one-entry thread-safe function;
- the call is expected not to block on JavaScript execution: the sole producer
  has proved the Node queue empty by owning the sole credit;
- callback completion decrements `outstandingCallbacks`, records only a
  callback exception in `callbackErrors`, restores the credit, and wakes the
  dispatcher;
- the bounded engine output queue remains the only staging queue and applies
  subscription-local `consumer-backpressure` uncertainty if pressure
  continues.

The initial proposal to retry napi-rs nonblocking calls was rejected. napi-rs
3.10.5 boxes call data before Node-API and does not recover it from
`QueueFull`; retrying could leak without bound. The revised dispatcher never
uses `QueueFull` as flow control, never holds a pending batch, and has exactly
one TSFN producer. Environment teardown takes the same admission barrier before
marking `Closing`, so a call either enters while the environment is valid or
does not start. An unexpected non-OK status is a one-shot terminal invariant
failure: accounting is rolled back once, `bridgeDeliveryErrors` increments
once, the exact `deliver-batch` error is stored for every disposer, admission
closes, and cleanup is requested. No retry occurs. Tests instrument allocation
and credit balance for success, the impossible-`QueueFull` guard, closing, and
callback completion.

To avoid relying on napi-rs's non-OK payload ownership, the actual call payload
is held in the registration's single callback slot and the TSFN wake carries no
owned batch allocation. The JavaScript callback atomically takes that slot
while completing the admission. If the environment closes after an accepted
wake, the environment-closing cleanup path owns and drops the slot without
requiring JavaScript. TSFN abort/release occurs only after the dispatcher has
left the registration and the environment barrier is closed. Thus null-env
draining owns no per-call Rust allocation.

A dispatcher-detected error only stores the error, closes that registration,
wakes the environment cleanup coordinator, and returns to/then exits its loop;
it never performs blocking engine disposal and never joins itself.

One JavaScript thread cannot execute a peer callback concurrently while user
code synchronously blocks that same event loop. The guarantee is instead that
native dispatcher admission, engine delivery, and other environments continue;
after the JavaScript thread unblocks, subscription-local order is retained.
Separate Node Worker environments can make callback progress concurrently.

Normal named Watchbound thread counts become:

| State | Before | After |
| --- | ---: | ---: |
| no subscriptions | 0 | 0 |
| one subscription in one environment | 2 | 2 |
| N subscriptions in one environment | N + 1 | 2 |
| N established subscriptions across E environments | N + 1 | E + 1 |
| pending attempts across E environments | 0 or 1 runtime | E dispatchers plus 0 or 1 runtime |
| GC/live-environment cleanup across E affected environments | up to N reapers | at most one retained dispatcher and one transient coordinator per environment |

The counts are the one process-wide Linux runtime plus delivery threads. libuv
pool threads are Node-owned and not counted as Watchbound long-lived threads.

## Disposal, teardown, and GC

Explicit disposal:

1. atomically closes subscription delivery admission;
2. marks its environment registration inactive; an already-selected
   dispatcher visit is harmless because it must recheck the closed admission
   barrier;
3. joins engine disposal and a possible final runtime shutdown;
4. waits for already-admitted callbacks unless the environment is closing;
5. releases the thread-safe function and cleanup registration;
6. requests dispatcher stop and joins it from the disposing libuv thread if
   this was the final registration; and
7. publishes one stored terminal cleanup result to every concurrent caller.

The subscription admission mutex plus the environment admission barrier are the
callback linearization barriers. Dispatcher code rechecks both while holding
them. Once disposal passes the subscription barrier, no new callback wake can
be admitted. Once environment teardown passes its barrier, no new Node-API
call can start for that generation.

Environment teardown marks every registration as environment-closing, cancels
pending establishments, closes dispatcher admission, and requests native
cleanup without waiting for JavaScript callbacks. Accepted callback slots are
dropped by the environment-closing path. The environment barrier makes
Node-API admission quiescent before TSFNs are aborted/released; an
already-selected dispatcher visit can only observe closing and return. The
last cleanup stops that environment's dispatcher. Another environment's
registry, thread-safe functions, subscriptions, and callbacks are untouched.

GC cleanup no longer starts one reaper per object or one process-wide serial
reaper. Each `EnvironmentRecord` owns a deduplicated cleanup table with at most
one pre-existing entry per live/provisional registration and at most one
transient `watchbound-node-cleanup` coordinator. Finalization, terminal
delivery failure, or environment teardown marks the existing entry requested
and wakes it; no new per-request node/closure is allocated.

The coordinator uses bounded selection and a phased per-registration state
machine. A turn:

1. closes/unregisters one requested registration;
2. requests/joins its engine cleanup;
3. if the environment is live and callbacks remain, parks that registration
   back in its fixed table and advances to a peer rather than waiting;
4. if closing, skips JavaScript callback waiting and owns the accepted slot;
5. releases TSFN/environment registration when safe; and
6. records the terminal result once.

It inspects at most 64 registrations per turn using the same frozen-round
rule. Callback-quiescence polling yields to peers. An established engine
disposal removes at most 64 stored items per runtime scheduler turn, suppresses
new event, topology, promotion, and maintenance work for that subscription,
and yields to runnable peers between turns. After worker acknowledgement closes
the output sender, the calling cleanup path destroys queued batches and each
owned path in separate 64-item quanta, yielding between quanta before final
runtime release. The Node coordinator still waits for the joined engine result
before advancing that registration, so one large cleanup can delay later
cleanup in the same environment without monopolizing the engine runtime. It
cannot block another environment's coordinator, and the separate dispatcher
continues native-to-Node delivery. Final runtime shutdown uses the worker
disposal quanta and drains residual ignored-lifetime and exhausted-descriptor
registries before acknowledging shutdown. The coordinator exits after its
bounded table has no requested work; actual thread start/exit update
diagnostics. Explicit disposal owns its own libuv task and never starts the
coordinator. If coordinator creation or joining fails, the already-retained
dispatcher is the exceptional cleanup fallback and records that stronger
coordination error. Neither thread joins itself or holds registry/admission
locks across engine waits, callback waits, or joins.

## Boundedness and fairness invariants

- Runtime commands use the two finite FIFO lanes described above. Cancellable
  work admission retries `try_send` with a cancellation check and bounded park;
  no command is silently dropped and control work cannot be starved by new
  subscriptions.
- Engine topology work retains the existing fixed command/native/topology/
  allocator turn limits.
- Cancellation state and diagnostics are fixed-size per attempt.
- Each subscription has a bounded engine queue, bounded batch, one-entry Node
  callback queue, and one admission credit. There is no dispatcher pending
  batch queue.
- Dispatcher work per turn and per registration is fixed.
- Registries contain at most one preallocated record per live/pending object;
  no event, callback, closure, Promise, retry, readiness ID, or cleanup history
  is accumulated.
- A full subscription queue cannot block dispatcher inspection of a peer.
- Native inotify overflow remains shared-stream uncertainty; consumer callback
  pressure remains subscription-local.
- Ordered batches remain authoritative. The dispatcher does not rewrite
  sequence, generation, root state, coverage, or path bytes.
- `observedState` still advances immediately before wrapper policy/user callback
  entry and never from an acknowledgement.

## Test-first seams and cases

Implementation begins with deterministic failing tests.

### Engine cancellation

Add engine-unit `EstablishmentBarrier` hooks, modelled on the root-recovery
barrier hook, at admission/root capture, shared-watch attachment, before and
after unique watch allocation, several traversal points, final validation,
terminal CAS, teardown phases, lease release, and acknowledgement. Hooks used
for peer-fairness tests mark/yield the attempt rather than blocking the only
Linux worker. Blocking hooks are confined to narrow syscall-race tests and have
watchdogs.

These hooks are `#[cfg(test)]` and therefore prove engine behavior only. Node
settlement/registration races use a private fake-native wrapper harness. If a
release-addon integration barrier is later needed, it requires an explicit
test feature/build lane; this plan does not pretend Rust unit hooks exist in
the normal release addon.

Tests cover:

- already-cancelled token before runtime admission;
- cancellation while bounded command admission is waiting;
- cancellation at each traversal/watch/validation barrier;
- unique watch rollback and shared peer-watch retention;
- final acknowledgement race with exactly one terminal result;
- repeated cancellation;
- cancellation after engine success but before Node public handoff as joined
  Node-owned disposal; a generic Rust caller's established subscription is not
  retroactively cancelled;
- final provisional lease returning exact runtime counters/descriptors/worker
  to the inactive baseline;
- peer delivery and truthful coverage throughout;
- watch-limit/runtime-budget partial paths;
- root loss, symlink ancestry, permission/filesystem failure precedence; and
- checked subscription/attempt ID exhaustion without reuse.

### Node cancellation and dispatch

Separate pure Rust dispatcher scheduling from Node-API admission behind a small
internal sink so unit tests can deterministically exercise success, the
impossible-queue-full invariant guard, closing, callback-error completion, and
delivery failure without invoking an invalid environment.

Tests cover:

- fixed round-robin work and one admission credit per subscription;
- a hot/full subscription while a quiet peer advances;
- callback and delivery-error accounting;
- sequence/generation/root/coverage payload preservation;
- one, many, and churned registrations with one dispatcher thread;
- exact dispatcher lifecycle under simultaneous first/final registration,
  self-cleanup errors, and churn;
- final dispatcher/registration/callback/cleanup-coordinator counters at zero
  only after actual thread exit/join;
- deterministic engine barriers for cancellation before and after runtime
  admission, raw provisional cancellation after engine acknowledgement, and
  fake-native public handoff/settlement tests for the adjacent wrapper states;
- code-ordering and resource-baseline coverage for dispatcher registration and
  pending-attempt cleanup, without claiming a release-addon barrier that pins
  cancellation to one instruction inside dispatcher attachment;
- observed-state bookkeeping when a callback precedes resolution, plus no new
  callback after cancellation/disposal; the production-addon suite does not
  deterministically force actual callback entry before the subscribe Promise;
- environment teardown during pending and established states;
- two live Worker environments, destruction of one, peer progress in the other,
  and a later fresh environment;
- GC churn with at most one coordinator per environment and one deduplicated
  table entry per live registration; and
- a child process with `UV_THREADPOOL_SIZE=1`, proving cancellation needs no
  second worker while documenting that queued work settles only after the sole
  worker becomes available.

Expose raw, private delivery diagnostics for tests:

```text
dispatcherEnvironments
dispatcherThreads
registrations
outstandingCallbacks
cleanupCoordinatorThreads
cleanupRequests
activeThreadsafeFunctions
environmentGenerations
```

They are process counters, not filesystem coverage and not a replacement for
`Engine::runtimeStats`.

### Wrapper and types

Tests cover strict AbortSignal behavior (`aborted`, callable
`addEventListener`/`removeEventListener`, and no direct napi-rs signal
conversion), already-aborted input before token/native allocation, listener
registration and attempted removal on every terminal path (with exact removal
for a conforming signal), stripping `signal` from native options, repeated
abort, mid-establishment abort, exact cancellation errors, post-success abort
as a no-op, joined cancellation, no callback after rejection, raw token
single-bind/reuse failure, and exhaustive TypeScript acceptance/rejection.
Existing observed-state, automatic policy, exact-byte,
error normalization, and disposal tests remain unchanged in meaning.

### Harness and conformance

Update the ordinary reconciliation harness assertion that currently hard-codes
`threadsAtStart + 3` for one runtime plus two bridge threads. It must assert one
runtime plus one environment dispatcher for two same-environment
subscriptions, while retaining peer progress and exact final restoration.

Add ordinary strict Watchbound scenarios for cancellable establishment and
shared delivery only if they can stay deterministic and non-heavy. Do not use
forced overflow as evidence for either feature.

## Likely files

- `engine/src/lib.rs`
- `engine/src/error.rs`
- `engine/src/backend/linux.rs`
- `engine/tests/shared_runtime.rs`
- relevant focused engine test modules
- `node/src/lib.rs`
- `node/index.d.ts`
- `node/test/lifecycle.cjs`
- `node/test/environment-teardown.cjs` and Worker fixtures
- new Node child/Worker fixtures
- `js/index.js`
- `js/index.d.ts`
- `js/errors.js`
- `js/capabilities.js`
- `js/test/wrapper.test.js`
- `js/test/engine.test.js`
- `js/test/errors.test.js`
- `js/test/types/consumer.ts`
- `benches/lib/scenarios.mjs` and focused harness tests
- `Cargo.toml`, `Cargo.lock`, package manifests, and lockfile for lockstep
  `0.2.0`
- `README.md`
- `docs/architecture.md`
- `docs/api-lifecycle.md`
- `docs/node-binding.md`
- `docs/private-api-freeze.md`
- `docs/error-contract.md`
- `docs/security-threat-model.md` if its bounded lifecycle inventory changes
- `docs/maintenance-policy.md` only where the ordinary gate/version statement
  needs updating

## Migration and rollback boundaries

- Existing calls without `signal` keep their signature behavior and lifecycle.
  Rust `Engine::subscribe` remains available.
- Engine, native addon, and wrapper versions move together to `0.2.0`.
  `BINDING_API_VERSION` becomes 2; capability schema becomes 2; loader metadata
  schema remains 1. Loader/package-contract tests pin that exact combination.
- `WATCHBOUND_OPERATION_CANCELLED` is added to the closed error-code union with
  operation `subscribe`, `retryable: false`, and no retry-after. Error docs,
  JavaScript normalization, and exhaustive TypeScript fixtures change
  lockstep.
- Capability schema 2 reports establishment cancellation, shared
  per-environment delivery, callback queue capacity 1, dispatcher work quantum,
  and environment-scoped thread behavior without reinterpreting
  `RuntimeStats.workerThreads`.
- The `0.2.0` source candidate starts as `target-pending-clean-ci`; it does not
  inherit `supported` from the exact qualified `0.1.0` commit. Qualification is
  a later maintenance decision, not part of this implementation.
- Consumers that exhaustively switch on error codes or capability schema must
  update for private `0.2.0`; version/API/schema mismatches continue to fail
  closed.
- Subscription and batch objects do not change shape.
- Engine cancellation is introduced first behind tests and can be rolled back
  independently before exposing `signal`.
- The Node dispatcher is a representation/lifecycle replacement behind the
  same subscription methods and counters. It can be reverted independently
  while retaining engine cancellation.
- Capability/version exposure and README comparison change only after both
  implementations pass focused lifecycle tests.
- A rollback must never retain public cancellation metadata while reverting the
  cleanup semantics, nor advertise shared delivery while restoring per-
  subscription bridge threads.

## Verification

Focused tests run while iterating. Final gates, serial where applicable:

```sh
pnpm build:node
pnpm test
pnpm check
pnpm test:soak
pnpm test:reconciliation-stress
pnpm test:root-recovery-stress
node benches/conformance.mjs --adapter watchbound --scenario bridge-backpressure --quick --strict --pretty
node benches/conformance.mjs --adapter watchbound --scenario disposal --quick --strict --pretty
node benches/conformance.mjs --adapter watchbound --scenario reconciliation --quick --strict --pretty
node benches/conformance.mjs --adapter watchbound --scenario automatic-reconciliation --quick --strict --pretty
node benches/conformance.mjs --adapter watchbound --scenario root-replacement-recovery --quick --strict --pretty
```

Any new ordinary cancellation/shared-delivery strict scenario is also run
serially. No command containing `--allow-forced-overflow`, no benchmark command,
and no result-file replacement is permitted.

## Adversarial review

The first review's verdict was **stop**. The following findings were actionable
and are design gates:

1. **Unsafe `QueueFull` retry (P0).** napi-rs 3.10.5 transfers a boxed payload
   before its nonblocking call and does not recover it on `QueueFull`/closing;
   its null-environment callback path can also skip destruction. The proposed
   `Arc<ChangeBatch>` retry could leak without bound. **Resolution:** no retry,
   no pending batch, one explicit credit, one static raw wake/no owned call
   payload, and allocation/credit-balance tests.
2. **Unconstructible raw token (P0).** The wrapper could not cancel a
   binding-private object it never received. **Resolution:** explicit
   `createEstablishmentCancellation()` plus optional final subscribe token,
   checked single bind, and public-commit handoff.
3. **`napi_env` ABA (P0).** A raw pointer can be reused after teardown.
   **Resolution:** globally monotonic `EnvironmentId`, retained generation Arc,
   exact-record cleanup hook, conditional lookup removal, and a generation
   admission barrier.
4. **Dispatcher start/stop/self-join races (P0).** First registration, last
   removal, and error cleanup were under-specified. **Resolution:** the explicit
   environment lifecycle above, no locks across external waits/calls/joins,
   an admission barrier before cleanup, and dispatcher errors delegated to a
   coordinator that cannot self-join.
5. **Global reaper head-of-line blocking (P0).** One serial reaper could wait
   behind a callback in one environment and stall every other environment.
   **Resolution:** one phased coordinator per affected environment,
   deduplicated pre-existing entries, bounded frozen-round selection, and
   nonblocking callback-quiescence polling.
6. **Ambiguous terminal precedence (P1).** “Observed first” did not define a
   linearization point. **Resolution:** separate engine and Node attempt
   arbiters; joined rollback acknowledgement; provisional native success; one
   explicit public-success commit; cleanup/join errors supersede cancellation.
7. **Unbounded runtime commands (P1).** The existing channel contradicted the
   global boundedness claim and could orphan success when its acknowledgement
   receiver vanished. **Resolution:** capacity-64 control/work FIFO lanes,
   fixed per-lane turns, out-of-band cancellation, exactly one retained
   acknowledgement, and rollback on failed acknowledgement delivery.
8. **Non-executable fairness (P1).** A vague ready queue could itself be
   unbounded or skip peers under churn. **Resolution:** ordered live map,
   frozen high-water scheduling rounds, at most 64 registrations inspected per
   turn, at most one receive/registration, deduplicated wake state, and an
   explicit `ceil(N/64)`-turn inspection bound for registrations present when a
   round begins.
9. **Callback/error accounting gaps (P1).** Closing, callback throws, delivery
   failures, and concurrent disposal could disagree. **Resolution:** exact
   credit/outstanding transitions, expected closing separated from terminal
   delivery failure, one stored cleanup result for every disposer, and callback
   exceptions restricted to `callbackErrors`.
10. **Overstated latency (P1).** libuv scheduling, filesystem calls, user
    callbacks, and joins are not wall-clock bounded. **Resolution:** claim only
    bounded internal turns/state and test the size-one libuv pool with
    deterministic handshakes.
11. **Unavailable release-addon hooks (P1).** Engine `#[cfg(test)]` hooks do not
    exist in the addon built by `pnpm build:node`. **Resolution:** split engine
    hook proofs from wrapper fake-native settlement proofs and add no fictitious
    integration claim.
12. **Incomplete private-minor migration (P1).** Error, loader, signal
    stripping, type exhaustiveness, metadata, and support qualification were
    missing. **Resolution:** the explicit `0.2.0`/binding-2/capability-2/
    metadata-1 migration and `target-pending-clean-ci` status above.
13. **ID exhaustion/acknowledgement bugs (P1).** `saturating_add` could reuse
    `u64::MAX`; success acknowledgement failure could orphan state; failed
    establishment could acknowledge before cleanup. **Resolution:** checked
    IDs, rollback on dropped receiver, and terminal acknowledgement only after
    bounded cleanup/counter publication.
14. **Same-environment blocked callback claim (P1).** No native design can run
    a second JavaScript callback while that event loop is synchronously
    blocked. **Resolution:** promise native/coverage fairness in that
    environment and actual callback concurrency only across Worker
    environments.
15. **Scope creep/Parcel regression.** Copying Parcel's unlimited TSFN queue or
    changing benchmarks/integration would violate the task. **Resolution:**
    queue capacity remains one, Parcel remains pinned comparison-only, and the
    prohibited actions at the top of this document remain hard boundaries.

After these revisions the review verdict is **proceed test-first**. The second
review must inspect the implementation—not trust this document—and stop again
if credit accounting, generation safety, peer fairness, bounded rollback, or
joined terminal cleanup is not actually proved.

## Implementation adversarial review

The second review read the implementation and initially returned **stop**.
These findings were fixed before the final gates:

1. **Scheduler churn could starve an older ID (P0).** A repaired cursor was
   still vulnerable to continual insertion. **Resolution:** both engine and
   dispatcher schedulers use frozen rounds; work admitted after a round's
   high-water mark waits for the next round.
2. **Cancellation teardown hid repeated linear work (P0).** Deferred-resource
   accounting rescanned the whole runtime after each cleanup quantum.
   **Resolution:** each state carries its published contribution, which is
   removed once; teardown tests assert progress and exact counters across
   multiple quanta.
3. **Unexpected TSFN status could unbalance credit or relock the environment
   barrier (P0).** **Resolution:** the payload stays in one registration-owned
   slot, failed admission rolls back once before leaving the barrier, and
   terminal error cleanup begins only after that barrier is released.
4. **The first cleanup replacement still grew steady-state threads (P0).**
   Keeping one permanent cleanup thread per environment defeated the intended
   ordinary thread count. **Resolution:** cleanup coordinators are transient,
   at most one per affected environment, while the already-retained dispatcher
   is the cycle-safe exceptional fallback.
5. **Coordinator creation failure could leak cleanup or self-join (P0).**
   **Resolution:** spawn failure is injected in a unit test, stored as the
   stronger terminal coordination error, and transfers cleanup to the
   dispatcher without holding registry locks or joining itself.
6. **Wrapper terminal edges leaked provisional subscriptions (P0).** Commit
   type errors, thrown commit, listener side effects, signal getter failure,
   and wrapper-construction failure did not all join disposal. **Resolution:**
   every pre-commit failure owns `disposeProvisional`; listener removal is
   attempted on every terminal path, and cleanup failure supersedes
   cancellation.
7. **Established engine disposal monopolized the runtime (P0).** The first
   implementation removed an entire subscription in one command turn.
   **Resolution:** `PendingDisposal` removes at most 64 stored items per fair
   scheduler turn, suppresses new work for that state, retains shared peer
   interests, and acknowledges only after exact counter publication.
8. **Final shutdown still hid linear drops and premature zero counters (P0).**
   Residual ignored-lifetime/descriptor registries were cleared at once, and
   thread/inotify gauges reached zero before `JoinHandle::join`.
   **Resolution:** residual registries drain within the shutdown quantum;
   live-watch maps are hard-empty invariants; liveness gauges become zero only
   after the worker has joined and its inotify descriptor has dropped.
9. **Queued output was destroyed in one caller loop (P0).** Moving the receiver
   into the command initially introduced a worse deadlock against a concurrent
   blocking receive. **Resolution:** worker disposal closes the sender first;
   the caller then acquires the awakened receiver and destroys each queued
   batch and path in 64-item quanta before final runtime release. Tests prove
   seven destructor turns and `Disconnected`, not timeout, for the blocking
   receive race.
10. **Last-active disposal could stop the dispatcher under a queued
    establishment (P0).** This deadlocked the size-one libuv-pool sequence.
    **Resolution:** pending establishment and cleanup keepalive states retain
    dispatcher liveness; an isolated `UV_THREADPOOL_SIZE=1` child covers
    disposal queued before a second subscription.
11. **Pending Worker teardown was overclaimed (P1).** Node does not enter its
    environment cleanup hook while the queued async work is unable to advance;
    neither parent `terminate()` nor an in-Worker `process.exit()` changes that
    platform ordering. **Resolution:** once the hook begins, teardown clears
    pending dispatcher liveness and aborts the TSFN under the environment
    barrier without a JavaScript callback. The child initiates teardown while
    the pool is blocked, releases the deterministic blocker, then requires
    exact Node/runtime zeroes and a fresh subscription. The separate queued
    cancellation child proves that Watchbound cancellation itself needs no
    second worker.
12. **Explicit disposal racing dispatcher-fallback cleanup could resolve before
    dispatcher join (P0).** **Resolution:** losing disposers wait for the one
    stored cleanup result and then perform the inactive-dispatcher join; the
    fallback's coordination error retains precedence.
13. **Documentation overstated dispatcher quiescence (P1).** A selected turn
    may retain an `Arc` after registration deactivation. **Resolution:** the
    contract is stated at its actual admission-barrier linearization point:
    that visit may occur but cannot admit a callback.
14. **Dispatcher fallback surrendered cleanup ownership too early (P0).** If
    coordinator creation failed while a callback remained admitted, the first
    engine-cleanup round cleared the fallback marker; the dispatcher could
    exit with no coordinator able to finalize the registration or TSFN.
    **Resolution:** dispatcher-owned cleanup retains its selection/liveness
    marker through callback quiescence and finalization. Explicit or
    coordinator ownership clears the marker before joining. A deterministic
    outstanding-credit test pins both transitions and stored error precedence.
15. **Disposers could settle before final post-cleanup thread joins (P0).**
    The cleanup result could become visible before an inactive dispatcher or
    transient coordinator `JoinHandle` was consumed. **Resolution:** winning
    and losing explicit disposers perform the same final join of both handles
    after the stored result is published, with coordination errors retaining
    precedence.
16. **Pending rejection could outlive unpublished Node resources (P0).**
    Cancellation or engine failure could reject while the provisional
    thread-safe-function finalizer and dispatcher were still live.
    **Resolution:** one pending-attempt cleanup path closes admission, removes
    the registration, abort-releases the thread-safe function, waits for its
    finalizer, joins the dispatcher, and only then returns the error; exact
    resource-baseline tests cover cancellation and ordinary failure.
17. **Dispatcher setup had an allocation and teardown gap (P0).** Starting the
    dispatcher after thread-safe-function allocation leaked the function on
    synchronous spawn failure, while attaching outside the environment barrier
    could race teardown. **Resolution:** a thread-safe-function-free placeholder
    starts the dispatcher first, allocation follows, and attachment occurs
    under the admission barrier; a teardown winner abort-releases and joins.
18. **Option accessors escaped as arbitrary JavaScript errors (P1).** Reading
    `automaticReconciliation`, enumerating a proxy, or copying native options
    could throw outside the structured error contract. **Resolution:** guarded
    snapshotting converts representation failures to
    `WATCHBOUND_INVALID_ARGUMENT`, reads the policy getter once, preserves
    enumerable string/symbol/unknown keys and `__proto__` as data, and
    allocates no native resource before success.
19. **The reconciliation peer check conflated native progress with JavaScript
    callback timing (P1).** A correct 5 ms dispatcher poll could deliver the
    peer callback shortly after reconciliation settled even though native peer
    work had already advanced. **Resolution:** the scenario samples the peer's
    native `rawEvents` synchronously at public settlement, requires native
    advancement by that settlement, and separately requires eventual ordered
    callback delivery. It does not claim the sample occurred at the exact
    engine acknowledgement or prove the callback ran during the scan.
20. **An exact dispatcher quantum could busy-spin (P0).** After inspecting
    exactly 64 registrations, including the frozen round's final ID, selection
    still reported a pending scan. Counts equal to 64 or a multiple of 64 could
    therefore restart a complete round immediately instead of reaching the
    documented idle poll. **Resolution:** reaching the frozen upper bound
    resets the round and reports completion even on the limit boundary;
    regression tests cover exact 64- and 128-registration rounds.
With these fixes, the code-level review verdict was **proceed to final serial
verification**. The final audit then found and fixed the exact-quantum issue in
finding 20, and the complete local gate below passed. This is not a support
qualification; the private `0.2.0` candidate remains
`target-pending-clean-ci`.

## Final verification record

Final local verification on 2026-07-23 selected Node 24.18.0 before each gate
and ran the lifecycle/stress commands serially:

- `corepack pnpm build:node`: passed and produced the controlled local release
  addon after all native-source changes;
- `corepack pnpm test`: passed 146 engine tests and 19 binding unit tests, the
  Node smoke/lifecycle/environment suite, and all 12 wrapper/harness test
  files;
- `corepack pnpm check`: passed Rust formatting, Clippy with warnings denied,
  syntax checks for 59 JavaScript files, and TypeScript consumer fixtures;
- `corepack pnpm test:soak`: passed 25/25 bounded lifecycle cycles and restored
  the reported final descriptor/task baselines;
- `corepack pnpm test:reconciliation-stress`: the first run exposed the
  callback-timing overclaim described in implementation finding 19; after the
  evidence check was corrected, the final run passed 5/5;
- `corepack pnpm test:root-recovery-stress`: passed 3/3; and
- strict quick conformance for `bridge-backpressure`, `disposal`,
  `reconciliation`, `automatic-reconciliation`, and
  `root-replacement-recovery`: each passed 1/1.

The conformance system record reported Node `v24.18.0`. Nested pnpm invocations
printed an engine warning from pnpm's standalone embedded Node 20.11.1 runtime;
the project `node` processes and conformance children used the selected Node
24.18.0 binary. The local kernel was 7.1.3-2-cachyos, so this is not the fixed
Ubuntu qualification host. No forced-overflow scenario, benchmark command,
result-file write, package publication, prebuild, artifact upload, consumer
integration, or commit was performed.

## Residual risks and evidence boundaries

- No release-addon test barrier pins cancellation to a single instruction in
  dispatcher attachment or forces a production callback to enter before the
  subscribe Promise resolves. Deterministic engine, raw-token, resource-
  baseline, and fake-native wrapper tests cover the adjacent states, and the
  implementation ordering is reviewed, but this remains an integration
  evidence gap rather than a stronger timing claim.
- A synchronously blocked JavaScript event loop cannot run another callback in
  the same environment. Engine/output fairness continues there, while actual
  callback concurrency is demonstrated only across Worker environments.
- The dispatcher has a documented 5 ms poll fallback. Internal inspection and
  cleanup turns are cardinality-bounded; filesystem calls, libuv scheduling,
  user callbacks, polling, and joins have no wall-clock bound.
- Joined cleanup in one environment is serialized through at most one
  transient coordinator, so a large cleanup can delay a later cleanup in that
  environment. Other environment dispatchers and bounded engine turns remain
  independent; coordinator-spawn failure temporarily retains the dispatcher as
  the cycle-safe cleanup owner.
- Local output destruction is total work proportional to the configured queued
  paths, split into uninterrupted quanta of at most 64 items with scheduler
  yields between them.
- A malformed signal-like object can retain the temporary no-op listener if its
  `removeEventListener` throws or lies. A conforming `AbortSignal` removes it,
  and removal failure does not corrupt the selected establishment result.
- Node defers a Worker environment cleanup hook while its queued async work
  cannot receive a libuv turn. The teardown test proves cleanup from hook entry,
  while separate size-one-pool cancellation proves Watchbound cancellation does
  not itself require a second worker.
- This host is useful local correctness evidence but is not the fixed Ubuntu
  24.04/Linux 6.8 qualification target. The private candidate remains
  `target-pending-clean-ci`; no final benchmark readings are recorded here.
