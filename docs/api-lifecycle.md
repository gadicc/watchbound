# API and lifecycle notes

The Rust prototype API is intentionally smaller than the eventual package API.
It exists to make correctness properties executable before stabilizing names.

## Subscription establishment

`Engine::subscribe(root, options)` is synchronous in Rust. It validates the
root, creates the native queue, traverses the initial tree, installs all
available watches, and returns an immutable `initial_coverage` result. Native
events that arrive during traversal remain queued by the kernel and are handled
after the worker starts.

Every component of the root path must be a real, non-symlink directory;
descendant directory symlinks are skipped. The check is path-based rather than
an fd-anchored security boundary. Establishment fails instead of returning
complete coverage if the root vanishes or changes identity during traversal.

An absent `watch_limit` means the engine imposes no product limit; kernel and
process limits still apply and must be reported as partial coverage. The engine
does not contain Codex Desktop's `8192` policy value.

`initial_coverage` never changes. Current coverage travels on later batches.
Deferred-directory counts describe current known gaps rather than cumulative
failure history: deleting a deferred subtree can reduce the count and restore
complete coverage. Still-existing deferred paths are not automatically promoted
in this prototype. Uncertainty is sticky, with stronger loss reasons (notably
native overflow) taking precedence over weaker ones.

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

## Disposal

Rust `dispose` is idempotent, signals the worker, joins it, and drains already
queued batches. Dropping a subscription performs the same joined cleanup.
Statistics remain readable after explicit disposal.

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

Dynamic exclusions are deliberately not faked by unsubscribe/resubscribe.
Their planned contract is a full exclusion-set replacement tagged with a
monotonic generation. The engine worker will apply removal, addition, and the
necessary conservative invalidation as one serialized topology transition and
acknowledge the generation only afterward. Batches will identify the generation
under which paths were selected, and stale or concurrent generations will fail
explicitly. Inputs are byte-exact, normalized root-relative directory prefixes;
Git, glob, workspace, and UI policy remain consumer concerns. The shared-runtime
ordering and transaction design are recorded in `docs/architecture.md` and must
land before this capability is advertised.
