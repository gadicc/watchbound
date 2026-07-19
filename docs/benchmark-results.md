# Final benchmark results

Status: first Linux feasibility measurement complete on 2026-07-19.

## Second-milestone follow-up (not a benchmark replacement)

The intermittent directory-burst failure was traced to an engine-side false
positive rather than an inotify loss signal. Runtime subtree discovery used the
batch deadline as a checkpoint; if the deadline expired while installing a
directory watch, the worker labelled that scheduling delay `topology-race`,
collapsed accumulated detail to the root, and continued. That exactly explains
the measured sample's small detailed prefix followed by two root invalidations.

The second-milestone change keeps discovery serialized with its triggering
event and flushes immediately after the scan. Disposal can still interrupt the
scan, and native overflow, unexpected watch loss, unmount, descriptor aliasing,
and real topology failures still report uncertainty. A deterministic deadline
regression and an eight-round, 1,000-directory live stress test with a 1 ms
batch window and 64-path batches now pass with complete detailed coverage.

These are targeted correctness checks. The final JSON, hashes, ranges, and
decision below remain the first-milestone evidence and have not been replaced.

## Decision

Proceed to a second Linux engineering milestone for Watchbound. Do not switch
this contract to a thin Parcel wrapper, and do not integrate or publish the
prototype yet.

Watchbound was close to or faster than Parcel for recursive startup, used a
similar amount of incremental RSS, and delivered batched bursts without the
multi-fold regression that would stop the project. More importantly, it passed
the explicit watch-limit, root-loss, bridge-backpressure, and forced-overflow
contracts that Parcel cannot provide through its public API.

The next milestone is still gated on fixing intermittent directory-topology
races, designing shared process-wide multi-root scheduling, and adding consumer
exclusions. One of seven measured Watchbound directory bursts reported an
explicit `topology-race` and missed 864 detailed paths. This is conservative,
not silent corruption, but it is not production-ready behavior.

## Artifacts and host

- Raw benchmark: `benches/results/benchmark-final.json` (schema 2, 849,465
  bytes, SHA-256 `7fbfd36652c59a53aea64547017f1ecf284c34e9ca1c6a4f4935084a94ddd64f`).
- Raw conformance: `benches/results/conformance-final.json` (schema 2,
  7,223,645 bytes, SHA-256
  `f991b1a8ef2cda7e069ca3816863d3c60c9350b72d3deaa5ca49c2efe4ef7942`).
- Benchmark commit: `74b846d0621deaf8cc63a4dda2e640565544885d`, clean.
- Conformance commit: `8111364773a303bb84392e06ec84f9b4100c48d8`, clean. The
  second commit changes only forced-overflow harness IPC and its methodology.
- Watchbound source digest in both reports:
  `4252eaa787a9575b6f2ebd7160a1c5a05fed3c6222754bba6af824881fb93044`.
- Loaded native artifact SHA-256:
  `186d47fdb6a87c8e0af8c81016a655be11334fbd136d5d6486bf2381b209738e`.
- Exact Codex helper SHA-256:
  `e619307502b7330421232b703757b8acbc9b7136c2b1942898eade214ade5f6e`.
- Parcel was exactly `@parcel/watcher` 2.5.6 with `backend: "inotify"`.
- Node 25.2.1, Linux 7.1.3-2-cachyos, 24 logical CPUs, Intel Core Ultra 9
  285HX, `powersave` governor, 128 GiB RAM.
- `/tmp` reported filesystem magic `0x01021994`, so these results characterize
  tmpfs rather than persistent-storage latency.
- Inotify limits were 524,288 watches, 1,024 instances, and 16,384 queued
  events.

Before measurement, six ten-second host samples showed 90–94% CPU idle, 0% I/O
wait, no blocked tasks, and zero 10/60-second CPU, I/O, and memory pressure-stall
averages. Benchmark load average moved from 2.12 to 2.66 on 24 logical CPUs.
The host was suitable for this “good enough” series, but this is not a
laboratory-controlled result.

## Recursive startup

All entries are median milliseconds with `[min–max]` over seven passing trials.
Incremental RSS is median MiB. Every adapter used exactly one inotify watch per
directory: 1,001 and 10,001 watches respectively.

| Tree / phase | Watchbound | Codex JS | Parcel 2.5.6 |
| --- | ---: | ---: | ---: |
| 1k cold | 7.20 `[3.47–8.20]`, 0.38 MiB | 38.44 `[28.77–47.00]`, 5.81 MiB | 5.58 `[4.21–9.01]`, 0.58 MiB |
| 1k warm | 7.54 `[3.25–8.30]`, 0.19 MiB | 37.25 `[31.37–42.07]`, 3.03 MiB | 8.58 `[5.88–9.68]`, 0.38 MiB |
| 10k cold | 32.31 `[31.55–44.39]`, 3.19 MiB | 273.05 `[249.56–319.78]`, 30.26 MiB | 49.11 `[45.61–52.74]`, 4.45 MiB |
| 10k warm | 36.59 `[32.76–40.04]`, 3.00 MiB | 239.37 `[184.88–380.16]`, 9.38 MiB | 47.42 `[43.51–50.65]`, 4.50 MiB |

At 10,000 directories Watchbound's median startup was 23–34% below Parcel's
and its incremental RSS was lower. The 1,000-directory cold ranges overlap;
there is no credible small-tree win to claim from this series. Codex's
JavaScript traversal was materially slower and allocated materially more RSS.

## Bursts

Each burst contains 1,000 operations. Delivery is median time-to-all-expected
paths with `[min–max]`, measured after synchronous mutation ends. CPU and RSS
are median operation CPU milliseconds and steady-state RSS MiB. `n` is the
pass-only performance sample count.

| Burst / adapter | n | All paths ms | CPU ms | RSS MiB | Callbacks |
| --- | ---: | ---: | ---: | ---: | ---: |
| files / Watchbound | 7 | 6.75 `[4.81–8.50]` | 39.13 | 3.00 | 1 |
| files / Codex JS | 7 | 10.72 `[9.21–13.47]` | 54.93 | 7.69 | 1,000 |
| files / Parcel | 7 | 52.03 `[51.85–52.24]` | 42.24 | 2.63 | 2 |
| directories / Watchbound | 6 | 8.18 `[6.90–17.36]` | 38.69 | 4.41 | 1 |
| directories / Codex JS | 7 | 13.47 `[11.97–19.12]` | 126.93 | 13.22 | 1,001 |
| directories / Parcel | 7 | 3.72 `[2.81–51.97]` | 33.90 | 3.75 | 1 |
| renames / Watchbound | 7 | 9.43 `[8.91–14.05]` | 40.50 | 5.44 | 2 |
| renames / Codex JS | 7 | 21.92 `[17.50–29.34]` | 117.08 | 19.58 | 2,001 |
| renames / Parcel | 7 | 52.36 `[3.03–54.51]` | 45.45 | 5.25 | 2 |

All passing samples had zero missed and duplicate expected paths. Watchbound's
native batching substantially reduced JavaScript callback count versus Codex.
Parcel's roughly 52 ms file/rename medians reflect its debouncer, while its
directory result was bimodal. These policies make callback latency alone an
unfair comparison; time-to-all-expected is the decision metric.

The omitted seventh Watchbound directory sample detected 136 of 1,000 detailed
paths, invalidated the root twice, and explicitly reported `topology-race`.
The final conformance rerun subsequently passed all three directory-burst
trials, so this is intermittent rather than a deterministic capacity limit.

## Disposal and conformance

Watchbound disposal joined and released its instance and watches in all seven
benchmark trials: median 8.70 ms `[7.76–13.13]`. Parcel did so in 1.03 ms
`[0.33–5.12]`. The Codex helper suppressed callbacks after disposal but retained
one inotify instance beyond the observation window in all seven benchmark and
all three conformance trials, so it has no pass-only disposal timing aggregate.

The unrestricted final conformance report executed all 87 applicable trials:
69 passed, 12 were expected nonconformances, six unsupported watch-limit cases
were observational, and there were zero errors, runtime skips, or cleanup
errors. Twelve trials were capability-excluded: bridge backpressure for Codex
and Parcel, and dynamic exclusions for Watchbound and Parcel.

Watchbound passed all 30 applicable trials. In each forced overflow it confirmed
the watcher stopped, created 20,480 distinct files against a 16,384-event queue,
reported `event-overflow`, invalidated the root, drained, and delivered the
sentinel. Parcel missed 12,288 paths in each run, reported no loss or
invalidation, and then delivered the sentinel. Codex also missed 12,288 paths,
emitted a conservative root invalidation without a typed reason, and delivered
the sentinel. Parcel additionally failed all moved-in populated-tree and root
replacement trials. Codex passed all three active Git-derived exclusion trials.

## Interpretation

The performance stop criterion is satisfied: Watchbound is within Parcel's
native resource/startup profile and often ahead at the larger tree, while its
stronger failure contract is independently exercised. The result argues
against a thin Parcel wrapper because the reproduced silent overflow,
moved-in-subtree, and root-lifecycle gaps occur below the public API.

This is a go for continued Linux engine work, not for product integration.
Before that decision changes, require:

1. no intermittent directory-burst topology race under repeated stress;
2. a shared, fair multi-root instance/thread and watch allocator;
3. generation-based atomic exclusions;
4. overflow reconciliation or an explicit consumer recovery protocol;
5. another labelled series on the consumer's intended persistent filesystem;
6. packaging/prebuild and teardown work described in the prototype gaps.
