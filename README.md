# Watchbound

Watchbound is an experimental Linux recursive directory watcher maintained as
an unpublished private package. It treats filesystem coverage
as an explicit result rather than an assumption, uses one inotify watch per
included directory, batches invalidations, and reports partial or uncertain
coverage when it cannot safely claim completeness.

The packages remain private and unpublished at the first frozen `0.1.0` API.
The narrow controlled-source-build target below is supported by the recorded
clean CI evidence; private `0.x` does not claim public major-version stability.
It is intentionally independent of Codex Desktop and does not contain
Git-ignore or application policy.

The workspace is divided by ownership:

- `engine/`: reusable Rust engine and Linux inotify state machine.
- `node/`: thin Node-API representation and lifecycle binding.
- `js/`: JavaScript entry point and TypeScript declarations.
- `benches/`: standalone conformance and measurement harnesses.
- `docs/`: architecture, methodology, results, and decisions.

See `docs/architecture.md` and `docs/benchmark-methodology.md` for the design
and evaluation contract. The post-feasibility package recommendation and its
gates are in `docs/consumer-api-stabilization.md`. Rejected operations expose
stable `WATCHBOUND_*` codes under the versioned
[structured error contract](docs/error-contract.md); human messages are
diagnostic rather than a policy surface.

## Threading and workload fit

The native addon is a shared library loaded into the Node or Electron process,
not a helper process. Ordinary native exports would run on and block the
JavaScript thread. Watchbound explicitly runs subscription establishment,
reconciliation, root recovery, exclusion replacement, and joined disposal as
napi-rs asynchronous tasks. Those tasks occupy Node's shared libuv worker pool
while the filesystem state machine runs on one process-wide
`watchbound-linux-runtime` Rust thread.

Every established subscription currently adds one
`watchbound-node-bridge` thread. It receives bounded native batches and crosses
back through a one-entry Node-API thread-safe-function queue; the JavaScript
callback itself still runs on the JavaScript thread. A slow callback can
therefore cause UI latency, but bounded pressure degrades that subscription to
explicit uncertain coverage rather than creating an unbounded callback stream.
The detailed lifecycle and ownership rules are in
[`docs/node-binding.md`](docs/node-binding.md) and
[`docs/api-lifecycle.md`](docs/api-lifecycle.md).

Watchbound fits consumers that can treat paths as conservative invalidations,
recompute derived state after a root invalidation, and act on explicit partial
or uncertain coverage. It is a poor fit for exact filesystem journals,
short-lived enormous roots without cancellable establishment, unsupported
platforms/filesystems, or applications that cannot own a native source-build
and joined-disposal lifecycle.

## Watchbound and `@parcel/watcher`

Parcel remains the default alternative when its public contract is sufficient:
it is mature, published, cross-platform, prebuilt, natively batched, and exposes
typed file events plus historical snapshot queries. This repository compares
Watchbound with exactly `@parcel/watcher` 2.5.6 and forces Parcel's Linux
inotify backend.

| Capability | Watchbound private `0.1.0` | `@parcel/watcher` 2.5.6 |
| --- | --- | --- |
| Delivery and targets | Controlled source build; qualified only for the narrow Linux x64/glibc target below | Published prebuilds across Linux, macOS, Windows, and FreeBSD targets |
| Recursive Linux subscription | Directory-only inotify watches | Directory-only inotify watches |
| Event contract | Conservative invalidated paths; no exact create/update/delete claim | Coalesced `create`, `update`, and `delete` events |
| Native batching | Yes, with bounded path and output queues | Yes, through a native debouncer |
| Historical snapshot query | No | `writeSnapshot()` and `getEventsSince()` |
| Initial static ignores | No glob or Git policy in the engine | Subscribe-time path and glob ignores |
| Active exclusion replacement | Generation-based, exact-byte directory prefixes; atomic per subscription | No public active-subscription update |
| Public watch limits and accounting | Per-subscription logical limit, process native-watch budget, and statistics | No public limit or active-watch accounting |
| Explicit coverage and loss | `complete`, reasoned `partial`, or reasoned `uncertain` | No public coverage state |
| Linux queue overflow | Typed `event-overflow`, root invalidation, and bounded reconciliation | No public loss result; 2.5.6's inotify backend skips `IN_Q_OVERFLOW` |
| Populated moved-in subtree | Recursively discovered before the transition becomes observable | Incoming directory is watched, but existing descendants were not discovered in reproduced 2.5.6 trials |
| Watched-root replacement | Typed loss plus explicit policy-gated recovery | No public recovery; replacement was not watched in reproduced 2.5.6 trials |
| Consumer backpressure | Bounded and subscription-local, with typed uncertainty | No public backpressure state |
| Post-loss reconciliation | Explicit and opt-in bounded automatic reconciliation | No public reconciliation operation |
| Cancel pending establishment | Not currently exposed | Not exposed by the public `subscribe()` API |
| Native delivery thread scaling | One shared runtime plus one bridge thread per subscription | Shared backend and debounce threads; no bridge thread per subscription |
| Node callback admission | One-entry queue plus bounded engine output | Thread-safe-function queue is explicitly unlimited |
| Disposal contract | Idempotent, joined, and no callback may start after resolution | Async `unsubscribe()`; no equivalent public joined/no-later-callback guarantee |

Parcel already has the thread-scaling property sought by a future shared
Watchbound delivery bridge, but not its required bounded callback admission or
typed consumer-backpressure contract. Neither package currently exposes
cancellation for already-started subscription establishment.

The first final tmpfs series measured Watchbound recursive startup at median
32.31–36.59 ms for 10,001 directories, versus 47.42–49.11 ms for Parcel and
239.37–273.05 ms for the exact Codex Linux JavaScript helper. These are
historical feasibility results, not a universal multiplier or evidence for a
251,811-call repository: adapters, callback policies, filesystem, tree shape,
and measurement commits differ. See
[`docs/benchmark-results.md`](docs/benchmark-results.md) for ranges and caveats,
and [`docs/conformance-findings.md`](docs/conformance-findings.md) for the
reproduced capability gaps and tagged-source links.

## Build and test

The manifests intentionally admit only Node `>=24.18.0 <25`, Linux x64, and
glibc. The maintained target is Ubuntu 24.04 with Linux 6.8+, glibc
2.39, Rust 1.88+, pnpm 10.33.2, `build-essential`, and a working C linker; see
[`docs/support-matrix.md`](docs/support-matrix.md). Node-API 6 is the addon ABI
floor, not a broader support claim. Nothing is published.

```sh
pnpm install
pnpm build:node
pnpm test
pnpm check
pnpm test:soak
```

The controlled build produces exactly the local
`node/watchbound.linux-x64-gnu.node` binding. The hand-owned loader accepts no
environment override, optional prebuild package, WASI branch, download, or
runtime compiler fallback, and verifies native/package/API/build identity
before exporting the binding. Generated `.node` binaries and napi-rs's private
declaration output are ignored by Git. See
[`docs/native-delivery.md`](docs/native-delivery.md). The JavaScript wrapper
preserves exact Linux path bytes and conservatively collapses a non-UTF-8 string
invalidation to its root.

`initialCoverage` and `initialRootState` expose the immutable establishment
baseline. `subscription.observedState` is the frozen projection of that baseline
or the last ordered batch whose callback entered JavaScript. It is not a live
native snapshot: operation acknowledgements and native-backed getters may be
ahead, while ordered batches remain authoritative for JavaScript observation.

JavaScript `createEngine({ nativeWatchBudget })` owns an optional process-wide
unique-native-watch budget; `null` means no Watchbound-imposed budget. Creating
an engine is resource-free. The first admitted establishment provisionally
fixes the one loaded native binary's shared runtime configuration, equal
configurations coexist, and a mismatch rejects with
`WATCHBOUND_RUNTIME_CONFIGURATION_CONFLICT` until the final lease is released
and shutdown joins. The top-level `subscribe()` lazily uses one unbounded
default engine. `engine.nativeWatchBudget` is its request, while
`engine.runtimeStats()` describes actual process-global resources.

The deeply frozen, JSON-serializable `capabilities` export has schema version 1
and separates versions/build facts, observed runtime facts, the support target,
features, option defaults and bounds, and observability. Runtime facts do not
widen support: only the approved narrow source-build target has status
`supported`. See [`docs/api-lifecycle.md`](docs/api-lifecycle.md)
and [`docs/support-matrix.md`](docs/support-matrix.md). The frozen private API
surface and compatibility policy are recorded in
[`docs/private-api-freeze.md`](docs/private-api-freeze.md).

## Evaluate

```sh
node benches/conformance.mjs --quick --pretty
node benches/conformance.mjs --adapter watchbound --scenario reconciliation --quick --strict --pretty
node benches/conformance.mjs --adapter watchbound --scenario automatic-reconciliation --quick --strict --pretty
node benches/conformance.mjs --adapter watchbound --scenario root-replacement-recovery --quick --strict --pretty
pnpm test:root-recovery-stress
node benches/conformance.mjs --help
node --expose-gc benches/benchmark.mjs --help
```

The targeted reconciliation and root-recovery commands are
ordinary-development conformance checks. The first calls the explicit
`subscription.reconcile()` primitive; the second enables the JavaScript
wrapper's bounded automatic policy; the third exercises explicit direct and
ancestor replacement recovery on the original subscription. The first two use
deterministic native-to-JavaScript consumer backpressure; the third uses
ordinary temporary-directory replacement. None induces a real inotify queue
overflow. The I/O-heavy forced-overflow
scenarios are removed by `--quick` and require both explicit quiet-host
confirmation and the `--allow-forced-overflow` acknowledgement. The flag is a
safety interlock, not evidence that the host is ready.

`pnpm test:soak` runs 25 bounded lifecycle cycles without inducing overflow
or recording benchmark evidence. It covers deferred promotion, exclusion
replacement, callback failure containment, topology churn, reconciliation,
joined disposal, and final process-resource baselines. The root-recovery stress
command repeats the ordinary direct and ancestor recovery scenario three times;
each phase scans the same bounded 128-to-512-directory replacement tree.

The first final feasibility series is complete. See
`docs/conformance-findings.md` for correctness evidence and
`docs/benchmark-results.md` for raw-artifact identities, ranges, caveats, and
the next-milestone decision.

## Prototype gaps

The current Linux engine shares one process-wide worker and inotify instance,
allocates unique native watches fairly across subscriptions, and implements
generation-based atomic dynamic exclusions. Its public conformance scenario
exercises bounded reconciliation in place on an existing subscription,
including an unchanged exclusion generation, a conservative root boundary,
peer-subscription isolation, post-recovery delivery, and joined cleanup. It
also contains separately gated manual and automatic overflow-reconciliation
scenarios that apply those checks after supervised genuine `event-overflow`.
Confirmed targeted follow-ups passed both public recovery paths; they are
correctness evidence, not new performance readings.

The JavaScript wrapper also offers opt-in `automaticReconciliation`. It is
disabled by default, coalesces the three recoverable uncertainty reasons, uses
finite capped exponential backoff, and exposes only its current bounded status.
It never claims recovered lost detail. `root-replaced` blocks this automatic
policy: it never chooses a
replacement identity. A caller may instead invoke the distinct
`recoverRoot({ identityPolicy })` operation, which revalidates and scans the
same lexical root under an explicit `original-only` or `accept-replacement`
decision and emits one conservative root boundary on success. Non-Linux
backends and published prebuilds remain unsupported and outside the approved
stabilization scope.

## Maintainer and license

Maintainer: Gadi Cohen <dragon@wastelands.net>

Copyright (c) 2026 by Gadi Cohen, [MIT Licensed](LICENSE.txt).
