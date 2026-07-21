# Feasibility architecture and decision record

Status: the Linux feasibility engine now includes the directory-burst
correctness gate, shared process-wide runtime, bounded fair native-watch
allocator, generation-based atomic dynamic exclusions, bounded post-loss
reconciliation, and an opt-in JavaScript automatic policy in targeted stress,
plus explicit identity-policy-gated root replacement recovery,
without product integration or publication.

The subsequent consumer/API audit recommends a maintained unpublished package,
conditional on named ownership and a narrow support target, but explicitly
does not authorize packaging, publishing, prebuilds, or integration. See
`docs/consumer-api-stabilization.md`.

## Decision

Build a small Linux-only Rust prototype around inotify, plus a thin Node-API
proof, before deciding whether Watchbound should become a maintained package.
Do not add macOS or Windows backends, Codex policy, publishing machinery, or a
generic backend interface in this milestone.

The completed measurement gate supports continuing the Linux engine: at 10,000
directories Watchbound was faster and used less incremental RSS than Parcel in
this tmpfs series, while exposing overflow and coverage loss that Parcel hid.
This is not yet approval to integrate it. The directory-topology race and
shared-runtime, allocator, dynamic-exclusion, and explicit-reconciliation gaps
are addressed in targeted tests here. See
`docs/benchmark-results.md`.

Watchbound is justified only by a stronger contract than “recursively report
filesystem events”:

> A resource-aware recursive watcher that never silently claims more coverage
> than it has.

Parcel remains the default alternative. It is mature, cross-platform, native,
fast to subscribe, and already batches native-to-JavaScript delivery. A thin
Parcel wrapper should win if explicit resource bounds and conservative
invalidation can be supplied without owning a watcher engine.

The feasibility case for Watchbound is that a wrapper cannot prevent Parcel
from allocating its initial native watches, cannot atomically change its native
exclusions, and cannot recover information the backend did not surface. This
repository therefore tests the reported Linux gaps independently: populated
moved-in trees, watched-root replacement, overflow visibility, resource
accounting, and bounded delivery.

## Scope and ownership

| Area | Owns now | Must not own |
| --- | --- | --- |
| `engine/` | inotify lifecycle, recursive topology, moved-in scanning, watch accounting, explicit coverage, bounded batches, overflow detection, joined disposal, engine statistics | Codex, Electron, Git, logical workspace paths, launcher logs, application defaults |
| `node/` | Node-API conversion, one bounded bridge per proof subscription, callback lifecycle | topology policy, Git subprocesses, direct V8/libuv APIs |
| `js/` | ergonomic JavaScript entry point and TypeScript declarations | hidden recovery or coverage claims |
| `benches/` | isolated adapters, scenarios, measurements, raw JSON results | product policy or benchmark-only behavior in the engine |
| future consumer | Git ignore decisions, logical path mapping, UI/logging policy, retries above the filesystem engine | Linux descriptors, rename cookies, inotify queue mechanics |

### Decision: opt-in automatic reconciliation belongs in the JavaScript wrapper

The automatic policy is a consumer policy over the existing public
`subscription.reconcile()` barrier, not a new filesystem primitive. The
JavaScript wrapper therefore owns opt-in enablement, loss-notification
coalescing, bounded attempts, bounded exponential-backoff timers, a single
current status snapshot, and joining those timers with disposal. The wrapper
continues using the original native subscription and calls its existing
reconciliation method; it never unsubscribes, resubscribes, invents detailed
events, changes exclusions, or assigns coverage.

The public option is `automaticReconciliation: true | { maxAttempts,
initialDelayMs, maxDelayMs }`, disabled by default. Defaults are deliberately
small and finite (three attempts, 25 ms initial delay, 1,000 ms maximum delay),
and validation applies a 10 ms delay floor plus hard ceilings (16 attempts and
60,000 ms). The subscription exposes one immutable `automaticReconciliation`
status snapshot
rather than an event history, so pending evidence remains bounded and terminal
retry exhaustion or non-recoverable coverage is inspectable without creating
synthetic filesystem batches.

Only `event-overflow`, `topology-race`, and `consumer-backpressure` schedule the
policy. `root-replaced` cancels a pending timer and latches a non-recoverable
status; an active native barrier is joined but cannot be credited as recovery.
One pending-loss bit coalesces notifications before a timer and records a new
barrier requirement during a running attempt. A recoverable loss delivered
after a successful root enqueue starts a new bounded cycle when its later batch
reaches JavaScript. Native batch order, generations, coverage, exclusion
transactions, and the singleton root boundary remain authoritative.
Before either automatic policy or user code sees a delivered batch, the wrapper
records it as the subscription's frozen `observedState`; callback exceptions do
not roll back that observation.

Automatic calls deliberately use the same native topology transaction gate as
manual reconciliation and exclusion replacement. Conflicts stay explicit and
may consume a bounded retry attempt; the wrapper does not queue or silently
reorder an exclusion update. Disposal first closes the policy admission gate
and cancels its timer, then starts native disposal and joins any active attempt.
This preserves the native rule that no callback or topology work can begin
after disposal resolves.

### Decision: root identity adoption is a distinct explicit engine operation

`reconcile()` remains identity-preserving, and automatic reconciliation never
chooses an identity. Once fixed-size `RootState` evidence reports a lost root,
only `recoverRoot({ identityPolicy: "original-only" | "accept-replacement" })`
can attach the immutable lexical pathname again. The Rust engine owns candidate
capture, ancestry and identity validation, bounded watch-before-read traversal,
coverage, the root-only commit boundary, peer accounting, and interruption.
Node translates the result; JavaScript validates the required policy and
coordinates one user-started call with its automatic-policy status.

Root loss is latched independently of coverage priority and freezes topology
growth. Every successful attachment advances a separate root generation.
Expected filesystem refusals return structured `not-attached` results, while
lifecycle and transaction conflicts reject. The full decision, result schema,
race assumptions, and evidence are in `docs/root-replacement-follow-up.md`.

The Rust code has an internal `backend/linux.rs` module because the Linux state
machine is already a useful implementation boundary. There is no public or
generic backend trait. A second real backend, not a roadmap item, is the point
at which to reconsider that choice.

The prototype uses the `libc` crate directly for the small inotify/poll/eventfd
surface: descriptor creation, watch add/remove, nonblocking reads, command
wakeups, and polling. Each unsafe call has a local ownership or buffer-safety
justification, and event headers are read unaligned from a fixed 64 KiB buffer.
The `inotify` plus `rustix` crates were also evaluated and would reduce
handwritten FFI; that remains a maintainability tradeoff rather than a semantic
dependency.

## Public semantic model

The prototype exposes an `Engine` that establishes independent directory-root
`Subscription`s. `subscribe` returns only after the initial traversal and watch
installation is complete, or after it can report explicit partial coverage.

Coverage is one of:

- complete;
- partial with a resource, permission, or transient reason and watched/deferred
  directory counts;
- uncertain after an event overflow, root lifecycle break, topology race, or
  consumer backpressure.

Each delivered batch has a monotonically increasing subscription-local
sequence, the committed exclusion generation under which all of its paths were
selected, a fixed-size root identity/attachment snapshot and generation, and
conservative invalidated paths. Initial subscriptions and their batches use
generation zero for both independent counters. The immutable
`initialCoverage` and `initialRootState` values form the exact sequence-zero,
exclusion-generation-zero, root-generation-zero establishment baseline.
Detailed create/update/delete or rename claims are deliberately absent from the
first public engine surface.

Ordered batches are authoritative. The JavaScript wrapper exposes one frozen
`observedState` projection of either that baseline or the last batch whose
delivery callback entered JavaScript. It updates this projection before policy
and user callbacks, including callbacks that throw, and preserves a batch that
arrives before subscribe-promise resolution instead of overwriting it with the
baseline. This is deliberately not an atomic native-state read: live
`rootState` and `exclusionGeneration` getters and operation acknowledgements may
be ahead. Acknowledgements never advance `observedState`; when a successful
operation produces no batch, that projection may lag indefinitely.

An existing subscription can request reconciliation without changing its
exclusion set or generation. Reconciliation does not reconstruct event detail:
its successful commit always enqueues one conservative root invalidation. It
can clear `event-overflow`, `topology-race`, or `consumer-backpressure` only
after the rebuilt topology barrier and that bounded enqueue succeed. A later or
stronger loss remains sticky. `root-replaced` is not recoverable through this
operation; a reconciliation request is rejected when root loss is already
known, and root identity is checked again before and after every traversal.
The separate explicit root operation can restore or adopt an identity without
changing the pathname or public subscription.

The output channel and each batch are bounded. If the consumer queue fills, the
engine discards the over-detailed batch, changes coverage to uncertain, and
queues the root itself as the next conservative invalidation. This trades detail
for bounded memory without silently retaining a complete-coverage claim.

`dispose` removes and joins the subscription's runtime state. After it returns,
the shared worker cannot enqueue another batch for that subscription. Disposing
the final subscription also shuts down and joins the native worker. The Node
proof must additionally prevent a queued JavaScript callback from entering
after its asynchronous disposal promise resolves.

## Linux state machine in this milestone

1. Reject a symlink in any root-path component and validate a real directory
   root before sending an establishment command to the process runtime.
2. Lazily create one nonblocking, close-on-exec inotify instance, one
   nonblocking eventfd command wakeup, and one joined worker for all live
   subscriptions in the process.
3. Breadth-first traverse real directories without following descendant
   directory symlinks. Install a logical interest per subscription and path
   until either that subscription's optional limit or the runtime's optional
   unique native-watch budget is reached; continue traversal so every known
   deferred interest is explicit. Interests for the same `(device, inode)`
   attach to one descriptor registry entry and consume one runtime token while
   remaining separate in each subscription's coverage accounting.
4. Read native events on the shared worker and fan them out through the
   descriptor's logical interests. Each subscription deduplicates its own
   conservative paths during its own batch window.
5. On a created or moved-in directory, scan the populated subtree before the
   corresponding batch is made observable. The topology transition is a
   serialization barrier: an expired batch window delays that flush until the
   scan finishes, but does not by itself imply uncertain coverage. Path-count
   and output-queue bounds remain enforced when the event handler returns.
6. On a moved-out or deleted directory, remove that subscription's known
   descendant interests. Remove a kernel watch only after its final logical
   interest is gone. A returned subscription or runtime token immediately
   makes deferred interests eligible for round-robin promotion.
7. On native queue overflow, invalidate every live root and report uncertain
   coverage, because overflow belongs to the shared inotify queue.
8. On root move/delete, invalidate the affected root and report uncertain
   coverage. A 250 ms `(device, inode)` path-identity check also catches
   replacement caused by moving an ancestor without allocating watches outside
   the covered tree. The prototype does not yet reattach to a same-path
   replacement.
9. On unmount or unexpected kernel watch loss, invalidate each interested root
   and report a topology-race uncertainty.
10. On disposal, remove one subscription's interests and allocator state and
    acknowledge only after no later enqueue for it can start. Returned native
    tokens can promote other subscriptions without resubscription. After the
    final subscription, shut down and join the runtime, close both descriptors,
    and release every watch and deferred allocator record.

The symlink validation is a filesystem contract, not an fd-anchored security
boundary against an adversary replacing ancestors between path operations.
Existing mount points are traversed and there is no one-filesystem option.
Runtime mount insertion over a descendant is not observable through inotify;
stable descendant mount topology is therefore an explicit prototype
assumption. Root identity replacement is detected by the periodic check above.

The first prototype used one inotify instance and worker per subscription. The
current slice replaces that shape with a process-wide runtime while retaining
opaque `Engine` and `Subscription` handles. `Engine::runtime_stats()` exposes
live resource gauges for acceptance tests and operational accounting without
exposing descriptors.

## Second-milestone topology-race resolution

The measured directory-burst invalidations were caused by conflating a batch
deadline with a topology-integrity deadline. While handling a directory create,
the worker queues its path, installs the new watch, and reads the directory. If
that work crossed the batch window, the prototype previously marked coverage
uncertain and collapsed all pending paths to the root even though event handling
was serialized and no native loss signal had occurred.

Topology discovery is now allowed to finish before the caller performs the due
flush. This preserves the watch-before-read invariant for populated moved-in
trees, keeps the configured maximum paths per batch and bounded output channel,
and retains interruptible joined disposal. `topology-race` remains reserved for
actual evidence: unmount, unexpected `IN_IGNORED`, malformed or failed native
reads, and poll failures. Event overflow and root replacement keep their
stronger typed reasons.

## Shared runtime assessment

Shared scheduling and reference-counted native allocation also provide the
resource and acknowledgement boundaries used by dynamic exclusions.

### Shared process-wide runtime and allocator

The engine uses one process runtime, one inotify descriptor, one eventfd command
wakeup, and one joined worker. `Engine` and `Subscription` remain opaque handles
to it. The worker owns all filesystem state; establishment and disposal are
ordered commands with completion acknowledgements rather than concurrent
mutations of watcher maps. The same command envelope carries the requested
generation for exclusion updates and returns it on the acknowledgement.

Scheduler turns are explicitly bounded to 16 commands, two native reads and 64
decoded native events, 64 topology directories or 256 directory entries, and
allocator inspection of 16 subscriptions and 64 deferred candidates for the
selected subscription. Runnable topology and allocator subscriptions are
visited round-robin. With a bounded runtime, initial discovery yields after one
new unique native allocation so concurrently runnable large subscriptions can
share the available tokens. A large initial scan, promotion, or moved-in tree
yields between turns so other roots can receive events, while the affected
subscription keeps its topology transition private until its scan completes.
Native parsing also yields when pending topology detail reaches that
subscription's path bound. Per-subscription batch and output-queue bounds remain
unchanged, and backpressure changes only that subscription's coverage.

The descriptor registry holds reference-counted logical `(subscription, path)`
interests because overlapping roots or aliased directory identities can share
one inotify watch descriptor. Each logical interest counts toward its own
subscription's `watch_limit`, watched count, and coverage. The runtime budget
and `native_watches` gauge count unique live kernel watches instead. Adding or
removing an overlapping logical interest therefore neither consumes nor returns
a runtime token; only the first or final interest changes the unique count.

`Engine::new()` preserves the unbounded prototype behavior. A caller can use
`Engine::with_runtime_watch_budget` to request a positive unique-watch budget.
Configuration is fixed for one runtime lifetime: while any subscription keeps
that process runtime alive, every subscribing `Engine` must request exactly the
same bounded value or the same unbounded default. A conflict fails before a
subscription command is admitted. After final joined shutdown, a later runtime
may use a different configuration. `RuntimeStats` reports the active budget,
unique native watches, and queued deferred logical interests; no
application-specific default is embedded in the engine.

### Allocator and promotion state machine

For each discovered real directory, allocation proceeds as follows:

1. An existing logical interest is already watched and needs no allocation.
2. If the subscription's own logical watch limit is full, record a deferred
   subscription-limit interest and continue bounded discovery.
3. Otherwise, if the directory identity already has a native watch, attach the
   logical interest without consuming a runtime token—even when the runtime
   budget is full.
4. If a new unique watch would exceed the runtime budget, record a deferred
   runtime-budget interest and continue bounded discovery.
5. Otherwise install the native watch and record the logical interest. Native
   permission, process-resource, and transient failures remain explicit
   non-complete states rather than being mistaken for budget deferral.

When either a subscription slot or a final native-watch token is returned, the
allocator revisits subscriptions in round-robin order. A subscription at its
own limit is skipped even if runtime tokens are free. Promotion selects a known
deferred interest, installs or shares its watch before opening the directory
iterator, then starts a bounded breadth-first topology job. The promoted path is
always conservatively invalidated because mutations may have occurred while it
was unwatched; the engine does not synthesize reconstructed event detail.
Additional unique descendant watches discovered by that scan remain deferred
and re-enter the round-robin allocator instead of bypassing other runnable
subscriptions. Its own promotion installs the watch before re-reading it; an
already shared descendant can attach without a token.

Promotion is a subscription-local topology barrier. Its pending promotion keeps
coverage partial, and its invalidation cannot flush, until watch-before-read
discovery of that promoted region finishes. Other subscriptions continue native
event delivery and allocator/topology turns. On completion, remaining gaps keep
coverage partial; if none remain, the same conservative batch publishes the
transition to complete. Backpressure or uncertainty on one subscription does
not change another subscription's allocator state. Shared native overflow is
still runtime-wide uncertainty because loss occurs before fan-out.

Joined disposal is a worker command that removes a subscription's logical
interests, flushes or drops its pending delivery according to the existing
contract, acknowledges only after no later enqueue can begin, and shuts down the
process runtime after its final handle is gone. Tests cover shared runtime
cardinality, overlapping roots, concurrent establishment, slow topology scans,
per-root backpressure isolation, bounded fair allocation, subscription-limit
independence, populated-subtree promotion, retained overlapping interests,
token return after deletion and disposal, concurrent repeated disposal, and
final runtime/allocator teardown.

### Generation-based atomic exclusions

`Subscription::replace_exclusions(generation, prefixes)` replaces the complete
set; it is not an incremental add/remove API and does not resubscribe. The Rust
surface accepts `PathBuf`s, the native Node surface accepts `Buffer`s, and the
JavaScript wrapper accepts strings or exact-byte `Uint8Array`s. Linux path bytes
remain unchanged at the native boundary, including non-UTF-8 names.

Each prefix is a byte-exact, normalized, root-relative directory namespace.
Absolute paths, `.`, `..`, repeated or trailing separators, NUL, and any other
non-normal component are rejected before state changes. Because accepted paths
contain only normal relative components, joining them to the established root
cannot escape it. The empty path is the one explicit root prefix: excluding it
removes every logical interest, while replacing it with an empty set re-includes
the root. A prefix need not exist and remains effective when a future directory
of that name is created. Redundant duplicate or descendant prefixes are folded
to their equivalent minimal set. There is no filesystem canonicalization and no
UTF-8 conversion.

Generation zero denotes the initial empty exclusion set. A requested generation
may skip values but must be greater than the committed value. Duplicate, stale,
and lower values fail with `WATCHBOUND_INVALID_ARGUMENT`; a second call while
one transaction is active fails with
`WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT`. Failed validation or a rejected
concurrent call does not consume a generation. `exclusion_generation()` and the
JavaScript `exclusionGeneration` getter change only after acknowledgement.

An update is one subscription-local scheduler transaction:

1. finish already-runnable topology work for that subscription and flush its
   pending paths as an old-generation batch; if backpressure prevents that
   enqueue, retain the existing conservative root/uncertainty behavior;
2. install the new selection generation privately, remove logical interests and
   deferred/promotion state below newly excluded prefixes in bounded chunks,
   and return any final native-watch tokens to the fair allocator between
   chunks;
3. scan newly included prefixes in bounded turns, installing or sharing each
   watch before reading that directory and skipping prefixes still excluded by
   the replacement set;
4. when a subscription or runtime limit prevents that watch-before-read step,
   retain the nearest directory as an explicit deferred interest for ordinary
   round-robin promotion instead of reading ahead and claiming coverage;
5. after every inclusion topology barrier finishes, queue conservative
   invalidations for the newly included prefixes, commit the coverage/resource
   snapshot and generation, and only then acknowledge the caller.

Pending paths carry their selection generation separately from the committed
generation. The transaction may yield to other subscriptions but its topology
barrier prevents a new-generation batch from flushing early; no batch can
contain paths selected under two generations. Mutations racing a newly included
region cannot be reconstructed, so its prefix is invalidated even when its scan
succeeds. Events selected before removal can only leave as an old-generation
batch. Once interests are removed, queued kernel events have no interest for the
updated subscription and cannot leak into a new-generation batch. An overlapping
subscription keeps its interest, watch, generation, coverage, and delivery.

The acknowledgement means the worker has committed the new filter, topology,
logical and unique-watch accounting, deferred allocator state, coverage
snapshot, and generation. It does not mean the consumer callback has already
run; the conservative inclusion invalidation may still be pending in the
bounded output path, and the wrapper must not advance `observedState` from the
acknowledgement. Disposal serializes with an active update, cancels and
acknowledges worker-held update state if necessary, and retains the existing
joined/idempotent no-later-enqueue guarantee.

This design keeps exclusion decisions with consumers while keeping enforcement,
native resource reclamation, and truthful included-topology coverage in the
Rust engine.

### Bounded post-loss reconciliation

`Subscription::reconcile()` and its cloneable command handle run a
subscription-local topology transaction under the currently committed
exclusion set. The exclusion generation is captured by ownership of the worker
state, is not advanced, and tags the required root batch. One shared
per-subscription transaction gate rejects a concurrent reconciliation or
exclusion replacement with `WATCHBOUND_TOPOLOGY_TRANSACTION_CONFLICT`; commands
are never silently reordered across either topology barrier.

The worker first finishes active event/topology work and flushes the pending
batch boundary. It validates the original root `(device, inode)`, then performs
a bounded breadth-first traversal. Every included directory is attached to an
existing shared native watch or receives a new watch before `read_dir`; a
watched path whose current identity no longer matches its descriptor interest
is detached and reallocated before it can be read. Excluded prefixes are not
opened and remain effective for names created later. Exact `PathBuf` bytes are
used throughout.

Traversal records encountered logical paths. After the scan barrier, bounded
cursor-based passes sweep unencountered watched interests, deferred interests,
the deferred-order queue, and pending promotions. Removing a final shared
interest returns its native token; removing only one overlapping interest
leaves the other subscription and descriptor intact. Subscription limits and
the runtime unique-watch budget produce the same truthful partial coverage and
ordinary round-robin deferred promotion as establishment. An unwatched
directory is retained as one deferred subtree root and is not read merely to
invent descendant accounting.

Scheduler work remains capped at the existing directory and entry limits, and
the reconciling subscription's public watched/deferred gauges remain at their
previous committed values until the final sweep. Other subscriptions continue
native delivery and allocator service between turns. Events during the
transaction are collapsed to the root; directory-create events can extend and
restart the scan barrier, but no reconstructed detail is claimed.

At commit the root identity is validated again. The worker computes the final
coverage, attempts the single root batch in the bounded output queue, and only
then clears the recoverable uncertainty captured at transaction start. A new
loss increments the subscription's uncertainty epoch and therefore survives
the commit. If the root batch cannot enter the queue, reconciliation returns
`WATCHBOUND_CONSUMER_BACKPRESSURE`, retains explicit
`consumer-backpressure` (or a stronger new loss), and leaves a pending root
invalidation instead of acknowledging success.
Successful acknowledgement means the topology, logical interests, watch and
deferred accounting, final coverage snapshot, root invalidation, and unchanged
exclusion generation have all committed; it still does not wait for a Node or
JavaScript callback to run or advance the wrapper's `observedState`.

### Explicit root recovery transaction

Root loss stops promotions and lexical topology growth independently of the
single visible coverage reason. The explicit recovery transaction shares the
existing per-subscription gate, captures one policy-authorized candidate,
removes old logical state in bounded turns, and scans the candidate with the
same exclusion generation, shared allocator, fairness, and watch-before-read
rules. Identity checks around watch installation and after traversal prevent an
ordinary same-path swap from receiving candidate credit; symlink ancestry is
rejected rather than followed.

Commit publishes the accepted identity, advances root generation once, and
attempts exactly one root-only boundary. Output pressure can leave the identity
attached but coverage uncertain without a boundary sequence; it cannot be
reported as complete. Candidate changes fail with bounded cleanup and leave
root loss latched. Peers retain shared old interests and continue event and
topology turns. Joined disposal interrupts or follows the admitted transaction
without permitting later enqueue or callback entry.

Disposal removes any pending reconciliation, completes its acknowledgement
with interruption, releases its scan/sweep state and interests, and joins the
same subscription and final-runtime barriers as ordinary disposal. No new
reconciliation can enter after lifecycle disposal begins or after disposal has
resolved.

### Public reconciliation conformance

The standalone harness exercises this barrier through the Node/JavaScript
public subscription and the Watchbound adapter rather than through an engine
test handle. It deterministically blocks a JavaScript callback long enough to
fill the bounded native output path and observes typed
`consumer-backpressure`; after the path drains, it calls `reconcile()` on that
same subscription. Capability gating requires the complete public method,
explicit coverage, typed backpressure, and atomic exclusions. Codex and Parcel
are excluded with reasons rather than asked to approximate semantics their
public APIs do not expose.

The scenario keeps a committed nonzero exclusion generation unchanged, checks
that no batch mixes generations, mutates included and excluded topology during
the uncertain/reconciliation interval, and requires exactly one root-only
conservative recovery boundary whose final coverage matches the public result.
The acknowledgement can precede JavaScript observation of that boundary: it
proves the root batch entered the bounded native path, not that its callback
already ran. A second subscription must retain complete generation-zero
coverage and deliver while the primary scan is in progress. A later deep
sentinel and joined final disposal prove continued delivery and cleanup of
watches, descriptors, bridge state, and the worker.

This is deterministic ordinary-development evidence for post-consumer-loss
reconciliation. It does not induce or prove recovery from a real inotify queue
overflow. The supervised forced-overflow scenario remains separately gated on
host preparation. Root identity adoption remains a separate explicit operation,
not part of reconciliation.

The dedicated `overflow-reconciliation` variant reuses the detached
controller-supervised helper and the same public subscription. Its helper must
prove the watcher stopped before mutation, the workload exceeded
`max_queued_events`, and the watcher resumed afterward. Only a typed
`event-overflow` root invalidation plus the native overflow counter can open the
recovery phase; consumer backpressure and harness-only synthetic uncertainty
cannot receive genuine-overflow credit. After the bounded output path drains,
the harness mutates while coverage is still uncertain and invokes the original
subscription's `reconcile()`.

The recovery commit remains one singleton root batch, with one sequence and
one unchanged exclusion generation, whose coverage equals the public result.
Acknowledgement follows bounded root enqueue, not necessarily callback entry.
A second subscription retains explicit truthful coverage and delivery while
the primary bounded scan yields. Joined disposal restores subscription state,
watches, the shared inotify descriptor and eventfd, both bridges, and the final
runtime worker. This machinery is separately permission-gated. Explicitly
confirmed targeted manual and automatic trials exercised and passed this
contract through the public surface; both remain correctness evidence rather
than performance results. The automatic variant enables the wrapper policy and
requires zero harness calls to the manual method. Explicit root recovery has a
separate ordinary conformance scenario and never runs from this policy.

## Binding decision

Use Node-API rather than direct V8 or libuv calls. The concrete crate choice is
recorded in `docs/node-binding.md` after a buildable proof. Binding code must
remain a representation/lifecycle bridge; filesystem decisions stay in the
engine.

## Stop/go criteria

Continue building Watchbound only if all of the following remain true after the
repeatable benchmark suite is run:

1. Normal deep changes and post-move changes in populated incoming trees have no
   misses across repeated runs.
2. Watch-limit exhaustion, root lifecycle loss, native overflow, and bridge
   backpressure each produce explicit non-complete coverage.
3. Disposal is deterministic and no JavaScript callback starts after disposal
   resolves.
4. Watch accounting is one per covered directory plus any explicitly documented
   root-lifecycle overhead.
5. Startup and steady-state memory remain close enough to Parcel that the added
   contract, not accidental implementation overhead, explains the tradeoff.
   RSS is treated as a noisy range; a repeatable multi-fold regression is a stop
   signal, while small single-run differences are not.
6. The Linux state machine stays small enough to audit and its failure states can
   be exercised without an application-specific test harness.

Prefer Parcel plus a wrapper if the missing semantics can be implemented using
its public API, if independent conformance no longer reproduces the correctness
gaps, or if Watchbound cannot approach its native resource/startup profile.

Change direction—most likely an upstream Parcel contribution or a narrowly
maintained Linux backend fork—if the required behavior needs invasive native
work but duplicating the surrounding cross-platform product is not sustainable.

## Deliberate gaps

- runtime-budget resizing or weighted/prioritized allocation (configuration is
  fixed and fairness is round-robin among runnable subscriptions);
- automatic retry policy for permission, transient, or kernel/process resource
  allocation failures that were not caused by the configured budgets;
- event-driven root-parent anchoring (ancestor/path identity loss is currently
  detected by periodic lexical validation rather than an ancestor watch);
- automatic root identity selection (reconciliation deliberately rejects
  `root-replaced`; only the explicit policy-gated operation in
  `docs/root-replacement-follow-up.md` can adopt a candidate);
- reconstructed detail for events lost before/during reconciliation (manual and
  automatic recovery both remain root-only);
- runtime descendant mount insertion/reconciliation and a one-filesystem mode;
- detailed change kinds and rename pairing;
- native prebuild production and package publishing;
- all non-Linux platforms.
