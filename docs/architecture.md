# Feasibility architecture and decision record

Status: first Linux feasibility milestone complete; the second-milestone
directory-burst correctness gate, shared process-wide runtime, and bounded
native-watch allocator with fair promotion are implemented in targeted stress,
without product integration or publication.

## Decision

Build a small Linux-only Rust prototype around inotify, plus a thin Node-API
proof, before deciding whether Watchbound should become a maintained package.
Do not add macOS or Windows backends, Codex policy, publishing machinery, or a
generic backend interface in this milestone.

The completed measurement gate supports continuing the Linux engine: at 10,000
directories Watchbound was faster and used less incremental RSS than Parcel in
this tmpfs series, while exposing overflow and coverage loss that Parcel hid.
This is not yet approval to integrate it. The directory-topology race and
shared-runtime gap are addressed in targeted tests here; dynamic exclusions and
the remaining allocator work are still deliberate gaps. See
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
sequence and conservative invalidated paths. Detailed create/update/delete or
rename claims are deliberately absent from the first public engine surface.

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

Shared scheduling and reference-counted native allocation now precede dynamic
exclusions. Exclusion updates still need a serialized topology transaction and
acknowledgement boundary, but can extend the runtime's existing command envelope
instead of replacing its lifecycle.

### Shared process-wide runtime and allocator

The engine uses one process runtime, one inotify descriptor, one eventfd command
wakeup, and one joined worker. `Engine` and `Subscription` remain opaque handles
to it. The worker owns all filesystem state; establishment and disposal are
ordered commands with completion acknowledgements rather than concurrent
mutations of watcher maps. The command envelope already carries a generation
field reserved for exclusion updates, while dynamic exclusions remain disabled.

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

The caller should supply a complete set of root-relative directory prefixes and
a strictly increasing generation. The engine validates that the byte-exact
paths are normalized, relative, and contained by the root; it does not interpret
Git ignores, globs, workspace mappings, or UI policy. Coverage means coverage of
the included filesystem topology, and batches carry the exclusion generation
under which their paths were selected.

An update is one subscription-local scheduler transaction:

1. finish the active event/topology step and flush pending paths tagged with the
   old generation;
2. remove logical watch interests below newly excluded prefixes;
3. scan newly included prefixes with the same watch-before-read and resource
   accounting rules as ordinary topology discovery;
4. conservatively invalidate the changed prefixes, split across bounded batches
   or the root if detail cannot be retained;
5. publish and acknowledge the new generation only after the topology and
   coverage snapshot are committed.

The transaction may yield to other subscriptions but not expose a mixed
generation for its own root. Mutations racing a newly included region cannot be
reconstructed, so the changed prefix is invalidated even when its scan succeeds.
Events already queued for a newly excluded watch are suppressed after the
generation boundary; unexpected watch loss still degrades coverage. Concurrent
or stale-generation requests fail explicitly rather than being reordered.

This design keeps exclusion decisions with consumers while keeping enforcement,
native resource reclamation, and truthful included-topology coverage in the
Rust engine.

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
- event-driven root-parent anchoring and same-path replacement recovery (the
  prototype currently detects lexical root identity loss by polling);
- generation-based atomic exclusion updates;
- reconciliation that returns uncertain coverage to complete after overflow;
- runtime descendant mount insertion/reconciliation and a one-filesystem mode;
- detailed change kinds and rename pairing;
- native prebuild production and package publishing;
- all non-Linux platforms.
