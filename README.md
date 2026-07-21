# Watchbound

Watchbound is an experimental Linux recursive directory watcher and
maintained-unpublished stabilization candidate. It treats filesystem coverage
as an explicit result rather than an assumption, uses one inotify watch per
included directory, batches invalidations, and reports partial or uncertain
coverage when it cannot safely claim completeness.

This repository remains private at `0.0.0`. Nothing here is published or has a
stable public API, and the maintained target remains pending clean CI evidence.
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

## Build and test

The manifests intentionally admit only Node `>=24.18.0 <25`, Linux x64, and
glibc. The pending maintained target is Ubuntu 24.04 with Linux 6.8+, glibc
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
features, option defaults and bounds, and observability. Runtime facts are not a
support claim: the approved narrow source-build target remains
`target-pending-clean-ci`. See [`docs/api-lifecycle.md`](docs/api-lifecycle.md)
and [`docs/support-matrix.md`](docs/support-matrix.md).

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
