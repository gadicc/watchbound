# Watchbound

_A conservative Linux recursive directory watcher with explicit coverage, bounded resources, and joined lifecycle guarantees._

[![npm](https://img.shields.io/npm/v/watchbound)](https://www.npmjs.com/package/watchbound)
[![JSR](https://jsr.io/badges/@gadicc/watchbound)](https://jsr.io/@gadicc/watchbound)
[![JSR score](https://jsr.io/badges/@gadicc/watchbound/score)](https://jsr.io/@gadicc/watchbound)
[![CI](https://github.com/gadicc/watchbound/actions/workflows/ci.yml/badge.svg)](https://github.com/gadicc/watchbound/actions/workflows/ci.yml)
[![Release qualification](https://github.com/gadicc/watchbound/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/gadicc/watchbound/actions/workflows/release.yml?query=branch%3Amain)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.txt)

Copyright (c) 2026 by Gadi Cohen. [MIT Licensed](LICENSE.txt).

## Intro

Watchbound is an experimental Linux-first watcher built directly on inotify. It reports conservative path invalidations and makes complete, partial, or uncertain filesystem coverage part of every result. It never silently turns resource pressure or event loss into a claim of complete coverage.

Packages are available from [npm](https://www.npmjs.com/package/watchbound) and [JSR](https://jsr.io/@gadicc/watchbound). Version history and availability come from registry metadata, [Git tags](https://github.com/gadicc/watchbound/tags), and [GitHub Releases](https://github.com/gadicc/watchbound/releases).

The checked-in source can be ahead of those immutable releases. Before using an API described on this branch, verify that the installed package's declarations and exports include it.

## Contents

- [Why Watchbound](#why-watchbound)
- [Install and start](#install-and-start)
- [Support matrix](#support-matrix)
- [Benchmarks](#benchmarks)
- [Compare with Parcel](#compare-with-parcel)
- [Understand the contract](#understand-the-contract)
- [Project status and documentation](#project-status-and-documentation)
- [Contributing](#contributing)
- [AI agent skill](#ai-agent-skill)

## Why Watchbound

Watchbound is for consumers that can rescan after a conservative invalidation and need explicit limits, loss reporting, and cleanup guarantees:

- **Truthful coverage**: every establishment, batch, and recovery result reports `complete`, reasoned `partial`, or reasoned `uncertain` coverage
- **Bounded pressure**: watch budgets, batch sizes, native output queues, and JavaScript callback admission are bounded and observable
- **Recursive correctness**: populated moved-in directories are scanned before their transition becomes observable
- **Explicit recovery**: overflow, topology races, backpressure, and root replacement have typed states and policy-gated recovery paths
- **Joined lifecycle**: establishment cancellation rolls back owned resources, and `dispose()` prevents a callback from starting after its promise resolves

The API reports invalidated paths, not an exact filesystem journal. When coverage is uncertain, rescan the reported boundary instead of inferring missing `create`, `update`, `delete`, or rename events.

## Install and start

Install the Node package with your package manager:

```sh
pnpm add watchbound
```

Qualify the host and root before enabling the watcher. Keep the subscription alive for the required lifetime, then join disposal during shutdown:

```ts
import { qualifyRoot, subscribe } from "watchbound";

const root = process.cwd();
const qualification = qualifyRoot(root);

if (qualification.state !== "qualified") {
  throw new Error(
    `Watchbound root is ${qualification.state}: ${qualification.reasons.join(", ")}`,
  );
}

const subscription = await subscribe(root, (batch) => {
  console.log(batch.coverage.state, batch.invalidatedPaths);
}, {
  excludedDirectoryNames: [".git", "node_modules"],
  observedExcludedPaths: [".git"],
});

await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
await subscription.dispose();
```

Callbacks are ordered and serialized per subscription. On `uncertain` coverage, rescan the safe reported boundary or use the applicable recovery operation. On `partial` coverage, surface the ongoing blind spot or maintain a fallback; a one-time rescan does not make future coverage complete. See the [API and lifecycle contract](docs/api-lifecycle.md) for exclusion replacement, cancellation, reconciliation, root recovery, and callback shutdown.

## Support matrix

The release-qualification badge at the top reports the live `main` workflow. For release candidates, that workflow calls the full continuous integration (CI) matrix across both native targets. GitHub exposes a workflow badge rather than one badge per matrix cell, so each check below links to the retained exact-commit qualification record.

| Target | Native package | Runtime baseline | Status |
| --- | --- | --- | --- |
| GNU/Linux x64 | `@gadicc/watchbound-node-linux-x64-gnu` | Node `>=24.15.0 <25`, kernel 5.15+, glibc 2.35+ | [✅ Supported](docs/support-matrix.md#published-target-contract) |
| GNU/Linux ARM64 | `@gadicc/watchbound-node-linux-arm64-gnu` | Node `>=24.15.0 <25`, kernel 5.15+, glibc 2.35+ | [✅ Supported](docs/support-matrix.md#published-target-contract) |

CI also exercises pinned Ubuntu, Debian, Fedora, Arch x64, openSUSE, Nix, kernel 5.15, and Electron lanes. The [full support and qualification matrix](docs/support-matrix.md) records the exact lane, architecture, artifact, and promotion evidence.

The supported native targets are GNU/Linux x64 and ARM64. They require Node `>=24.15.0 <25`, kernel 5.15 or newer, and glibc 2.35 or newer. WSL and environments with recognized container evidence cannot qualify. Network, Filesystem in Userspace (FUSE), and overlay filesystems are unqualified; musl, ARMv7, and non-Linux platforms are unsupported.

Loading a compatible native package does not qualify the host or root. Call `qualifyRoot(root)` and require `state === "qualified"`; the [runtime qualification contract](docs/runtime-qualification.md) explains every accepted and rejected state.

## Benchmarks

The retained performance series is historical feasibility evidence, not a claim about current source performance. It compared a recorded Watchbound build, the exact configured Codex Linux JavaScript helper, and exactly `@parcel/watcher` 2.5.6 with its inotify backend forced.

Each cell is median subscription time in milliseconds with `[min–max]` across seven passing trials on tmpfs:

| Tree and phase | Watchbound | Codex JavaScript | Parcel 2.5.6 |
| --- | ---: | ---: | ---: |
| 1,001 directories, cold | 7.20 `[3.47–8.20]` | 38.44 `[28.77–47.00]` | 5.58 `[4.21–9.01]` |
| 1,001 directories, warm | 7.54 `[3.25–8.30]` | 37.25 `[31.37–42.07]` | 8.58 `[5.88–9.68]` |
| 10,001 directories, cold | 32.31 `[31.55–44.39]` | 273.05 `[249.56–319.78]` | 49.11 `[45.61–52.74]` |
| 10,001 directories, warm | 36.59 `[32.76–40.04]` | 239.37 `[184.88–380.16]` | 47.42 `[43.51–50.65]` |

On that host and tree shape, Watchbound's 10,001-directory startup medians were 23% to 34% below Parcel's and used less incremental resident set size (RSS). The 1,001-directory cold ranges overlap, so the series does not establish a small-tree win. The source predates later runtime, delivery, exclusions, and recovery work, and tmpfs does not predict persistent-filesystem or application performance.

The separate final conformance report recorded 30 applicable Watchbound trials, all passing. CI runs a bounded benchmark smoke to catch functional regressions, but its timings are not promoted as performance evidence.

Read the [complete benchmark results](docs/benchmark-results.md) for memory, bursts, disposal, artifact hashes, host state, and caveats. The [methodology](docs/benchmark-methodology.md) defines pass-only aggregation, rotating adapter order, quiet-host preparation, and the safety boundary for forced overflow.

## Compare with Parcel

Parcel remains the better default when its public contract is sufficient. It is mature, cross-platform, prebuilt, and exposes typed events and historical snapshot queries. Watchbound targets a narrower Linux use case with stronger resource, loss, and lifecycle semantics.

| Need | Watchbound | `@parcel/watcher` 2.5.6 |
| --- | --- | --- |
| Platforms | Qualified GNU/Linux x64 and ARM64 | Broad cross-platform prebuild coverage |
| Event model | Conservative invalidated paths | Coalesced `create`, `update`, and `delete` events |
| Coverage and loss | Explicit complete, partial, and uncertain states | No public coverage state |
| Limits and pressure | Public watch limits, bounded queues, and accounting | No public active-watch or backpressure state |
| Exclusions | Exact-byte initial policy and atomic active replacement | Subscribe-time path and glob ignores |
| Recovery | Manual and bounded opt-in automatic reconciliation | No public reconciliation operation |
| Disposal | Idempotent join with no later callback start | Async `unsubscribe()` without the same public guarantee |

The comparison is scoped to Parcel's public API and reproduced Linux inotify behavior at exactly 2.5.6. It is not a claim about every Parcel backend, version, or workload. See the [correctness and capability findings](docs/conformance-findings.md) for source attribution and reproduced scenarios.

## Understand the contract

Watchbound's central invariant is conservative coverage: detailed paths may be collapsed to a root invalidation, but lost detail is never reported as complete.

| Coverage | Meaning | Consumer action |
| --- | --- | --- |
| `complete` | The watcher can account for the covered topology and delivered invalidations | Process the invalidations normally |
| `partial` | A known resource or permission limit left directories unwatched | Treat uncovered state as unavailable or change the limit |
| `uncertain` | Overflow, topology change, root replacement, or consumer pressure may have lost detail | Rescan or invoke the applicable recovery operation |

The native addon runs inside the Node or Electron process. Filesystem traversal and engine transactions run off the JavaScript thread, but module loading, option validation, state access, and callbacks do not. Slow callbacks create bounded, subscription-local backpressure; separate Worker environments are required for independent JavaScript progress.

Subscription options support logical watch limits, a process-wide native watch budget, exact exclusions, establishment-only cancellation, bounded batches, and opt-in automatic reconciliation. Batch callbacks receive an `AbortSignal` and `stop()` request, while `dispose()` joins native cleanup and any callback already admitted.

Read the [architecture decision record](docs/architecture.md), [Node binding design](docs/node-binding.md), [structured error contract](docs/error-contract.md), and [security and path threat model](docs/security-threat-model.md) for the complete semantics.

## Project status and documentation

Watchbound remains an experimental Linux-first project. The Rust engine owns filesystem semantics; the Node-API binding translates representations and lifecycle; the JavaScript package supplies the public wrapper. Consumer policy such as Git ignore rules, UI behavior, and logical workspace mapping stays outside the engine.

The source manifests use a development placeholder and remain private to prevent accidental publication. Controlled release trees materialize registry packages and versions. The [maintenance policy](docs/maintenance-policy.md), [native delivery contract](docs/native-delivery.md), and [release runbook](docs/releasing.md) define those boundaries.

Use the [documentation index](docs/README.md) to navigate architecture, API, qualification, benchmarks, packaging, evidence, and decision records.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites, repository layout, the test-driven workflow, required checks, benchmark safety, package documentation invariants, and commit conventions.

## AI agent skill

This repository includes an [Agent Skills-compatible Watchbound skill](skills/watchbound/SKILL.md) with package integration, coverage, lifecycle, recovery, and contributor guidance. Install it for a compatible coding agent with:

```sh
npx skills add gadicc/watchbound
```
