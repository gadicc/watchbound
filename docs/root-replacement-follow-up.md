# Root identity recovery decision

Status: approved and implemented on 2026-07-20. `rootReplacementRecovery` is
true across the engine, Node binding, wrapper, and conformance adapter.
`reconcile()` still rejects known `root-replaced`, automatic reconciliation
still never adopts an identity, and explicit recovery requires a policy on
every call.

## Decision

Do not make `reconcile()` attach to whatever now occupies the same pathname.
The implemented API adds a distinct, explicit root-recovery operation. The
caller must provide an identity policy on every call:

- `original-only` permits recovery only when the originally accepted
  `(device, inode)` is back at the immutable lexical root;
- `accept-replacement` permits adoption of the one real-directory identity
  captured at the start of that call.

There is no permissive default and no new path argument. A call authorizes at
most the captured candidate. If the candidate changes during the barrier, the
operation stops with an explicit non-attached result; it never follows the
newer identity automatically. A caller may inspect that result and initiate a
new explicit attempt.

Replacement is therefore acceptable only as an overt path-oriented consumer
decision. Ordinary reconciliation remains an identity-preserving operation.
The JavaScript automatic policy must never call root recovery.

## Ownership

The Rust engine owns identity capture, root-loss latching, ancestry validation,
watch-before-read traversal, exclusion enforcement, shared-watch accounting,
fair scheduling, coverage, root-boundary enqueue, and joined interruption. The
Node layer only translates fixed-size identities/results and runs the blocking
engine operation as an asynchronous task. The JavaScript wrapper validates the
required policy string, exposes ergonomic immutable results, and coordinates
its existing automatic-reconciliation status around an explicit user call.

The consumer decides whether a new identity is acceptable and what a root
invalidation means for its logical workspace. No Git, UI, retry, or arbitrary
retargeting policy belongs in the engine.

## Identity and public evidence

`(device, inode)` remains the prototype's Linux identity evidence. It is not a
cryptographic identity and does not claim protection against adversarial inode
reuse. The existing stable-local-filesystem and non-adversarial-path assumptions
remain explicit.

Root identity loss must be latched independently of `Coverage`. Today coverage
stores one reason by priority, so an `event-overflow` can mask simultaneous
root loss even though the subscription must not grow topology at a replacement
path. The fixed-size `RootState` is carried on every batch. `initialRootState`
is the immutable establishment snapshot, while the native-backed `rootState`
getter is the current published native snapshot:

```ts
interface RootIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

interface RootState {
  readonly generation: bigint;
  readonly identity: RootIdentity; // last explicitly accepted identity
  readonly attachment: "attached" | "lost";
  readonly lossEvidence?:
    | "root-self-event"
    | "root-watch-loss"
    | "path-identity-mismatch"
    | "multiple";
}
```

Generation zero identifies initial establishment. It advances exactly once for
each committed root recovery, including restoration of the original identity,
so batches before and after a loss cannot be confused even when `(device,
inode)` is unchanged. `ChangeBatch` gains its immutable `rootState` snapshot;
the exclusion generation remains independent.

The JavaScript wrapper's frozen `observedState.rootState` is distinct from the
live getter. It starts at the exact sequence-zero, exclusion-generation-zero,
root-generation-zero `initialCoverage`/`initialRootState` baseline, then changes
only when an ordered batch callback enters JavaScript. The wrapper updates it
before automatic policy and user callback code, so even a throwing callback has
observed the new root state. A recovery acknowledgement and the live getter may
be ahead; neither advances `observedState`, and an attached recovery that emits
no boundary can leave it behind indefinitely.

Direct root `IN_MOVE_SELF`/`IN_DELETE_SELF`, unexpected loss of the root watch,
and periodic lexical-path identity mismatch record different evidence. A path
mismatch can establish that the accepted identity is no longer at the path; it
must not claim which ancestor operation caused it. Multiple observations fold
to one bounded `multiple` value rather than an event history.

Once root loss is latched, that subscription may deliver only conservative root
invalidation and existing queued earlier sequences. It must not promote a
deferred path, extend a moved-in topology job, begin an exclusion traversal, or
otherwise add a lexical-path interest. An active topology transaction is
interrupted explicitly. Existing old-identity interests may remain until root
recovery or disposal, and overlapping subscriptions retain their independent
interests.

## Implemented operation and result

The surfaces are Rust `recover_root`, Node/JavaScript `recoverRoot`, and a
cloneable Rust `RootRecoveryHandle`. Names can still change before API
stabilization, but the distinct operation and required policy cannot.

```ts
type RootIdentityPolicy = "original-only" | "accept-replacement";

interface RootRecoveryResult {
  readonly attachment:
    | "original-restored"
    | "replacement-adopted"
    | "not-attached";
  readonly reason?:
    | "replacement-not-accepted"
    | "candidate-missing"
    | "candidate-not-directory"
    | "symlink-ancestry"
    | "identity-unstable"
    | "root-watch-unavailable";
  readonly previousRootState: RootState;
  readonly candidateIdentity?: RootIdentity;
  readonly currentRootState: RootState;
  readonly exclusionGeneration: bigint;
  readonly coverage: Coverage;
  readonly boundarySequence: bigint | null;
}

recoverRoot(options: {
  identityPolicy: RootIdentityPolicy;
}): Promise<RootRecoveryResult>;
```

Expected filesystem outcomes return a structured result. Invalid arguments,
an inactive lifecycle, a concurrent topology transaction, interruption by
disposal, and internal invariant failures reject the call. `not-attached`
retains the old lost `RootState` and explicit non-complete coverage.

`original-restored` and `replacement-adopted` state exactly which identity
decision committed. Complete or partial coverage plus a non-null boundary
sequence means the root-only boundary entered the bounded native output queue.
It does not mean the callback has entered JavaScript and does not advance
`observedState` ahead of that callback.
If identity attachment commits but a new loss or output pressure prevents that
claim, the result retains the adopted/restored state but returns uncertain
coverage and a null boundary sequence. A pending root invalidation remains, and
ordinary identity-preserving `reconcile()` may recover it. Adoption is never
misreported as complete recovery.

## Recovery transaction

Root recovery uses the existing per-subscription topology transaction gate and
the shared worker; it never creates a second public subscription, resets the
subscription sequence, or unsubscribes/resubscribes behind the consumer.

1. Reject the request unless the subscription is active, root loss is latched,
   and no reconciliation, exclusion update, or root recovery is active.
2. Finish or explicitly interrupt old topology work, close its pending batch
   boundary, and capture the committed exclusion generation and uncertainty
   epoch.
3. Re-walk every stored lexical root component without following symlinks,
   then capture one candidate real-directory `(device, inode)`. Initial
   admission preserved every caller-supplied component long enough to validate
   it before lexical `..` reduction; no wrapper may call `path.resolve` before
   that initial native validation.
4. Apply the requested policy to that captured candidate. `original-only`
   refuses a different identity. `accept-replacement` accepts exactly the
   captured candidate, not a later occupant.
5. Stop growth on the old identity and remove this subscription's old watched,
   deferred, promotion, and traversal state in bounded cursor passes. Shared
   native watches remain while peers still own interests. Ensure a root watch
   can be installed or shared before treating the candidate as attachable; do
   not strand the subscription merely to let a peer consume the root's
   transferable token.
6. Install or share each candidate-directory watch before opening its iterator.
   Validate the path identity around watch installation so descriptor reuse or
   a same-path swap cannot associate the captured identity with a different
   watch. Traverse only the committed inclusion set in existing bounded,
   round-robin scheduler turns.
7. Collapse all affected-subscription mutations during removal and traversal
   to the lexical root. Directory events may extend work only when still under
   the same captured candidate and exclusion generation. No event from the gap
   or traversal receives reconstructed-detail credit.
8. Re-walk symlink ancestry and revalidate the candidate root identity after
   traversal. Any identity change fails this call as `identity-unstable`,
   cleans candidate interests in bounded work, and leaves root loss latched.
   There is no internal retry to a different identity.
9. Commit the new/root-restored attachment, increment root generation once,
   publish resource gauges, and attempt exactly one singleton lexical-root
   boundary with the unchanged exclusion generation and new `RootState`.
10. Preserve any stronger or later uncertainty by epoch. Only an accepted root
    boundary can return complete or partial recovery coverage. If enqueue
    fails, the accepted identity remains attached, but coverage becomes
    explicitly uncertain with a pending root invalidation and the result has no
    boundary sequence.

The current path-based validation is not promoted to an fd-anchored security
boundary. `IN_DONT_FOLLOW`, component-by-component ancestry checks, identity
checks around watch installation, and before/after root validation cover the
prototype's non-adversarial race contract. If tests show this cannot prevent
ordinary symlink escape or identity aliasing, implementation stops for an
`openat2`/directory-fd design rather than weakening the claim.

## Exclusions, bounds, and peers

Root recovery captures one committed exclusion generation. Excluded current
and future prefixes are never opened, watched, or delivered. Concurrent
`replaceExclusions`, `reconcile`, or another root recovery fails with the
existing explicit topology-transaction conflict; commands are not queued or
reordered. Exclusion replacement is rejected while root loss is latched so it
cannot become a hidden reattachment path.

Existing caps remain authoritative: commands per turn, native reads/events per
turn, topology directories/entries per turn, allocator inspection, per-batch
paths, output queue capacity, subscription watch limit, and runtime unique-watch
budget. Root recovery adds only one fixed candidate identity, one fixed loss
evidence value, bounded sweep cursors, and at most one pending root boundary.
There is no attempt history and no recovery timer. Repeated calls are explicit
consumer actions.

Peers continue native delivery and allocator/topology turns between bounded
recovery turns. They keep shared old-identity interests, generations, sequences,
and truthful coverage. A kernel overflow remains shared-stream uncertainty for
every affected subscription. Root recovery may attach to an identity already
watched by a peer without consuming a second native token, but it must not
borrow the peer's coverage claim or starve the peer.

## Automatic policy and disposal

Automatic reconciliation remains blocked on root loss and never selects
`accept-replacement`. The wrapper may expose an explicit root-recovery call
while automatic reconciliation is enabled, but the policy needs one bounded
"root recovery in flight" state. It records at most the strongest later loss.
After an attached result, it clears the root block and schedules ordinary
reconciliation only if the result or a later ordered batch remains recoverably
uncertain. A failed/not-attached result remains blocked. This prevents a batch
racing the JavaScript promise from being silently ignored.
Every racing batch advances `observedState` before this policy observes it and
before user callback code begins.

Disposal closes admission before queuing worker removal. A root recovery that
already owns the gate either commits before the ordered disposal command or is
acknowledged as interrupted; disposal joins that acknowledgement, releases all
old/candidate topology and shared interests, then permits final runtime
shutdown. A request that loses the lifecycle race cannot begin filesystem work.
The Node bridge retains its stronger guarantee that no JavaScript callback can
start after the disposal promise resolves, and wrapper timers cannot restart
recovery afterward. Repeated disposal remains the same promise/idempotent
result.

## TDD and conformance evidence

Deterministic tests cover:

- direct-root replacement adoption and original-identity restoration;
- ancestor/path mismatch recovery without ancestor watches or false cause
  claims;
- refusal under `original-only`, missing/non-directory candidates, symlink
  roots, replaced symlink ancestors, and a same-path identity change during
  traversal; deterministic mutation at every internal capture/share/add-watch
  validation barrier remains a readiness gate;
- no promotion, inclusion scan, or exclusion-update reattachment while root
  loss is latched;
- watch-before-read populated-tree coverage and later deep delivery;
- fixed exclusion generation, current/future exclusions, and explicit
  transaction conflicts;
- complete, resource-limited partial, later-loss uncertain, and full-output
  queue results with exact singleton-boundary rules;
- monotonic subscription sequence, root generation, and exact identity evidence
  across the native, Node, JavaScript, and TypeScript surfaces;
- peer delivery/fairness, overlapping old/new identities, and shared overflow
  truthfulness;
- interruption, concurrent idempotent disposal, final resource restoration,
  and no later enqueue, callback, retry, or root recovery.

The ordinary, non-heavy public `root-replacement-recovery` conformance scenario uses temporary direct
and ancestor replacement. It must prove one public subscription, no hidden
unsubscribe/resubscribe, exact recovery result/boundary matching, exclusions,
peer progress, a post-recovery deep sentinel, and joined cleanup. It does not
need forced overflow; destructive or overflow stress remains separately gated.

Its first strict quick Watchbound trial passed all 15 checks on 2026-07-20 with
forced overflow disabled. Final workspace verification is recorded in the
Phase 3 commit handoff. The review specifically covers identity confusion,
symlink escape, watch-after-read, generation mixing, hidden resubscription,
reconstructed detail, bounded work, peer starvation, and disposal leaks.

## Recommendation

The implemented decision is go on this explicit-operation design, but no-go on
automatic identity adoption or extending `reconcile()` to accept a new
identity. The first implementation slice must latch root loss independently
and block every existing hidden topology-growth path before recovery is added.
Stop the milestone if stable candidate identity, watch-before-read ordering,
bounded peer-safe scheduling, or joined disposal cannot be demonstrated without
weakening the conservative contract.
