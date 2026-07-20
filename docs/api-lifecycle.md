# API and lifecycle notes

The Rust prototype API is intentionally smaller than the eventual package API.
It exists to make correctness properties executable before stabilizing names.

## Subscription establishment

`Engine::subscribe(root, options)` remains synchronous in Rust. It validates the
root, acquires the process-wide Linux runtime, sends an ordered establishment
command, and waits for its acknowledgement. The shared worker traverses the
initial tree in bounded, round-robin topology turns, installs all available
logical watch interests, and returns an immutable `initial_coverage` result.
Native work and other subscriptions continue between those topology turns.

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
unique native watches. The first live subscription fixes that configuration for
the shared runtime's lifetime. A later subscription requesting a different
bounded value, or bounded versus unbounded operation, fails with
`InvalidInput`; the runtime does not silently choose one engine's value. After
the final subscription performs joined shutdown, the next runtime may use a new
configuration.

`Engine::runtime_stats()` reports the active `native_watch_budget`, unique
`native_watches`, queued `deferred_interests`, subscriptions, inotify instance,
and worker thread. An engine with no live runtime reports the default zero/none
snapshot.

`initial_coverage` never changes. Current coverage travels on later batches.
Deferred-directory counts describe current known gaps rather than cumulative
failure history. Each subscription accounts for its logical watched and
deferred directories independently; the runtime budget accounts only for unique
native watches. Deleting a deferred subtree can reduce the count, while deleting
watched topology or disposing another subscription can return a token and
promote a still-existing deferred interest automatically. A subscription at its
own limit cannot consume a free runtime token.

Promotion installs or shares the native watch before reading the directory,
invalidates the promoted path conservatively, and scans the populated region in
bounded scheduler turns. Its topology barrier keeps current coverage partial
and withholds that invalidation until discovery finishes. The resulting batch
reports complete only if the scan leaves no other gap. Uncertainty is sticky,
with stronger loss reasons (notably native overflow) taking precedence over
weaker ones.

## Delivery

Consumers receive `ChangeBatch` values through a bounded queue. Paths are
absolute filesystem paths in the Rust prototype. They are conservative
invalidations, not promises of one precise low-level event per path.

Sequences begin at one and increase only for successfully delivered batches.
Every batch also has an `exclusion_generation`; all paths in that batch were
selected under exactly that committed exclusion set. Generation zero is used
before the first successful replacement.
If a bounded consumer queue fills, the undelivered detail is replaced by a root
invalidation and uncertain coverage when delivery can resume.

`watchedDirectories` and `deferredDirectories` are live gauges and become zero
after disposal. Event, topology-scan, batch, overflow, callback-error, and bridge
delivery-error counters are cumulative. `batchesDelivered` means queued across
the Rust engine channel; the separate Node bridge counter reports a later
thread-safe-function delivery failure.

The shared worker keeps pending paths, sequence numbers, coverage, and output
channels per subscription. Consumer backpressure therefore degrades only the
affected subscription. Native inotify overflow is different: it is loss on the
shared kernel queue and conservatively makes every live subscription uncertain.

## Disposal

Rust `dispose` is idempotent and safe to call concurrently. The first caller
sends an ordered disposal command; other callers join the same transition. The
worker removes the subscription's logical interests and acknowledges only after
no later enqueue for it can begin, then the handle drains already queued
batches. A shared kernel watch remains installed while any other logical
interest needs it. Disposal of the final subscription additionally shuts down
and joins the runtime and closes its inotify and command-wakeup descriptors.
Dropping a subscription performs the same cleanup. Returned final-interest
tokens are offered round-robin to other subscriptions before they need any
resubscription. Statistics remain readable after explicit disposal; its logical
watched/deferred counts are zero.

The Node layer exposes asynchronous disposal so the JavaScript event loop can
continue draining or cancelling the bounded Node-API bridge while the Rust
worker joins. Its stronger user-visible guarantee is: once the disposal promise
resolves, no callback for that subscription can begin.

Synchronous JavaScript callback throws increment `callbackErrors` and do not
stop later delivery. A Node thread-safe-function delivery failure increments
`bridgeDeliveryErrors`, terminates the bridge, and makes joined disposal reject.
The wrapper retains its callback through the returned subscription while the
native callback holds only a `WeakRef`. Callers must therefore retain the
subscription for callback delivery; dropping it permits best-effort GC cleanup,
including when the callback captures the subscription. Explicit `dispose()` is
the only deterministic cleanup guarantee.

## Exclusion configuration and lifetime

Rust exposes `replace_exclusions(generation, Vec<PathBuf>)` on `Subscription`
and its cloneable `ExclusionHandle`; both return the coverage snapshot committed
by the acknowledgement. `exclusion_generation()` reports the last acknowledged
value. The Node proof exposes the same operation asynchronously with `Buffer`
prefixes and bigint generations. The JavaScript wrapper accepts strings or
`Uint8Array`s and exposes a live bigint `exclusionGeneration` getter. The
`dynamicExclusions` capability is true on all three implemented surfaces.

Each call supplies the complete replacement set. Prefixes are normalized,
root-relative directory namespaces and are compared using exact Linux bytes.
The empty prefix denotes the root; `.` is non-normal and rejected. Absolute,
parent-traversing, repeated-separator, trailing-separator, and NUL-containing
inputs are rejected. A nonexistent prefix is valid and filters a directory
created there later. Duplicate and descendant-redundant entries have the same
meaning as their minimal prefix set. The engine does not interpret Git ignores,
globs, workspace mapping, or application defaults.

Generations start at zero and successful requested values must be strictly
greater than the committed value; they need not be consecutive. Duplicate,
stale, and lower values are rejected without changing state. Only one update
may be in flight per subscription, so a conflicting concurrent request is
rejected rather than queued or reordered. Other subscriptions retain their own
generation and allocator state.

The worker first completes that subscription's active topology work and closes
the old-generation pending-batch boundary. It then removes newly excluded
logical interests in bounded chunks, returns final native-watch tokens between
allocator turns, and scans newly included regions using watch-before-read
discovery in bounded scheduler turns. A scan
that cannot obtain a subscription slot or runtime token records truthful partial
coverage and enters ordinary fair deferred promotion. Re-included prefixes are
conservatively invalidated only after their topology barrier completes because
changes made while excluded cannot be reconstructed.

Acknowledgement publishes the new generation only after the exclusion set,
topology, allocator accounting, and coverage snapshot are committed. It does
not wait for the JavaScript callback to consume the resulting invalidation.
Disposal and updates serialize through the subscription lifecycle: an active
update completes or is explicitly interrupted before joined disposal returns,
and a new update cannot begin after disposal. Exclusion configuration lives only
for that subscription and is released with its topology, deferred records,
watches, descriptors, and final worker shutdown.

Remaining gaps are automatic retry for non-budget native failures and
same-path root replacement recovery. Exclusions deliberately do not add
Git/glob policy, detailed event kinds, rename reconstruction, or cross-platform
support.

## Reconciliation and recovery

Rust exposes synchronous `reconcile()` on `Subscription` and cloneable
`ReconciliationHandle`. Node and the JavaScript wrapper expose the same worker
barrier as an asynchronous method. Its result contains the unchanged
`exclusionGeneration` and the committed final `coverage`; the
`reconciliation` capability advertises the complete surface.

The recoverable sticky reasons are `event-overflow`, `topology-race`, and
`consumer-backpressure`. Reconciliation never synthesizes the detailed events
that may have been lost. It closes the existing pending batch boundary, checks
the original root identity, scans only the topology included by the current
committed exclusions, installs or shares a watch before reading each directory,
and performs bounded mark-and-sweep cleanup of stale watched, deferred, and
promotion state. The operation can yield between scheduler turns, while its
subscription continues to expose the previous committed resource gauges.

The exclusion set and generation cannot change during this barrier. A
concurrent reconciliation or exclusion update fails with `WouldBlock`. Events
observed while scanning are conservatively represented by the final root
invalidation, and a directory topology event extends the scan barrier. Batches
remain single-generation and sequences advance only when the bounded engine
queue accepts a batch.

Successful acknowledgement occurs after the scan and stale-interest sweep,
root revalidation, final allocator/coverage publication, and enqueue of the
root invalidation. Only that successful enqueue permits the uncertainty present
at the start to clear. A new loss during the barrier remains uncertain. If the
queue is full, the promise/reconciliation call rejects with a backpressure
error and the subscription stays uncertain with a pending root invalidation.
The acknowledgement does not imply that a JavaScript callback has already run.

Known `root-replaced` uncertainty is rejected, and a root identity change found
at either validation point fails reconciliation while retaining
`root-replaced`. Same-path replacement attachment remains out of scope.
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
callbacks, watches, descriptors, bridge state, and the final worker do not
survive the lifecycle boundary.

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

## Opt-in automatic reconciliation policy

The JavaScript wrapper accepts `automaticReconciliation: true` or a bounded
options object with `maxAttempts`, `initialDelayMs`, and `maxDelayMs`. It is
disabled by default. Defaults are three attempts, 25 ms initial delay, and a
1,000 ms cap; public validation limits attempts to 16 and delays to 10–60,000
ms. The delay for attempt N is `min(initialDelayMs * 2^(N-1), maxDelayMs)`.

The policy observes native batch coverage before invoking the user's callback.
Only `event-overflow`, `topology-race`, and `consumer-backpressure` set its one
pending-loss bit. Repeats before the timer fires are coalesced. A loss during a
barrier requests exactly one later attempt after the active call settles. A
loss that happens after the native root enqueue but before its callback is a
later ordered batch; when that batch reaches JavaScript it begins a fresh
bounded cycle. No attempt overlaps another.

Automatic calls use the original subscription and the same native transaction
gate. A simultaneous manual reconciliation or exclusion replacement therefore
retains the existing explicit `WouldBlock`/topology-transaction conflict;
nothing is silently queued or reordered. A conflict can consume one bounded
automatic attempt. Exclusion generations, sequences, coverage, and the
root-only boundary remain native results. Detailed lost events are never
reconstructed or credited.

`subscription.automaticReconciliation` is one immutable current snapshot, not
an unbounded history. It reports scheduled/reconciling progress, successful
coverage and generation, terminal incomplete coverage, bounded retry
exhaustion with a capped error message, `root-replaced` as blocked, and disposal
state. Exhaustion latches the automatic policy rather than restarting on every
batch carrying sticky uncertainty; explicit manual reconciliation remains
available. Root replacement cancels a pending timer and can never receive
automatic recovery credit.

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

Same-path root replacement remains a separate milestone; see
`docs/root-replacement-follow-up.md`.
