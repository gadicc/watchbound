# API and lifecycle notes

The Rust prototype API is intentionally smaller than the eventual package API.
It exists to make correctness properties executable before stabilizing names.

## In-process execution boundaries

The Node addon is a shared library in the Node or Electron process, not a
helper process. The host process owns its native faults, descriptors, memory,
and Watchbound Rust threads.

The JavaScript thread loads and verifies the addon; validates and copies
arguments, options, and `AbortSignal` state; creates environment registrations
and callback bridges; encodes exclusion policies; reads synchronous getters
and statistics; updates `observedState`; runs automatic policy; and invokes the
consumer callback. These synchronous portions can block the event loop. In
particular, large option or exclusion collections, accessors supplied by the
caller, contended native locks, module loading, and callback work have no
asynchronous isolation.

Establishment, exclusion replacement, reconciliation, root recovery, and
joined disposal each use a napi-rs asynchronous task. Its compute function runs
on Node's shared libuv pool and waits for the ordered Rust-engine result. The
single lazy `watchbound-linux-runtime` thread owns inotify and all filesystem
state. At most one `watchbound-node-dispatcher` thread per Node environment
performs fair callback admission. At most one transient
`watchbound-node-cleanup` coordinator per affected environment advances
garbage-collection, delivery-failure, or teardown cleanup; the retained
dispatcher is its creation-failure fallback.

Steady state has one Watchbound runtime thread for the loaded binding plus one
dispatcher for each Node environment with live subscriptions. Subscription
count inside one environment does not change that thread count. Separate
Worker environments share the process runtime but have separate JavaScript
threads, dispatchers, environment gates, and callback bridges.

A queued napi-rs task occupies no libuv pool slot before compute starts. Once
started, it retains one slot while waiting for the engine acknowledgement,
including cancellation rollback or final runtime shutdown. Cancellation wakes
the engine but does not remove queued async work or release a running libuv slot
early. Therefore a task queued behind unrelated pool work cannot settle until
libuv schedules it, and a started task remains counted against pool capacity
until its terminal join completes.

## Subscription establishment

`Engine::subscribe(root, options)` remains synchronous in Rust and delegates
through the cancellable establishment machinery with a never-cancelled token.
`Engine::begin_subscribe` exposes an attempt whose cancellation handle can be
signalled while `wait()` occupies the caller. Establishment validates the root,
acquires the process-wide Linux runtime, sends an ordered command, and waits
for its acknowledgement. The shared worker traverses the
initial tree in bounded, round-robin topology turns, installs all available
logical watch interests, and returns immutable `initial_coverage` and
`initial_root_state` values from that same establishment acknowledgement.
Native work and other subscriptions continue between those topology turns.

JavaScript `SubscriptionOptions` adds an establishment-only
`signal?: AbortSignal`. Pure representation errors precede the aborted check.
An already-aborted valid request rejects before a native token or filesystem
resource is created. Otherwise the wrapper creates one single-bind native
token, registers a temporary listener, strips `signal` from native options, and
passes the token to raw subscribe. Cancellation before native acknowledgement
is acknowledged only after worker-owned rollback. Native success remains
provisional until synchronous `commitPublicSuccess()`; if cancellation won
first, the wrapper joins disposal of the provisional subscription before
rejecting with `WATCHBOUND_OPERATION_CANCELLED`. Cleanup failure supersedes
cancellation. After public success, abort is a no-op. Listener removal is
attempted on every terminal path and succeeds for a conforming `AbortSignal`;
if removal throws on the provisional-success path, the wrapper requests
cancellation, joins disposal, and rejects with `WATCHBOUND_INVALID_ARGUMENT`.
The final cleanup retry does not replace an already authoritative native error
or cancellation result. A substitute that lies about removal can retain a
no-op listener that the wrapper cannot forcibly detach.

`initialExclusions` is copied and exact-byte encoded during the same
synchronous preparation. The complete prefix set is validated before runtime
acquisition and installed at exclusion generation zero before any topology
directory is opened. Excluded subtrees therefore consume neither logical
interests nor native watches during establishment. The empty prefix excludes
the root without making that root unavailable; a later exclusion replacement
can re-include it.

The terminal order and race rules are:

1. JavaScript representation and numeric-option errors precede the initial
   aborted check. A valid already-aborted request then rejects before native
   token, environment, bridge, runtime, or filesystem allocation.
2. The wrapper creates one token, registers the listener, and checks
   `signal.aborted` again. A registration failure requests cancellation and
   rejects without calling raw subscribe; the second check covers re-entrant or
   compatible-object behavior at that boundary.
3. Rust subscription-option validation precedes engine cancellation state.
   After valid options, already-requested cancellation wins before symlink,
   missing-root, runtime, or command admission checks.
4. During admission and traversal, cancellation, filesystem failure, and
   engine success compete through one attempt-scoped terminal state. A
   committed filesystem failure stays that failure. Cancellation that wins
   first is acknowledged only after bounded worker-owned rollback removes
   attempt state and releases any final runtime lease.
5. Engine success creates a provisional Node subscription, not public success.
   A dropped acknowledgement receiver, bridge publication failure, caller
   abort, or environment teardown closes delivery and joins cleanup rather than
   leaving an ownerless subscription.
6. Environment teardown can win before bridge attachment, during libuv
   compute, or after provisional state exists. The raw operation reports
   `WATCHBOUND_OPERATION_INTERRUPTED`, closes the environment admission gate,
   and starts cleanup without requiring JavaScript promise settlement.
7. A raw pending-attempt error in a live environment settles only after its
   unpublished registration is removed, its thread-safe function is
   abort-released and finalized, and any now-inactive dispatcher joins.
8. After native handoff, listener removal, the final aborted check, and
   synchronous `commitPublicSuccess()` form the public commit boundary. An
   abort that won before commit makes the wrapper join provisional disposal
   before rejecting with `WATCHBOUND_OPERATION_CANCELLED`.
9. Provisional cleanup failure supersedes cancellation. Malformed commit
   output, listener-removal failure, or public-subscription construction
   failure also fails closed and joins provisional disposal. After a successful
   public commit, later signal abort is a no-op and disposal owns the remaining
   lifecycle.

Once a thread-safe function has been allocated for a raw pending attempt, its
error is not delivered to a live environment before unpublished Node resources
are joined. The binding closes admission, removes the dispatcher placeholder,
abort-releases the function, waits for its finalizer, and joins an inactive
dispatcher. Environment teardown closes the same admission barrier without
depending on JavaScript settlement.

Internal polling and work quanta are bounded, but wall-clock settlement can
wait for libuv scheduling, filesystem calls, an already-admitted callback, and
final runtime join.

Every component of the root path must be a real, non-symlink directory;
descendant directory symlinks are skipped. The check is path-based rather than
an fd-anchored security boundary. Establishment fails instead of returning
complete coverage if the root vanishes or changes identity during traversal.

An absent subscription `watch_limit` means the engine imposes no logical limit
for that subscription; kernel and process limits still apply and must be
reported as partial coverage. The engine does not contain Codex Desktop's
`8192` policy value. The subscription limit counts logical directories even
when overlapping subscriptions share one native watch.

`Engine::new()` requests the unbounded runtime default.
`Engine::with_runtime_watch_budget(positive_limit)` requests a budget over
unique native watches. JavaScript exposes the same choice as
`createEngine({ nativeWatchBudget: number | null })`; omitted or `null` means no
Watchbound-imposed runtime budget, while a number must be an integer from 1
through `2^32 - 1`. Engine creation validates and retains only the requested
configuration. It allocates no inotify instance, eventfd, worker, watch, or
subscription. The top-level `subscribe()` convenience function lazily creates
one default unbounded JavaScript engine and delegates to it.

All engine values from the one loaded native binding share one process-wide
runtime registry. The first establishment to acquire that registry fixes its
configuration for the runtime lifetime. Matching bounded engines coexist, as
do multiple unbounded engines; a bounded/unbounded mismatch or unequal bounded
values reject subscription with `WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT`
and `retryAfter: "runtime-disposed"`.

Acquisition is provisional while an admitted establishment traverses and
validates its root. A concurrent differently configured establishment can
therefore receive the configuration conflict even if the first establishment
later fails. The failed establishment releases its lease; if it was the final
lease, shutdown is joined and retry with another configuration may then
succeed. Similarly, when the final established subscription's joined disposal
releases the final runtime lease, a later runtime may use a new configuration.
The runtime never silently chooses among engine requests.

`Engine::runtime_stats()` and JavaScript `engine.runtimeStats()` report the
actual shared process runtime: active state, actual `nativeWatchBudget`, unique
`nativeWatches`, queued logical `deferredInterests`, subscriptions, inotify
instances, and worker threads. They do not report an engine-local allocation or
echo its request. `engine.nativeWatchBudget` is the retained request; every
engine's runtime stats can show a different engine's currently active global
configuration. With no runtime, stats are the frozen zero/null inactive
snapshot even for an engine that requests a bounded value.

`initial_coverage` and `initial_root_state` never change. Together they are the
exact establishment baseline: batch sequence zero, exclusion generation zero,
and root generation zero. The Node and wrapper spellings are `initialCoverage`
and `initialRootState`. Current coverage and root evidence travel on later
batches. Deferred-directory counts describe current known gaps rather than
cumulative failure history. Each subscription accounts for its logical watched
and deferred directories independently; the runtime budget accounts only for
unique native watches. Deleting a deferred subtree can reduce the count, while
deleting watched topology or disposing another subscription can return a token
and promote a still-existing deferred interest automatically. A subscription
at its own limit cannot consume a free runtime token.

Promotion installs or shares the native watch before reading the directory,
invalidates the promoted path conservatively, and scans the populated region in
bounded scheduler turns. Its topology barrier keeps current coverage partial
and withholds that invalidation until discovery finishes. The resulting batch
reports complete only if the scan leaves no other gap. Uncertainty is sticky,
with stronger loss reasons (notably native overflow) taking precedence over
weaker ones.

## Capability schema version 6

The JavaScript `capabilities` export is deeply frozen, JSON-serializable, and
has these top-level sections:

| Section | Contract |
| --- | --- |
| `schemaVersion` | Exactly `6`. |
| `versions` | Wrapper, native package, and Rust engine versions plus binding API version. |
| `build` | Manifest-derived delivery, build profile, triple, Node-API/Rust floors, and the exact packaged target/package/file/SHA when generated. |
| `runtime` | Observed process platform, architecture, kernel release, libc family/version, and Node/Node-API versions. |
| `support` | Compatibility-preserved legacy x64 fields plus `targets`, `qualificationLanes`, `currentRuntime`, recognized compatibility families, and explicit unsupported targets. `SupportStatus` is `target-pending-clean-ci | supported`; both candidate GNU/Linux targets are supported in the source matrix. |
| `features` | Recursive watching, moved-in discovery, subscription limits, process budget, shared native watches, overflow, exclusions, manual/automatic reconciliation, root recovery, exact bytes, ordered batches, observed state, cancellable establishment, and shared Node delivery. |
| `options` | Machine-readable types, scopes, accounting units, defaults, hard bounds, and the automatic-delay ordering constraint. |
| `observability` | Ordered-batch authority, before-callback observation, allowed native/result lead, initial state, subscription/runtime stats, counter encodings, the one-entry native callback queue, Node-environment dispatcher scope, single-credit admission, and callback completion/error/disposal/teardown policy. |

The exact identity leaves are `versions.{wrapper,native,engine,bindingApi}`,
`build.{delivery,prebuilt,profile,targetTriple,nodeApi,rustMinimum}`, and
`runtime.{platform,architecture,kernel,libc:{family,version},node:{version,api}}`.
Feature booleans are `recursive`, `movedInTreeDiscovery`,
`explicitWatchLimits`, `processNativeWatchBudget`, `sharedNativeWatches`,
`overflowReporting`, `initialExclusions`, `dynamicExclusions`,
`directoryNameExclusions`, `observedExcludedPaths`, `reconciliation`,
`automaticReconciliation`, `rootReplacementRecovery`, `physicalRootResolution`, `exactPathBytes`,
`orderedBatches`, `observedState`, `cancellableEstablishment`, and
`sharedNodeDelivery`.

Runtime facts describe the process that loaded the binding; they are not a
support claim and do not widen the fixed `support` target. Qualification comes
only from the exact-commit clean CI recorded in `support-matrix.md`.

Positive JavaScript options crossing the native boundary share bounds 1 through
`2^32 - 1`. `options.engine.nativeWatchBudget` defaults to `null`, has scope
`process-runtime`, and accounts `unique-native-watches`;
`options.subscription.initialExclusions` defaults to `[]`, accepts exact-byte
normalized root-relative directory prefixes, and is committed at exclusion
generation zero during subscription establishment;
`options.subscription.excludedDirectoryNames` defaults to `[]`, accepts exact
single-component directory names, and shares that generation;
`options.subscription.observedExcludedPaths` defaults to `[]`, accepts exact
nonempty normalized root-relative boundaries, and shares that generation;
`options.subscription.watchLimit` defaults to `null`, has scope `subscription`,
and accounts `logical-directories`. Other subscription defaults are 10 ms
`batchWindowMs`, 1,024 `maxBatchPaths`, and 64 queued batches.
`automaticReconciliation` defaults to `false`; its option defaults/bounds are
3 attempts (1–16), 25 ms initial delay (10–60,000), and 1,000 ms maximum delay
(10–60,000), with maximum delay at least initial delay. `null` on either watch
limit means no Watchbound-imposed limit, not unlimited kernel resources.

Observability fixes `authoritativeState: "ordered-batches"` and
`observedStateBoundary: "before-callback"`; both operation results and native
getters may lead observed state. Initial coverage/root state and subscription
stats are present. Runtime stats have process scope, count unique native watches
and deferred logical interests, and use an inactive zero snapshot. Sequences and
cumulative counters are bigint, gauges are numbers, and the native callback
queue capacity is one. `deliveryDispatcherScope` is `node-environment` and
`deliveryAdmission` is `single-credit`.
Callback completion is `promise-aware-serialized`, with one callback in flight
per subscription. Callback errors use `count-and-continue`, explicit disposal
joins pending completion, and environment teardown abandons it.
`deliveryDispatcherWorkQuantum` is 64 registrations per turn and
`deliveryDispatcherPollMilliseconds` is 5.

## Delivery

Consumers receive `ChangeBatch` values through a bounded queue. Paths are
absolute filesystem paths in the Rust prototype. They are conservative
invalidations, not promises of one precise low-level event per path.

Sequences begin at one and increase only for successfully delivered batches.
Every batch also has an `exclusion_generation`; all paths in that batch were
selected under exactly that committed exclusion policy. Generation zero is used
before the first successful replacement.
Every batch also carries fixed-size `root_state`: the last explicitly accepted
Linux `(device, inode)`, a root generation, `attached` or `lost`, and bounded
loss evidence. Root generation starts at zero and advances once per committed
root recovery, independently of the exclusion generation.
If a bounded consumer queue fills, the undelivered detail is replaced by a root
invalidation and uncertain coverage when delivery can resume.

The Node boundary adds a one-entry thread-safe-function queue and one admission
credit per subscription. Its environment dispatcher receives no second engine
batch until the admitted callback completes: a non-Promise-like return
completes synchronously, while a Promise-like return retains the credit until
settlement. No
readiness list, retry queue, or other native-to-Node staging queue grows behind
a slow callback. The engine output queue remains separately bounded, although
the default `watchLimit: null` and default engine
`nativeWatchBudget: null` mean native watch cardinality has no
Watchbound-imposed limit unless the consumer configures one.

A slow callback affects more than its own callback because every callback in
one Node environment runs on the same JavaScript thread. The dispatcher and
filesystem runtime keep running, but peer callbacks cannot complete while that
thread is synchronously blocked. Sustained peer traffic can therefore fill
each peer's own engine queue and mark those peers independently
`consumer-backpressure` uncertain. Another Worker environment has a separate
JavaScript thread and dispatcher and can continue callback progress.

Ordered batches remain the authoritative record of what has crossed the
delivery boundary. The JavaScript wrapper retains one frozen `observedState`
projection with `{ sequence, exclusionGeneration, rootState, coverage }`. It is
either the sequence-zero establishment baseline or the last batch whose native
delivery callback entered wrapper JavaScript. The wrapper replaces this
projection before automatic-reconciliation policy observes the batch and before
the user's callback starts, so a user callback that throws has still observed
that batch. A callback may enter before the subscribe promise resolves; such a
projection is retained and is not overwritten by later baseline initialization.

`observedState` is not an atomic read of live native state. The native-backed
`rootState` and `exclusionGeneration` getters, and a completed exclusion,
reconciliation, or recovery operation, may be ahead of it. Operation success
means the native boundary was committed and, when required, entered the bounded
output path; it does not mean its JavaScript callback has run and must not
optimistically advance `observedState`. If a successful operation emits no
batch, `observedState` may remain behind indefinitely.

`watchedDirectories` and `deferredDirectories` are live gauges and become zero
after disposal. Event, topology-scan, batch, overflow, callback-error, and
delivery-error counters are cumulative. `batchesDelivered` means queued across
the Rust engine channel; `bridgeDeliveryErrors` retains its compatibility name
and reports a later dispatcher/thread-safe-function delivery failure.

The shared worker keeps pending paths, sequence numbers, coverage, and output
channels per subscription. Consumer backpressure therefore degrades only the
affected subscription. Native inotify overflow is different: it is loss on the
shared kernel queue and conservatively makes every live subscription uncertain.

### Callback completion and cancellation

The public callback is either `(batch, context) => void` or
`(batch, context) => PromiseLike<unknown>`. Callbacks for one subscription
never overlap. Fulfillment values are ignored. A synchronous throw, a throwing
`then` accessor, a thenable that throws before settling, and Promise-like
rejection each increment `callbackErrors`; Watchbound observes rejection and
continues later delivery.
No Watchbound-owned detached-task mode exists. Consumers that deliberately
start unjoined work own its rejection, ordering, bounds, and shutdown.

Every callback receives the same frozen `{ signal, stop }` context. The signal
aborts synchronously when explicit disposal or `stop()` begins. `stop()` is
idempotent, returns `void`, closes later callback admission, and requests
disposal; callers can subsequently join that request with
`subscription.dispose()`. This shape avoids requiring a callback to await its
own completion barrier. A callback can enter before `subscribe()` resolves, so
an early stop is latched and the eventual public subscription is immediately
disposed.

An explicit disposer waits for an admitted Promise-like callback to settle. A
never-settling callback therefore keeps `dispose()` pending unless it
cooperates with `context.signal`. This is intentional joined-disposal
semantics. Awaiting `subscription.dispose()` from the current callback,
awaiting a later callback from the same subscription, or waiting for
`observedState` to advance to a batch that needs the current credit is a
self-deadlock. Native reconciliation, exclusion, and root-recovery
acknowledgements may settle while callback credit is held, but their resulting
batch cannot enter until the callback settles.

## Disposal

Rust `dispose` is idempotent and safe to call concurrently. The first caller
sends an ordered disposal command; other callers join the same transition. The
worker closes event, topology, promotion, and maintenance admission for that
subscription, then removes at most 64 stored items per scheduler turn. It
yields to runnable peers between disposal turns and acknowledges only after no
later enqueue for the disposed subscription can begin. The handle then drains
already queued batches, charging each batch and path against a separate
64-item destructor quantum and yielding between quanta. Only then may final
runtime release shut down and join the worker and close its inotify and
command-wakeup descriptors; shutdown also drains residual runtime
watch-lifetime registries through the fixed worker quantum. A shared kernel
watch remains installed while any other logical interest needs it. Dropping a
subscription performs the same cleanup. Returned final-interest tokens are
offered round-robin to other subscriptions before they need any resubscription.
Statistics remain readable after explicit disposal; its logical
watched/deferred counts are zero.

The Node layer exposes asynchronous disposal so the JavaScript event loop can
continue draining or cancelling bounded Node-API delivery while the Rust worker
joins. It first closes that subscription's admission credit and marks its
dispatcher registration inactive. A turn that already retained the
registration may still recheck it, but cannot admit a callback after the
subscription barrier closes. Its stronger user-visible guarantee is: once the
disposal promise resolves, no callback for that subscription can begin.

Synchronous callback throws and asynchronous callback rejections increment
`callbackErrors` and do not stop later delivery. A Node thread-safe-function
delivery failure increments
`bridgeDeliveryErrors`, closes only that dispatcher registration, and makes
joined disposal reject.
The wrapper retains its callback and stable callback context through the
returned subscription while the
native callback holds only a `WeakRef`. Callers must therefore retain the
subscription for callback delivery; dropping it permits best-effort GC cleanup,
including when the callback captures the subscription. Explicit `dispose()` is
the only deterministic cleanup guarantee.

Explicit disposal and environment teardown have different guarantees.
`dispose()` aborts the callback context and closes admission synchronously,
then its libuv task joins engine disposal, any admitted callback completion in
a live environment, thread-safe-function
finalization, an inactive dispatcher, and any inactive cleanup coordinator.
Concurrent calls join the same result, and the JavaScript wrapper returns the
same promise. After that promise resolves, no callback, topology transaction,
automatic retry, or engine enqueue for the subscription can begin.

Environment teardown and GC cleanup are safety paths, not the public
joined-disposal promise.
Its cleanup hook closes the environment-wide admission barrier, marks pending
establishment as interrupted, abort-releases callback bridges, and schedules
native cleanup for every established registration. It does not wait for
JavaScript callbacks or Promise-like settlement, because the environment is
closing. Any in-flight completion ticket is abandoned. A deduplicated
per-environment cleanup table is advanced by at most one transient coordinator;
if that thread cannot be created, the retained dispatcher is the fallback.
Node may delay entering the cleanup hook until queued async work can advance.
Once the hook begins, Watchbound cleanup needs neither another JavaScript
callback nor a second libuv worker. The environment-teardown tests establish
resource restoration and Worker isolation, not the public no-later-callback
guarantee.

## Exclusion configuration and lifetime

Rust exposes the compatible `replace_exclusions(generation, Vec<PathBuf>)` and
the whole-policy `replace_exclusion_policy(generation, ExclusionPolicy)` on
`Subscription` and its cloneable `ExclusionHandle`; both return the coverage
snapshot committed by the acknowledgement. `exclusion_generation()` reports
the last acknowledged value. The raw Node operation accepts either a `Buffer`
prefix array or a policy object, with bigint generations. The JavaScript
wrapper accepts strings or `Uint8Array`s and exposes a live bigint
`exclusionGeneration` getter. The wrapper reports initial filtering, dynamic
replacement, recursive name exclusions, and observed boundaries through
capability feature flags; the Rust and raw Node records expose the corresponding
native features.

`SubscriptionOptions.initialExclusions`, `excludedDirectoryNames`, and
`observedExcludedPaths` supply the complete generation-zero policy before
traversal. A later policy-object call supplies all three complete replacement
sets; an omitted field means an empty set. The legacy array form supplies only
prefixes and clears both newer sets.

Prefixes are normalized root-relative directory namespaces compared using
exact Linux bytes. The empty prefix denotes the root; `.` is non-normal and
rejected. A nonexistent prefix is valid and filters a directory created there
later. Directory-name exclusions are nonempty single normal components. They
match exact directory basenames at every depth, including future directories
and rename destinations, but never match substrings, paths, globs, case-folded
names, or a non-directory with the same name. A match is pruned before opening
or assigning a logical/native watch and neither its boundary nor descendants
are delivered by default.

Observed excluded paths are nonempty normalized root-relative paths. Their
descendants remain pruned and unwatched, while creation, deletion, rename,
replacement, or a detected `(device, inode, mode)` identity change produces a
conservative invalidation of the exact boundary. Existing regular files and
symlinks are valid boundaries; symlinks are never followed. When a path also
matches a name exclusion, observation overrides only boundary delivery. A path
whose proper parent is excluded is rejected because its boundary could not be
observed truthfully.

Absolute, parent-traversing, repeated-separator, trailing-separator,
NUL-containing, malformed, and ambiguous inputs are rejected before changing
the committed policy. Duplicate entries have set semantics. The engine does
not interpret Git ignores, globs, workspace mapping, or application defaults.

Generations start at zero and successful requested values must be strictly
greater than the committed value; they need not be consecutive. Duplicate,
stale, and lower values are rejected without changing state. Only one update
may be in flight per subscription, so a conflicting concurrent request is
rejected rather than queued or reordered. Other subscriptions retain their own
generation and allocator state.

The worker first completes that subscription's active topology work and closes
the old-generation pending-batch boundary. It installs the whole candidate only
inside the topology transaction, removes newly excluded logical interests in
bounded chunks, returns final native-watch tokens between allocator turns, and
scans newly included regions using watch-before-read discovery in bounded
scheduler turns. Name-policy relaxation conservatively rescans from the root;
new observed boundaries are invalidated at their committed generation. A scan
that cannot obtain a subscription slot or runtime token records truthful partial
coverage and enters ordinary fair deferred promotion. Re-included prefixes are
conservatively invalidated only after their topology barrier completes because
changes made while excluded cannot be reconstructed.

Acknowledgement publishes the new generation only after the exclusion policy,
topology, allocator accounting, and coverage snapshot are committed. It does
not wait for the JavaScript callback to consume the resulting invalidation.
Disposal and updates serialize through the subscription lifecycle: an active
update completes or is explicitly interrupted before joined disposal returns,
and a new update cannot begin after disposal. Exclusion configuration lives only
for that subscription and is released with its topology, deferred records,
watches, descriptors, and final worker shutdown.

Rejected exclusion operations carry the schema-version-2 structured metadata
defined in [`error-contract.md`](error-contract.md). In particular, invalid
policy inputs and generations use `WATCHBOUND_INVALID_ARGUMENT`, a concurrent
topology operation uses `WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT`, and work
admitted before disposal may use `WATCHBOUND_OPERATION_INTERRUPTED`. Human
messages are diagnostic and are not a policy surface. Exclusions deliberately
do not add
Git/glob policy, detailed event kinds, rename reconstruction, or cross-platform
support.

## Reconciliation and recovery

Rust exposes synchronous `reconcile()` on `Subscription` and cloneable
`ReconciliationHandle`. Node and the JavaScript wrapper expose the same worker
barrier as an asynchronous method. Its result contains the unchanged
`exclusionGeneration` and the committed final `coverage`; the
`capabilities.features.reconciliation` flag advertises the complete wrapper
surface.

The recoverable sticky reasons are `event-overflow`, `topology-race`, and
`consumer-backpressure`. Reconciliation never synthesizes the detailed events
that may have been lost. It closes the existing pending batch boundary, checks
the original root identity, scans only the topology included by the current
committed exclusion policy, installs or shares a watch before reading each directory,
and performs bounded mark-and-sweep cleanup of stale watched, deferred, and
promotion state. The operation can yield between scheduler turns, while its
subscription continues to expose the previous committed resource gauges.

The exclusion policy and generation cannot change during this barrier. A
concurrent reconciliation or exclusion update fails with
`WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT` and
`retryAfter: "topology-transaction-settles"`. Events observed while scanning
are conservatively represented by the final root invalidation, and a directory
topology event extends the scan barrier. Batches remain single-generation and
sequences advance only when the bounded engine queue accepts a batch.

Successful acknowledgement occurs after the scan and stale-interest sweep,
root revalidation, final allocator/coverage publication, and enqueue of the
root invalidation. Only that successful enqueue permits the uncertainty present
at the start to clear. A new loss during the barrier remains uncertain. If the
queue is full, the promise/reconciliation call rejects with
`WATCHBOUND_CONSUMER_BACKPRESSURE` and `retryAfter: "delivery-drains"`; the
subscription stays uncertain with a pending root invalidation. The
acknowledgement does not imply that a JavaScript callback has already run.

Known `root-replaced` uncertainty is rejected, and a root identity change found
at either validation point fails reconciliation while retaining
`root-replaced`. Same-path replacement attachment belongs only to the distinct
explicit operation below.
Disposal interrupts or joins an active barrier, releases reconciliation and
deferred state, and preserves idempotent final-runtime shutdown and the rule
that no enqueue, callback, update, or reconciliation can begin after disposal
resolves.

The public conformance scenario reaches this lifecycle through the existing
Node/JavaScript subscription. It creates observable recoverable uncertainty by
blocking one callback until the bounded native output queue reports
`consumer-backpressure`, waits for the output path to drain, and invokes the
same subscription's `reconcile()` method. It does not unsubscribe, resubscribe,
or reconstruct lost detail. Strict capability gating excludes adapters that do
not expose the complete reconciliation, explicit-coverage, typed-backpressure,
and atomic-exclusion contract.

The scenario verifies generation zero and a committed nonzero exclusion
generation separately, requires single-generation ordered batches, and matches
the reconciliation result's final coverage to the one conservative root batch.
Acknowledgement establishes that this batch entered the bounded output path;
the callback can run later. Mutations during uncertainty or scanning are
covered by that root boundary, current and future exclusions remain effective,
a peer subscription continues independently, and a later deep mutation is
delivered. Joined disposal then rejects later reconciliation and verifies that
callbacks, watches, descriptors, dispatcher registrations, and the final
worker do not survive the lifecycle boundary.

This deterministic callback-backpressure case is suitable for ordinary
development, but is not evidence for real kernel-overflow recovery. The
I/O-heavy `overflow-reconciliation` conformance path uses the same public
method only after its detached supervisor proves genuine stop/mutate/resume
induction, the public stream reports `event-overflow`, and delivery quiesces.
It preserves the generation and exclusion contract, credits only one matching
root-only recovery batch, and treats any observed interval detail as
non-guaranteed. Because native overflow belongs to the shared inotify queue, a
peer is required to stay explicit and truthful—not necessarily complete—while
continuing delivery during the scan. The acknowledgement may precede callback
entry because it follows bounded native enqueue.

The scenario is removed by `--quick` and cannot be selected without
`--allow-forced-overflow`; that acknowledgement is not host-readiness
confirmation. Its heavy path was not run while being implemented; a later
explicitly confirmed targeted trial passed the lifecycle contract recorded in
`docs/benchmark-results.md`.

## Explicit root replacement recovery

Rust exposes synchronous `recover_root(RootIdentityPolicy)` plus cloneable
`RootRecoveryHandle` and `RootStateHandle`. Node exposes asynchronous
`recoverRoot(policy)`, while the public wrapper requires
`recoverRoot({ identityPolicy })`. The policies are `original-only`, which
accepts only the initial identity returning to the lexical root, and
`accept-replacement`, which accepts exactly the real-directory identity
captured for that call. There is no default and no alternate path argument.
`reconcile()` never adopts an identity, and the automatic policy never calls
root recovery.

Root loss is latched independently of coverage priority. While lost, topology
growth, deferred promotion, exclusion replacement, and reconciliation are
blocked even if stronger `event-overflow` coverage is visible. Recovery removes
the old subscription topology in bounded turns, preserves peer interests and
the committed exclusion generation, installs or shares each candidate watch
before reading, and revalidates ancestry and root identity before commit. A
changed candidate, symlink ancestry, missing/non-directory path, policy
refusal, or unavailable root watch returns a structured `not-attached` result.

A successful attachment increments root generation and attempts one singleton
lexical-root boundary under the unchanged exclusion generation. Complete or
partial coverage with a non-null `boundarySequence` means that exact boundary
entered the bounded engine queue. If output pressure prevents it, the identity
can still be attached while the result remains uncertain with a null boundary;
ordinary reconciliation may then restore coverage. Wrapper root states and
results are immutable and use bigint identity/counter fields.

When automatic reconciliation is enabled, a user-started call temporarily
enters one bounded `recovering-root` status. The policy retains only the
strongest later ordered uncertainty, clears its root block only for an attached
result, and schedules ordinary reconciliation only for a remaining recoverable
reason. A rejected or `not-attached` call stays blocked. Disposal joins an
already admitted recovery and prevents later callbacks, retries, or filesystem
work.

The ordinary `root-replacement-recovery` conformance scenario performs direct
and ancestor replacement on one public subscription, proving policy refusal
and explicit adoption, exact result/boundary matching, exclusion preservation,
peer progress, monotonic sequence/root generations, a deep post-recovery
sentinel, and joined cleanup. Its first strict quick trial passed all 15 checks
with forced overflow disabled on 2026-07-20.

## Opt-in automatic reconciliation policy

The JavaScript wrapper accepts `automaticReconciliation: true` or a bounded
options object with `maxAttempts`, `initialDelayMs`, and `maxDelayMs`. It is
disabled by default. Defaults are three attempts, 25 ms initial delay, and a
1,000 ms cap; public validation limits attempts to 16 and delays to 10–60,000
ms. The delay for attempt N is `min(initialDelayMs * 2^(N-1), maxDelayMs)`.

The policy observes native batches before invoking the user's callback.
Only `event-overflow`, `topology-race`, and `consumer-backpressure` set its one
pending-loss bit. Repeats before the timer fires are coalesced. A loss during a
barrier requests exactly one later attempt after the active call settles. A
loss that happens after the native root enqueue but before its callback is a
later ordered batch; when that batch reaches JavaScript it begins a fresh
bounded cycle. No attempt overlaps another.

Automatic calls use the original subscription and the same native transaction
gate. A simultaneous manual reconciliation or exclusion replacement therefore
rejects with `WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT`; nothing is silently
queued or reordered. The policy makes bounded retry decisions from exact
structured codes: topology-transaction conflicts and consumer backpressure may
consume an attempt and retry after their named conditions, while
`WATCHBOUND_ROOT_STATE_CONFLICT` blocks pending an explicit root decision.
Other failures exhaust the active bounded cycle rather than being classified by
message text. Exclusion generations, sequences, coverage, and the root-only
boundary remain native results. Detailed lost events are never reconstructed
or credited.

`subscription.automaticReconciliation` is one immutable current snapshot, not
an unbounded history. It reports scheduled/reconciling progress, successful
coverage and generation, terminal incomplete coverage, bounded retry
exhaustion with a capped diagnostic error message, `root-replaced` as blocked,
`recovering-root` while a user-started explicit recovery owns the coordination
slot, and disposal state. Exhaustion latches the automatic policy rather than
restarting on every batch carrying sticky uncertainty; explicit manual
reconciliation remains available. Root replacement cancels a pending timer and
can never receive automatic recovery credit.

`dispose()` closes policy admission and cancels its timer before beginning
native disposal, then joins both native disposal and an active policy attempt.
Repeated disposal returns the same promise. No timer, retry, reconciliation, or
callback can begin after it resolves. The deterministic test scheduler is
reachable only through an internal module excluded by the package's public
`exports`; the release entry point exposes no loss-injection or clock hook.

The separately gated `automatic-overflow-reconciliation` conformance variant
has exercised this same lifecycle after supervised genuine `event-overflow`;
its raw correctness evidence is recorded in `docs/benchmark-results.md` and is
not a performance reading.

The implemented distinct root-recovery operation and required identity-policy
decision are in
`docs/root-replacement-follow-up.md`; neither manual nor automatic
reconciliation adopts a replacement identity.

## Workload and support implications

The public contract is designed for caches, indexes, repository previews, and
other derived state that can be recomputed from conservative path or root
invalidations. A complete batch does not claim a journal entry for every
low-level event. On overflow, topology loss, root replacement, or consumer
pressure, Watchbound prefers an explicit non-complete state and a root boundary
over detailed `create`, `update`, `delete`, or rename claims that may be
incomplete.

That tradeoff is poor for audit logs, exact replication, consumers that cannot
rescan, or applications that require mature cross-platform prebuilds and
historical event queries. Parcel's typed coalesced events and query API remain
the more useful contract for those needs when its public loss and resource
model is acceptable.

The candidate target matrix is x64 and ARM64 GNU/Linux, kernel 5.15 and
glibc at most 2.35, with Node `>=24.15.0 <25`; both GNU/Linux targets are
supported by the checked-in source matrix.
Node-API compatibility or successful loading does not widen that matrix. WSL,
network filesystems, Filesystem in Userspace (FUSE), overlay filesystems,
unusual container mounts, musl, ARMv7, and non-Linux platforms are unqualified
or unsupported. Existing mount points are traversed; no one-filesystem option or
runtime descendant-mount reconciliation is implemented. See
[`support-matrix.md`](support-matrix.md).

A motivating Codex repository preview observed 251,811 Node `fs.watch` calls.
This is only a call count and must not be converted into a directory or unique
inotify-watch count. This repository retains no artifact mapping those calls to
unique paths or directories. The historical 1,001- and 10,001-directory tmpfs
startup ranges do not predict that repository's startup, memory, watch
cardinality, Electron responsiveness, or cancellation latency. The current
cancellation and bounded-delivery contract makes a transient preview a possible
evaluation workload, not an approved integration.
