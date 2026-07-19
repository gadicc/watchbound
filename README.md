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
node benches/conformance.mjs --help
node --expose-gc benches/benchmark.mjs --help
```

The final performance run is intentionally pending a quiet host. See
`docs/conformance-findings.md` for correctness evidence and
`docs/benchmark-results.md` for the measurement stop point.

## Prototype gaps

The current engine is deliberately one subscription/worker/inotify instance at
a time. It reports root replacement as uncertain but does not reattach to the
replacement. Atomic dynamic exclusions, process-wide fair multi-root
allocation, post-overflow topology rebuild, and published prebuilds remain for
later milestones.
