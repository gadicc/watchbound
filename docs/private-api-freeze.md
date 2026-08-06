# API revision history and current contract

Status: the private `0.2.0` contract is carried by the published public `0.0.1`
bootstrap. Its later documentation commit passed both support lanes, although
the immutable bootstrap still emits `target-pending-clean-ci`. Releases
`1.0.0` and `1.0.1` added and then corrected the promise-aware callback
contract. Release `1.1.0` retains generation-zero initial exclusions and Node
`>=24.15.0 <25` while adding exact x64/ARM64 delivery. Both
target entries are `supported` after exact-commit qualification. Capability
schema 4 is an additive delivery
extension: the schema-3 single-target fields retain their historical meaning
under `support.scope = "legacy-primary-target"`, while packaged-target,
per-target qualification, lane, and current-runtime-match fields are new.

Release `1.2.0` is an additive API revision. It extends the exclusion policy
with recursive exact directory-name pruning and explicitly observed excluded
boundaries, retains the legacy prefix-array form, and advances the public
capability schema to 5 and native binding API to 4. The source manifests
intentionally remain `0.0.0-development`; semantic-release materialized the
published version from the exact qualified source. Publication and target
evidence are recorded in `support-matrix.md`.

The exact private `0.1.0` freeze and its support declaration remain the
historical first qualified baseline.

Callback-specific follow-up items are retained in
[`callback-contract-review.md`](callback-contract-review.md).

The `0.0.1` bootstrap and later releases were separately approved and published
from generated JavaScript package trees. A completed release does not itself
authorize a subsequent publication or consumer integration; source JavaScript
packages remain private and both Rust crates remain `publish = false`.

## Entry points and exports

The public npm package is `watchbound`; JSR uses `@gadicc/watchbound`. The
wrapper has one ESM `.` entry point with `js/index.js` implementation and
`js/index.d.ts` declarations. Its runtime
exports are `capabilities`, `qualifyRoot`, `createEngine`, `subscribe`, `WatchboundError`,
`WatchboundErrorCode`, `WatchboundRetryAfter`, `isWatchboundError`, and
`normalizeWatchboundError`. The declaration file additionally names the types
needed to exhaustively consume those values.

`@gadicc/watchbound-node` is a private package boundary for the wrapper, not a
separately supported consumer API. Rust `watchbound-engine` remains the reusable
filesystem-semantics layer; the Node binding translates representation and
lifecycle only.

`SubscriptionOptions` adds `signal?: AbortSignal`. It applies only while
establishing the subscription. An already-aborted valid request allocates no
native attempt. Later cancellation removes attempt-owned interests and watches,
preserves shared peers, joins final runtime shutdown when applicable, and
rejects with non-retryable `WATCHBOUND_OPERATION_CANCELLED`. Once subscribe
resolves, abort is a no-op and explicit disposal owns the established lifetime.

`SubscriptionOptions.initialExclusions` supplies the complete initial set of
exact normalized root-relative directory prefixes. It is validated before
runtime acquisition and committed at exclusion generation zero before topology
traversal, so excluded directories are not opened or watched during
establishment. The empty prefix excludes the root.

`SubscriptionOptions.excludedDirectoryNames` supplies exact nonempty directory
components to prune at every depth, including future and renamed-in
directories. `SubscriptionOptions.observedExcludedPaths` supplies exact
nonempty root-relative boundaries whose descendants stay pruned while boundary
creation, deletion, rename, replacement, and identity change remain observable.
All three sets share exclusion generation zero. `ExclusionPolicy` names the
whole replacement shape with `prefixes`, `excludedDirectoryNames`, and
`observedExcludedPaths`.

## Observation and callback authority

`subscribe(root, onBatch, options)` and `engine.subscribe(...)` resolve to one
frozen subscription. The callback receives bounded `ChangeBatch` values.
Ordered batches are authoritative: each accepted batch has one monotonic bigint
sequence, one exclusion generation, one root state, one coverage state, and a
bounded set of conservative invalidation paths. A callback may start before the
subscribe promise resolves, and the wrapper records the batch before user code
runs. Operation acknowledgements and native-backed getters may lead callback
observation; they never retroactively grant detailed-event credit.

`initialCoverage` and `initialRootState` are immutable sequence-zero facts.
`observedState` is the immutable baseline or the last batch that entered wrapper
JavaScript. `rootState` and `exclusionGeneration` are live native-backed values.
Root and exclusion generations are independent: exclusions begin at zero and
advance to each explicitly committed value; root generation begins at zero and
increments once per committed explicit recovery.

The v1 callback shape is the union of `(batch, context) => void` and
`(batch, context) => PromiseLike<unknown>`. One stable frozen context supplies
an `AbortSignal` and idempotent `stop(): void`. Promise-like callbacks are
serialized per subscription and hold the native credit until settlement.
Throws and rejections increment `callbackErrors` and later delivery continues.
Explicit disposal aborts the signal and joins pending completion; environment
teardown and GC abandon it. Awaiting disposal or a later same-subscription batch
from the current callback is a documented self-deadlock.

## Coverage, errors, and retry policy

Coverage is the closed union `complete`, reasoned `partial`, or reasoned
`uncertain`. Loss is sticky until an operation earns a conservative boundary;
Watchbound never reconstructs detail it may have missed.

Rejected operations use structured schema-version-2 `WatchboundError` values.
The closed code, operation, and retry-after unions—not messages—are the policy
surface. Retryability is derived from the code. Expected root-candidate
outcomes are successful `not-attached` results with a closed failure-reason
union, not thrown operation errors. The complete schema and retry table are in
`error-contract.md`.

## Resources, exact bytes, and topology operations

`createEngine({ nativeWatchBudget })` owns an optional process-runtime budget
over unique native watches. Equal configurations share one runtime; conflicting
live configurations fail explicitly until final joined disposal. Subscription
`watchLimit` separately counts that subscription's logical directories. Every
queue, batch, scan turn, retry, timer, diagnostic, and native-to-JavaScript
delivery path remains bounded.

One process-wide Linux runtime is shared across environments. Native-to-Node
delivery uses at most one dispatcher per Node environment with pending or
established subscriptions, not one bridge thread per subscription. Each
subscription owns one bounded engine queue, one-entry callback queue, and one
admission credit.
Pressure accounting and delivery failure remain subscription-local; a blocked
same-environment JavaScript loop can still delay every callback in that
environment, while separate Worker environments retain callback progress.
Environment teardown and GC do not depend on JavaScript callbacks or promises
settling. Explicit disposal closes admission first, then waits for an
already-admitted callback to quiesce before finalization.

The native boundary preserves exact Linux path bytes. Roots default to strict
component-by-component symlink rejection. `rootPathPolicy: "resolve-physical"`
instead commits an immutable lexical-to-canonical snapshot exposed as
`resolvedRoot`; all watcher output and exclusion semantics then use the
physical namespace, and later alias changes are not followed. All exclusion
inputs accept strings or `Uint8Array`; invalid UTF-8 child paths remain
available as bytes. Descendant directory symlinks are never followed. The full
contract is in [`symlink-root-contract.md`](symlink-root-contract.md).

`replaceExclusions` accepts either the compatible complete root-relative prefix
array or the complete `ExclusionPolicy` object and atomically commits its shared
generation. Omitted policy-object fields are empty; the array form clears the
two newer sets. Exact directory-name matches prune topology and delivery at
every depth. An observed path overrides only delivery of that excluded boundary
and never topology pruning or symlink policy. `reconcile` preserves root
identity and the whole policy, scans with
watch-before-read ordering, and can earn only a conservative root boundary.
`recoverRoot({ identityPolicy })` is the sole replacement-adoption operation;
it accepts exactly `original-only` or `accept-replacement`, preserves the
lexical root and exclusion generation, and revalidates the captured identity at
every admission and traversal barrier. Automatic reconciliation never adopts a
replacement identity.

## Closed unions and compatibility

Coverage reasons, root attachment/loss/recovery variants, structured error
codes and operations, retry conditions, automatic-reconciliation states, and
support status are closed TypeScript unions. `SupportStatus` contains exactly
`target-pending-clean-ci` and `supported`; the two published target entries emit the
supported value in the published line. The ARMv7 source target emits
`target-pending-clean-ci` until its exact execution evidence passes. Exhaustive
narrowing fixtures compile in the ordinary gate.
The formerly published `support.currentRuntime.supported` boolean is removed as
an intentional breaking change: `targetCompatible` is target-only, and full
host/root qualification requires `qualifyRoot(root)`. Migration guidance is in
[`migrate-root-qualification.md`](migrate-root-qualification.md).
Capability schema 9 and binding API 5 additionally expose full root
qualification, physical-root resolution, and bytes-only physical invalidations
alongside `directoryNameExclusions`, `observedExcludedPaths`, and exact ARM ABI
facts;
loader metadata remains schema 1 and raw native capabilities advance to schema
5. Wrappers and loaders
fail closed against older or newer unproved native contracts.

Patch releases may make compatible fixes, documentation/test changes, and
internal changes that preserve this contract. Any externally observable option,
default, export, callback/batch/result shape, error code, ordering or lifecycle
rule, capability schema, or closed-union addition requires a private minor
version and explicit compatibility review. The wrapper, native package, and
engine versions move in lockstep, and mismatches fail closed. Private 0.x does
not claim major-version stability.

## Disposal

Disposal closes admission, joins already admitted topology work, removes the
subscription's interests, prevents a callback from starting after the promise
resolves, and joins final runtime shutdown. Concurrent or repeated disposal is
idempotent and returns the same outcome. Explicit disposal is the deterministic
lifecycle contract; garbage-collection cleanup remains best effort.

Cancellation before public subscribe success has the same joined no-later-
callback boundary. A callback admitted before cancellation wins may run before
rejection, matching the callback-before-resolution rule, but none can newly
enter afterward.

## Target and exclusions

The current source defines controlled x64, ARM64, and exact ARMv7 hard-float
GNU/Linux source and package targets, a kernel 5.15/glibc 2.35 baseline, Node
`>=24.15.0 <25`, Node-API 6 or newer as an ABI floor, Rust 1.88 or newer, and
pnpm 10.33.2 under trusted stable local roots. Each status-bearing target must
pass its full exact matrix; a target description or successful load is not
qualification evidence.

Unsupported targets include other Node ranges; musl; soft-float, unknown,
big-endian, and non-v7 32-bit ARM; other architectures; non-Linux systems; WSL,
non-ordinary mounts, network/FUSE/overlay filesystems unless separately
qualified; cross-compilation alone, install-time compiler
fallback; and hostile or adversarially mutated roots. Support does not include
consumer integration, Git-ignore policy, UI behavior, or logical workspace
mapping.
