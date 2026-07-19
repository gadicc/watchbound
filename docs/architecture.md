# Feasibility architecture and decision record

Status: first Linux feasibility milestone complete; the second-milestone
directory-burst correctness gate is fixed in targeted stress, without product
integration or publication.

## Decision

Build a small Linux-only Rust prototype around inotify, plus a thin Node-API
proof, before deciding whether Watchbound should become a maintained package.
Do not add macOS or Windows backends, Codex policy, publishing machinery, or a
generic backend interface in this milestone.

The completed measurement gate supports continuing the Linux engine: at 10,000
directories Watchbound was faster and used less incremental RSS than Parcel in
this tmpfs series, while exposing overflow and coverage loss that Parcel hid.
This is not yet approval to integrate it. An intermittent, explicitly reported
directory-topology race and the deliberate multi-root/exclusion gaps must be
resolved in the next milestone. See `docs/benchmark-results.md`.

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

The prototype uses the `libc` crate directly for the small inotify/poll surface:
descriptor creation, watch add/remove, nonblocking reads, and polling. Each
unsafe call has a local ownership or buffer-safety justification, and event
headers are read unaligned from a fixed 64 KiB buffer. The `inotify` plus
`rustix` crates were also evaluated and would reduce handwritten FFI. Revisit
that tradeoff when the next milestone adds a shared descriptor, command wakeup,
and `eventfd`; the current single-subscription worker does not need their wider
abstraction surface.

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

`dispose` requests shutdown and joins the native worker. After it returns, the
engine cannot enqueue another batch. The Node proof must additionally prevent a
queued JavaScript callback from entering after its asynchronous disposal promise
resolves.

## Linux state machine in this milestone

1. Reject a symlink in any root-path component, validate a real directory root,
   and create one nonblocking, close-on-exec inotify instance.
2. Breadth-first traverse real directories without following descendant
   directory symlinks. Install one watch per directory until an optional
   caller-provided limit is reached; continue traversal so deferred accounting
   is explicit.
3. Read native events on a dedicated thread and deduplicate conservative paths
   during a short batch window.
4. On a created or moved-in directory, scan the populated subtree before the
   corresponding batch is made observable. The topology transition is a
   serialization barrier: an expired batch window delays that flush until the
   scan finishes, but does not by itself imply uncertain coverage. Path-count
   and output-queue bounds remain enforced when the event handler returns.
5. On a moved-out or deleted directory, remove known descendant watches.
6. On native queue overflow, invalidate the root and report uncertain coverage.
7. On root move/delete, invalidate the root and report uncertain coverage. A
   250 ms `(device, inode)` path-identity check also catches replacement caused
   by moving an ancestor without allocating watches outside the covered tree.
   The prototype does not yet reattach to a same-path replacement.
8. On unmount or unexpected kernel watch loss, invalidate the root and report a
   topology-race uncertainty.
9. On shutdown, stop, join, close the descriptor, and drop pending output.

The symlink validation is a filesystem contract, not an fd-anchored security
boundary against an adversary replacing ancestors between path operations.
Existing mount points are traversed and there is no one-filesystem option.
Runtime mount insertion over a descendant is not observable through inotify;
stable descendant mount topology is therefore an explicit prototype
assumption. Root identity replacement is detected by the periodic check above.

The first prototype uses one inotify instance and worker per subscription. This
keeps the state machine inspectable while testing semantics. Process-wide fair
allocation and a shared event thread remain the largest deliberate architecture
gap; they must be implemented together rather than simulated by a public
abstraction.

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
actual evidence: unmount, unexpected `IN_IGNORED`, descriptor aliasing, malformed
or failed native reads, and poll failures. Event overflow and root replacement
keep their stronger typed reasons.

## Next architecture assessment

Shared scheduling and allocation must precede dynamic exclusions. Exclusion
updates need a serialized topology transaction and acknowledgement boundary;
building that protocol on the current thread-per-subscription shape would create
a second command/lifecycle design that the shared runtime would immediately
replace.

### Shared process-wide runtime

The next engine shape should use one process runtime, one inotify descriptor,
one command wakeup descriptor, and one joined worker. `Engine` and
`Subscription` remain opaque handles to it. The worker owns all filesystem
state; subscribe, exclusion update, and disposal are commands with completion
acknowledgements rather than concurrent mutations of watcher maps.

The scheduler needs explicit turn bounds for native reads, topology directories,
and commands, with runnable subscriptions visited round-robin. A large initial
scan or moved-in tree may yield between directories so other roots can deliver
events, while the affected subscription keeps its topology transition private
until that scan completes. Per-subscription batch and output-queue bounds remain
unchanged.

Watch allocation has two levels: the existing subscription limit and a new
runtime-wide native-watch budget. A unique kernel watch consumes one global
token. Because one inotify descriptor can return the same watch descriptor for
overlapping roots or aliased inodes, the descriptor registry must hold
reference-counted logical `(subscription, path)` interests and remove the
kernel watch only after the last interest leaves. Each subscription separately
reports watched and deferred directories. Allocation and promotion requests are
served round-robin; resource exhaustion produces partial coverage for the
affected roots rather than allowing the first large root to monopolize tokens.

Joined disposal becomes a worker command that removes a subscription's logical
interests, flushes or drops its pending delivery according to the existing
contract, acknowledges only after no later enqueue can begin, and shuts down the
process runtime after its final handle is gone. Tests must cover overlapping
roots, concurrent establishment, fair exhaustion and promotion, slow topology
scans, per-root backpressure isolation, and disposal during queued work.

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

- process-wide multi-root fairness and one shared inotify event thread;
- event-driven root-parent anchoring and same-path replacement recovery (the
  prototype currently detects lexical root identity loss by polling);
- generation-based atomic exclusion updates;
- reconciliation that returns uncertain coverage to complete after overflow;
- runtime descendant mount insertion/reconciliation and a one-filesystem mode;
- detailed change kinds and rename pairing;
- native prebuild production and package publishing;
- all non-Linux platforms.
