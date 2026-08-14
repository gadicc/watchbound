# Contributing to Watchbound

Watchbound is a Linux-first recursive watcher with a conservative coverage contract. Contributions must preserve explicit complete, partial, and uncertain states; bounded batches and queues; exact Linux path bytes; and joined disposal.

## Prerequisites

Development requires:

- Linux
- Node.js `>=18.15.0`
- Rust 1.88 or newer
- pnpm 10.33.2
- A C compiler and linker

The reproducible CI build toolchain pins a separate Node version; that pin is not the package runtime floor. Read the [Node and Electron compatibility policy](docs/runtime-compatibility.md) and [support and qualification matrix](docs/support-matrix.md) before changing compatibility claims.

## Repository layout

Each layer has a narrow responsibility:

- `engine/`: reusable Rust engine, recursive topology, and Linux inotify state machine
- `node/`: thin napi-rs representation and lifecycle bridge
- `js/`: ECMAScript module wrapper and TypeScript declarations
- `benches/`: isolated conformance and benchmark adapters and harnesses
- `docs/`: architecture, lifecycle, methodology, evidence, and decisions
- `scripts/`: repository, package, qualification, and release checks

Keep filesystem semantics in `engine/`. The Node binding should translate representations and lifecycle only. Git ignore rules, Codex policy, UI behavior, and logical workspace mapping belong to consumers.

## Build and test

Install dependencies, build the native addon, and run the main checks:

```sh
pnpm install
pnpm build:node
pnpm test
pnpm check
```

Use focused tests while iterating. Before handing off a code change, run `pnpm test` and `pnpm check`. Run `pnpm test:packages` after changing the package surface, entrypoints, declarations, or package documentation.

Additional bounded checks include:

```sh
pnpm test:baseline
pnpm test:soak
pnpm test:root-recovery-stress
```

`pnpm test:baseline` runs Watchbound-only ordinary conformance and benchmark-path smoke checks. It does not record performance evidence or enable forced overflow. See the [benchmark harness guide](benches/README.md) for targeted scenarios.

## Change watcher semantics with tests

Use test-driven changes for filesystem semantics and lifecycle behavior. Preserve these rules:

- Keep exact Linux path bytes at the native boundary
- Do not normalize away path components before native symlink validation
- Do not follow directory symlinks
- Keep subscription and process watch limits explicit
- Keep engine batches, native output, and JavaScript callback admission bounded
- Prefer a conservative root invalidation and explicit uncertainty when detail is lost
- Keep disposal idempotent and prevent callbacks from starting after disposal resolves

Read the [architecture](docs/architecture.md), [API lifecycle](docs/api-lifecycle.md), and [security threat model](docs/security-threat-model.md) before changing these contracts.

## Preserve the public package surface

The JavaScript runtime and `js/index.d.ts` must remain synchronized. Preserve `/* @ts-self-types="./index.d.ts" */` on the JavaScript entrypoint.

Every JavaScript Registry (JSR) entrypoint needs a substantive module doc with `@module`. Document every exported symbol and every public member of exported interfaces and classes. Keep public types explicit or directly inferable.

After a public declaration or documentation change, run:

```sh
deno doc --lint js/index.d.ts
pnpm test:packages
```

The root README must retain a working package-usage example. Update `jsr.json` exports and module documentation together when an entrypoint changes.

## Run benchmarks responsibly

Ordinary functionality and conformance checks are safe during development. Do not record or replace final benchmark readings until the host is quiet and prepared.

Final trials must run serially with rotating adapter order. Compare the configured exact Codex helper and exactly `@parcel/watcher` 2.5.6 with its inotify backend forced. Exclude failed semantic trials from performance aggregates while retaining their raw correctness results.

Forced overflow is input/output intensive correctness evidence. Run it only through the supervised helper after explicit host preparation. The [benchmark methodology](docs/benchmark-methodology.md) defines the measurement and safety contract.

## Keep release boundaries closed

All checked-in npm, Cargo, and lockfile versions stay at `0.0.0-development`. Semantic release is the only published-version authority; release jobs apply a planned version as an uncommitted transform of the exact source commit.

Do not publish packages or integrate Watchbound into Codex Desktop without explicit maintainer authorization. Follow the [maintenance policy](docs/maintenance-policy.md), [release runbook](docs/releasing.md), and [incident response guide](docs/release-incident-response.md) for authorized release work.

## Write commits

Use Conventional Commits with a scope, for example `fix(engine): preserve coverage after overflow`. Explain the motivation, changes, and relevant verification in the commit body.
