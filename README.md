# Watchbound

Watchbound is an experimental, Linux-first recursive directory watcher that
treats filesystem coverage as an explicit result rather than an assumption.
It uses one inotify watch per included directory, batches invalidations, and
reports partial or uncertain coverage when it cannot safely claim completeness.

This repository is a feasibility milestone. Nothing here is published or has
a stable API. It is intentionally independent of Codex Desktop and does not
contain Git-ignore or application policy.

The workspace is divided by ownership:

- `engine/`: reusable Rust engine and Linux inotify state machine.
- `node/`: thin Node-API proof-of-concept binding.
- `js/`: JavaScript entry point and TypeScript declarations.
- `benches/`: standalone conformance and measurement harnesses.
- `docs/`: architecture, methodology, results, and decisions.

See `docs/architecture.md` and `docs/benchmark-methodology.md` for the design
and evaluation contract.

## Build and test

Requirements are Linux, Rust 1.88 or newer, Node.js 18 or newer, pnpm, and a C
linker. The native boundary targets Node-API 6; the wrapper additionally uses
`WeakRef`, and the test suite uses `node:test`. Nothing is published.

```sh
pnpm install
pnpm build:node
pnpm test
pnpm check
```

The native build produces a local platform binding under `node/`; generated
`.node` binaries are ignored by Git. The JavaScript wrapper preserves exact
Linux path bytes and conservatively collapses a non-UTF-8 string invalidation
to its root.

## Evaluate

```sh
node benches/conformance.mjs --quick --pretty
node benches/conformance.mjs --adapter watchbound --scenario reconciliation --quick --strict --pretty
node benches/conformance.mjs --adapter watchbound --scenario automatic-reconciliation --quick --strict --pretty
node benches/conformance.mjs --help
node --expose-gc benches/benchmark.mjs --help
```

The two targeted reconciliation commands are ordinary-development conformance
checks. The first calls the explicit `subscription.reconcile()` primitive; the
second enables the JavaScript wrapper's bounded automatic policy. Both use
deterministic native-to-JavaScript consumer backpressure and do not induce a
real inotify queue overflow. The I/O-heavy forced-overflow
scenarios are removed by `--quick` and require both explicit quiet-host
confirmation and the `--allow-forced-overflow` acknowledgement. The flag is a
safety interlock, not evidence that the host is ready.

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
also contains a separately gated `overflow-reconciliation` scenario that can
apply those checks after supervised genuine `event-overflow`. A confirmed
targeted follow-up passed this public recovery contract; it is correctness
evidence, not a new performance reading.

The JavaScript wrapper also offers opt-in `automaticReconciliation`. It is
disabled by default, coalesces the three recoverable uncertainty reasons, uses
finite capped exponential backoff, and exposes only its current bounded status.
It calls the same primitive on the original subscription and never reconstructs
lost detail. `root-replaced` is explicitly blocked and the engine does not
reattach to the replacement. Root-replacement recovery, non-Linux backends, and
published prebuilds remain for later milestones.
