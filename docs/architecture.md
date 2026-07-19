# Feasibility architecture and decision record

Status: provisional for the first Linux feasibility milestone.

## Decision

Build a small Linux-only Rust prototype around inotify, plus a thin Node-API
proof, before deciding whether Watchbound should become a maintained package.
Do not add macOS or Windows backends, Codex policy, publishing machinery, or a
generic backend interface in this milestone.

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
   corresponding batch is made observable.
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
gap; they must be designed together in the next milestone rather than simulated
by a public abstraction now.

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
