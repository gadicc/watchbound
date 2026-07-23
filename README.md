# Watchbound

[![npm](https://img.shields.io/npm/v/@gadicc/watchbound)](https://www.npmjs.com/package/@gadicc/watchbound)
[![JSR](https://jsr.io/badges/@gadicc/watchbound)](https://jsr.io/@gadicc/watchbound)
[![JSR score](https://jsr.io/badges/@gadicc/watchbound/score)](https://jsr.io/@gadicc/watchbound)
[![CI](https://github.com/gadicc/watchbound/actions/workflows/ci.yml/badge.svg)](https://github.com/gadicc/watchbound/actions/workflows/ci.yml)
[![release](https://github.com/gadicc/watchbound/actions/workflows/release.yml/badge.svg)](https://github.com/gadicc/watchbound/actions/workflows/release.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.txt)

Watchbound is an experimental Linux recursive directory watcher prepared as an
unpublished release candidate. It treats filesystem coverage as an explicit
result rather than an assumption, records one logical interest per included
directory while overlapping identities can share a native inotify watch,
batches invalidations, and reports partial or uncertain coverage when it cannot
safely claim completeness.

The checked-in workspace packages remain private as an accidental-publish
guard, and no registry release has been made. CI validates controlled public
npm and JSR artifacts. After CI passes on `main`, semantic-release uses
Conventional Commits to decide whether a release is needed and stamps one
lockstep version across both npm packages, JSR, Rust, checksums, and the SBOM.
Manual workflow dispatches run CI but cannot publish. Registry artifacts
identify themselves as a bundled-native delivery for exactly Ubuntu 24.04
x64/glibc 2.39; source workspaces continue to identify as controlled builds.
The first frozen
`0.1.0` API has recorded clean-CI evidence; the cancellable-establishment and
shared-delivery `0.2.0` revision reports `target-pending-clean-ci` until its
exact commit is separately qualified. Private `0.x` does not claim public
major-version stability. It is intentionally independent of Codex Desktop and
does not contain Git-ignore or application policy.

JSR is planned as a distribution channel for the same Node-only package
surface. It does not imply Deno runtime support or widen the qualified
Ubuntu/Node matrix.

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
not a helper process. A process crash or native defect therefore affects the
host process, and ordinary synchronous native exports run on its JavaScript
thread.

The current implementation divides work as follows:

| Execution context | Current work |
| --- | --- |
| JavaScript thread in each Node environment | Module loading and identity checks; wrapper argument, option, and `AbortSignal` handling; prefix encoding; callback normalization; `observedState`; automatic-reconciliation policy; and the consumer callback |
| Node's shared libuv worker pool | One napi-rs asynchronous task for each pending establishment, exclusion replacement, reconciliation, root recovery, or joined disposal |
| One lazy process-wide `watchbound-linux-runtime` Rust thread | inotify polling, recursive topology, native-watch allocation, batching, bounded engine queues, cancellation rollback, and ordered engine acknowledgements |
| At most one `watchbound-node-dispatcher` Rust thread per Node environment with pending, active, or fallback-cleanup registrations | Fairly inspects registrations and admits at most one callback per subscription into its one-entry Node-API thread-safe-function queue |
| At most one transient `watchbound-node-cleanup` Rust thread per affected Node environment | Advances garbage-collection, delivery-failure, or environment-teardown cleanup; a retained dispatcher is the fallback if coordinator creation fails |

Steady state therefore has one Watchbound runtime thread for the loaded native
binding and one dispatcher for each Node environment that owns subscriptions,
not one delivery thread per subscription. Cleanup coordinators are transient.
Node, Electron, libuv, and the operating system may own additional threads that
are outside these Watchbound counts.

The public operations above return promises, but their synchronous preparation
can still pause JavaScript. Importing the addon, validating or copying options,
registering an abort listener, creating an environment registration and
thread-safe function, encoding an exclusion list, reading native-backed getters
or statistics, validating recovery policy, closing disposal admission, and
running a delivered callback all happen on the JavaScript thread. Filesystem
traversal, topology transactions, rollback, and joined engine disposal do not.
Large JavaScript inputs, contended native locks, module loading, or consumer
callback work can still make the synchronous portions noticeable.

A queued napi-rs task does not occupy a libuv pool slot until libuv starts its
compute function. Once started, it retains that slot while it waits for the
Watchbound runtime acknowledgement, including cancellation rollback or final
runtime shutdown. Aborting establishment wakes the Watchbound runtime but does
not remove the napi-rs task from libuv or release a running slot early. A task
still waiting in libuv's queue can settle only after it receives a worker turn.

Subscriptions retain separate bounded engine queues, one-entry Node-API
thread-safe-function queues, and one callback admission credit. The dispatcher
does not drain a second engine batch until the callback returns and restores
that credit. If a consumer remains slow, that subscription's engine queue can
fill; Watchbound drops over-detailed output, marks coverage
`consumer-backpressure`, and retains a conservative root invalidation for later
delivery. A synchronously blocked JavaScript loop also prevents peer callbacks
in that environment from completing, so sustained peer traffic can fill each
peer's own bounded engine queue. Callback progress while another callback is
blocked requires a separate Worker environment.

The detailed lifecycle and ownership rules are in
[`docs/node-binding.md`](docs/node-binding.md) and
[`docs/api-lifecycle.md`](docs/api-lifecycle.md).

Subscription options may include an establishment-only `AbortSignal`.
Cancellation remains joined after native traversal starts: it removes
attempt-owned watches and interests, preserves shared peers, joins a final
runtime shutdown, and prevents a callback from newly entering after rejection.
Once `subscribe()` resolves, aborting that signal is a no-op and callers use
`subscription.dispose()`. Establishment still occupies one shared libuv worker
until native success or rollback completes; queued work may therefore delay
cancellation settlement.

Watchbound fits consumers that can treat paths as conservative invalidations,
recompute derived state after a root invalidation, and act on explicit partial
or uncertain coverage. That model trades ordinary-event precision for truthful
loss handling: Watchbound may invalidate a whole root and require a rescan
instead of claiming exact `create`, `update`, `delete`, or rename history.
Parcel's typed events are more convenient when those coalesced event kinds and
its platform support are the required contract.

Watchbound is a poor fit for exact filesystem journals, per-event audit logs,
consumers that cannot rescan after invalidation, unsupported
platforms/filesystems, or applications that cannot own a native source build
and joined-disposal lifecycle. The intended maintained target is only Ubuntu
24.04, Linux 6.8+ in that support line, x86_64, glibc 2.39, and Node
`>=24.18.0 <25`, built from source under trusted stable local roots; the current
`0.2.0` revision remains `target-pending-clean-ci`. WSL, network filesystems,
Filesystem in Userspace (FUSE), overlay filesystems, unusual container mounts,
musl, other distributions or architectures, and all non-Linux platforms are
unqualified or unsupported. See
[`docs/support-matrix.md`](docs/support-matrix.md).

One motivating Codex case transiently previews a repository and observed
251,811 Node `fs.watch` calls. That number is an observed call count, not a
directory count, unique-watch count, or Watchbound measurement, and this
repository contains no artifact mapping those calls to unique paths or
directories. A cancellable, bounded, invalidation-oriented watcher could fit
such a preview if the consumer accepts root rescans and explicit partial or
uncertain coverage. The historical 1,001- and 10,001-directory tmpfs trials do
not predict that repository's startup, memory, watch count, or cancellation
latency. This feasibility note does not authorize Codex Desktop integration.

## Evidence boundaries

Read claims in this repository according to their stated evidence:

- **Public API guarantee**: behavior exposed by the current Watchbound
  JavaScript declarations and lifecycle contract, or by Parcel 2.5.6's
  published declarations and README.
- **Current implementation fact**: a property traced to the current checked-in
  Watchbound source and tests.
- **Tagged-source fact**: a property traced to the source shipped with exactly
  `@parcel/watcher` 2.5.6 or its `v2.5.6` tag; it is not a Parcel API promise.
- **Reproduced conformance result**: a result from the recorded isolated Linux
  harness with Parcel's inotify backend forced.
- **Historical benchmark measurement**: a first-milestone result tied to its
  recorded source, binaries, adapters, host, tmpfs tree, and seven-trial
  series; it does not describe current Watchbound performance.
- **Proposed work**: an item in a deliberate-gap or future-gate section. It is
  not implemented and grants no authority to publish, generate prebuilds, or
  integrate a consumer.

## Watchbound and `@parcel/watcher`

Parcel remains the default alternative when its public contract is sufficient:
it is mature, published, cross-platform, prebuilt, natively batched, and exposes
typed file events plus historical snapshot queries. This repository compares
Watchbound with exactly `@parcel/watcher` 2.5.6 and forces Parcel's Linux
inotify backend.

| Capability | Watchbound private `0.2.0` | `@parcel/watcher` 2.5.6 |
| --- | --- | --- |
| Public recursive and query API | `subscribe()` returns a subscription with joined `dispose()`; no historical query | `subscribe()` returns an `AsyncSubscription` with `unsubscribe()`; top-level `unsubscribe()`, `writeSnapshot()`, and `getEventsSince()` are public |
| Delivery and targets | Controlled source checkout or proposed one-target bundled native registry package; `0.2.0` is `target-pending-clean-ci` for the narrow Ubuntu 24.04 x64/glibc 2.39 target below | Published optional prebuild packages cover Linux glibc/musl and several architectures, macOS, Windows, FreeBSD x64, and Android arm64; local-build fallbacks are also packaged |
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
| Post-loss reconciliation | Explicit manual operation plus default-disabled bounded automatic wrapper policy | No public reconciliation operation |
| Cancel pending establishment | Establishment-only `AbortSignal`; cooperative after native work starts; joined rollback | Not exposed by the public `subscribe()` API |
| Native delivery thread scaling | At most one lazy process runtime; one dispatcher per Node environment while pending, established, or cleanup-keepalive state exists; at most one transient cleanup coordinator per affected environment | Shared backend and debounce threads; no bridge thread per subscription |
| Node callback admission | Per-subscription one-entry queue, one admission credit, and bounded engine output | One thread-safe-function per callback with an explicitly unlimited queue |
| Disposal contract | Idempotent, joined, and no callback may start after resolution | Async `unsubscribe()`; no equivalent public joined/no-later-callback guarantee |

The Watchbound semantic and lifecycle rows are current private API guarantees.
Its named threads, scheduling rounds, and queue construction are current
implementation facts also exposed where applicable through capability schema 2;
their internal shape is not a public major-version stability promise.

The Parcel API claims in the table come from its published
[`index.d.ts`](https://github.com/parcel-bundler/watcher/blob/v2.5.6/index.d.ts)
and README. Its
[shared backend](https://github.com/parcel-bundler/watcher/blob/v2.5.6/src/Backend.cc),
[shared debouncer](https://github.com/parcel-bundler/watcher/blob/v2.5.6/src/Debounce.cc),
and
[unlimited thread-safe-function queue](https://github.com/parcel-bundler/watcher/blob/v2.5.6/src/Watcher.cc)
are tagged-source facts, not documented queue or thread guarantees. Its public
surface has no abort signal or cancellation handle for a pending `subscribe()`,
no active ignore-set replacement, and no explicit coverage, overflow,
backpressure, watch-accounting, or reconciliation result.

The moved-in-tree and root-replacement rows are reproduced conformance results,
not broad claims about every Parcel backend. With exactly 2.5.6's Linux inotify
backend, moving in a populated tree installed a watch only on the incoming
directory; a later change under an existing descendant was not delivered.
Moving the watched root away produced its deletion, but a same-path replacement
and later deep change were not watched. The recorded forced-overflow trials
also observed silent path loss and later sentinel delivery, matching the
tagged source's explicit `IN_Q_OVERFLOW` skip. See
[`docs/conformance-findings.md`](docs/conformance-findings.md).

Parcel remains the better default for supported cross-platform applications,
published prebuilds, mature packaging, typed coalesced events, historical
snapshot queries, static path/glob ignores, and consumers that do not need
Watchbound's explicit resource and loss contract. Watchbound's comparison is
not a claim that every Parcel backend or workload is incorrect or slower.

The first final startup series is historical. Each cell below is median
milliseconds with `[min–max]` across seven passing trials on tmpfs:

| Tree / phase | Historical Watchbound release build | Exact Codex Linux JavaScript helper | `@parcel/watcher` 2.5.6, `backend: "inotify"` |
| --- | ---: | ---: | ---: |
| 1,001 directories, cold | 7.20 `[3.47–8.20]` | 38.44 `[28.77–47.00]` | 5.58 `[4.21–9.01]` |
| 1,001 directories, warm | 7.54 `[3.25–8.30]` | 37.25 `[31.37–42.07]` | 8.58 `[5.88–9.68]` |
| 10,001 directories, cold | 32.31 `[31.55–44.39]` | 273.05 `[249.56–319.78]` | 49.11 `[45.61–52.74]` |
| 10,001 directories, warm | 36.59 `[32.76–40.04]` | 239.37 `[184.88–380.16]` | 47.42 `[43.51–50.65]` |

The benchmark used clean commit
`74b846d0621deaf8cc63a4dda2e640565544885d`, Watchbound source digest
`4252eaa787a9575b6f2ebd7160a1c5a05fed3c6222754bba6af824881fb93044`,
loaded native SHA-256
`186d47fdb6a87c8e0af8c81016a655be11334fbd136d5d6486bf2381b209738e`,
the exact Codex helper SHA-256
`e619307502b7330421232b703757b8acbc9b7136c2b1942898eade214ade5f6e`,
and exactly `@parcel/watcher` 2.5.6 with `backend: "inotify"`.
The host's `/tmp` reported filesystem magic `0x01021994`, so the series
characterizes tmpfs rather than persistent-storage latency.

These readings show feasibility on that host and tree shape. They do not show a
universal speedup, persistent-filesystem behavior, current Watchbound
performance, production readiness, Electron responsiveness, or behavior on the
251,811-call repository preview. The adapters had different batching and
callback policies, and the first-milestone Watchbound source predates the
current shared runtime, delivery, cancellation, exclusions, and recovery work.
See
[`docs/benchmark-results.md`](docs/benchmark-results.md) for adapter and
artifact identities, incremental resident set size (RSS), raw-artifact hashes,
and the complete caveats.

## Build and test

The manifests intentionally admit only Node `>=24.18.0 <25`, Linux x64, and
glibc. The maintained target is Ubuntu 24.04 with Linux 6.8+, glibc
2.39, Rust 1.88+, pnpm 10.33.2, `build-essential`, and a working C linker; see
[`docs/support-matrix.md`](docs/support-matrix.md). Node-API 6 is the addon ABI
floor, not a broader support claim. See the
[release runbook](docs/releasing.md) for artifact validation, registry
bootstrap, OIDC, provenance, and the remaining release gates.

```sh
pnpm install
pnpm build:node
pnpm test
pnpm check
pnpm test:packages
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

The deeply frozen, JSON-serializable `capabilities` export has schema version 2
and separates versions/build facts, observed runtime facts, the support target,
features, option defaults and bounds, and observability. It reports
establishment cancellation, per-environment shared delivery, a one-entry
callback queue, and single-credit admission explicitly. Runtime facts do not
widen support: this `0.2.0` revision remains `target-pending-clean-ci` until
exact clean target evidence supports a later status declaration. See
[`docs/api-lifecycle.md`](docs/api-lifecycle.md)
and [`docs/support-matrix.md`](docs/support-matrix.md). The private API revision
and compatibility policy are recorded in
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
