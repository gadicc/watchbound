# Private 0.1.0 API freeze

Status: frozen private API on 2026-07-21. The exact 0.1.0 freeze passed both
clean target lanes, and the subsequent support-qualification declaration emits
`supported` for only the recorded narrow target. That declaration is accepted
only after its exact commit also passes both lanes.

This freeze does not publish a package or crate, create a release or tag,
produce or distribute a prebuild, upload an artifact, or authorize consumer
integration. All JavaScript packages remain private and both Rust crates remain
`publish = false`.

## Entry points and exports

The public package is `@gadicc/watchbound` and has one ESM `.` entry point with
`js/index.js` implementation and `js/index.d.ts` declarations. Its runtime
exports are `capabilities`, `createEngine`, `subscribe`, `WatchboundError`,
`WatchboundErrorCode`, `WatchboundRetryAfter`, `isWatchboundError`, and
`normalizeWatchboundError`. The declaration file additionally names the types
needed to exhaustively consume those values.

`@gadicc/watchbound-node` is a private package boundary for the wrapper, not a
separately supported consumer API. Rust `watchbound-engine` remains the reusable
filesystem-semantics layer; the Node binding translates representation and
lifecycle only.

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

## Coverage, errors, and retry policy

Coverage is the closed union `complete`, reasoned `partial`, or reasoned
`uncertain`. Loss is sticky until an operation earns a conservative boundary;
Watchbound never reconstructs detail it may have missed.

Rejected operations use structured schema-version-1 `WatchboundError` values.
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

The native boundary preserves exact Linux path bytes. Roots are JavaScript
strings whose lexical components are retained through native symlink
validation. Exclusion prefixes accept strings or `Uint8Array`; invalid UTF-8
child paths remain available as bytes and collapse string invalidation to the
representable root. Directory symlinks are never followed.

`replaceExclusions` atomically commits a complete root-relative prefix set and
generation. `reconcile` preserves root identity and exclusions, scans with
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
`target-pending-clean-ci` and `supported`; the qualified 0.1.0 API emits
`supported`. Exhaustive narrowing fixtures compile in the ordinary gate.

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

## Target and exclusions

The only supported target is a controlled source build on Ubuntu 24.04
x86_64, Linux 6.8 or newer within that support line, glibc 2.39, Node
`>=24.18.0 <25`, Node-API 6 or newer as an ABI floor, Rust 1.88 or newer,
pnpm 10.33.2, and a working Ubuntu C toolchain under trusted stable local roots.

Unsupported targets include other Node ranges, distributions or glibc
versions; musl; arm64 and other architectures; non-Linux systems; WSL,
non-ordinary mounts, network/FUSE/overlay filesystems unless separately
qualified; prebuilt installation, cross-compilation, install-time compiler
fallback; and hostile or adversarially mutated roots. Support does not include
publication, prebuilds, consumer integration, Git-ignore policy, UI behavior,
or logical workspace mapping.
