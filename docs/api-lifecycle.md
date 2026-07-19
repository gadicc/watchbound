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

## Future exclusion generations

Dynamic exclusions are deliberately not faked by unsubscribe/resubscribe and
remain disabled. The shared runtime command envelope already reserves a
generation value and every lifecycle command has an acknowledgement boundary.
Their planned contract is a full exclusion-set replacement tagged with a
monotonic generation. The engine worker will apply removal, addition, and the
necessary conservative invalidation as one serialized topology transition and
acknowledge the generation only afterward. Batches will identify the generation
under which paths were selected, and stale or concurrent generations will fail
explicitly. Inputs are byte-exact, normalized root-relative directory prefixes;
Git, glob, workspace, and UI policy remain consumer concerns. The shared-runtime
ordering and transaction design are recorded in `docs/architecture.md` and must
land before this capability is advertised.
