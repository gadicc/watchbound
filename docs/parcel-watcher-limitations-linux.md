# `@parcel/watcher` limitations on Linux and when Watchbound fits

Parcel remains the better default when its public contract is sufficient. It
is mature, cross-platform, prebuilt, and reports convenient coalesced
`create`, `update`, and `delete` events. Watchbound is a narrower Node.js
recursive file watcher for Linux consumers that can rescan after an
invalidation and need explicit coverage, bounded inotify resources and
delivery, deliberate recovery, and joined disposal.

This page is a decision guide, not a claim that Watchbound is a drop-in Parcel
replacement.

## Current upstream release and tested evidence

As checked on 2026-09-06, the current npm release of `@parcel/watcher` is
2.6.0. Its [upstream release note](https://github.com/parcel-bundler/watcher/releases/tag/v2.6.0)
describes added RegExp ignore support.

Watchbound's retained source review, conformance runs, and benchmarks use
exactly `@parcel/watcher` 2.5.6 with the Linux inotify backend forced. This
repository has not rerun that retained evidence against 2.6.0. Public API
differences can be checked against the current upstream package, but reproduced
2.5.6 behavior must not be projected onto a later Parcel version without a new
qualified run.

## Choose by the contract you need

| Requirement | Better fit | Reason |
| --- | --- | --- |
| Cross-platform support and broad prebuild coverage | Parcel | Parcel supports multiple operating systems, architectures, and backends |
| Coalesced `create`, `update`, and `delete` events | Parcel | Watchbound deliberately reports conservative invalidated paths instead |
| Historical snapshot queries | Parcel | Parcel exposes `writeSnapshot()` and `getEventsSince()` |
| Explicit complete, partial, or uncertain coverage | Watchbound | Coverage and the reason for degradation are part of establishment, delivery, and recovery results |
| Public watch limits and process-wide native-watch accounting | Watchbound | Logical and native watch resources can be bounded and inspected |
| Bounded native-to-JavaScript delivery and explicit consumer backpressure | Watchbound | Queues and callback admission are finite; pressure collapses detail to a conservative root invalidation |
| Atomic exclusion replacement on an active subscription | Watchbound | Exact-byte prefix and directory-name policy can be replaced by generation |
| Explicit recovery after overflow, topology races, or root replacement | Watchbound | Reconciliation and identity-policy-gated root recovery are public operations |
| Disposal that joins an admitted async callback and prevents a later callback start | Watchbound | `dispose()` makes that lifecycle guarantee explicitly |

Watchbound is not a fit for exact filesystem journals, consumers that cannot
rescan, or unsupported hosts and roots. Detected WSL and environments with
recognized container evidence cannot qualify. Network, FUSE, and overlay roots
are unqualified, and non-Linux platforms are unsupported. Use
[`qualifyRoot()`](runtime-qualification.md) rather than inferring support from
successful native-module loading.

## Parcel 2.5.6 public API gaps relevant to this choice

Parcel 2.5.6's public API has no explicit coverage state, queue-overflow result,
consumer-backpressure state, public watch limit or accounting, active ignore
replacement, subscription-establishment cancellation, or reconciliation
operation. Those are statements about the public surface, not claims that
Parcel has no private implementation state.

These gaps matter when the consumer must know whether its view may be
incomplete. A wrapper can add a fallback policy around a reported failure, but
it cannot reconstruct lost detail or expose a loss condition that the backend
does not report.

## Reproduced Parcel 2.5.6 Linux behavior

Watchbound's isolated conformance harness forced Parcel's inotify backend and
recorded these scenario results:

- Moving a populated nested tree into the watched root emitted the incoming
  directory, but a later modification of an existing deep file emitted
  nothing.
- Moving the watched root away emitted its deletion, but a replacement at the
  same pathname was not watched and a later deep change emitted nothing.
- Each of three final forced-overflow trials created 20,480 distinct files.
  Exactly 8,192 paths were delivered and 12,288 were missing in every trial;
  no error or root invalidation was reported, while a later sentinel still
  arrived.
- Overlapping subscriptions did not safely emulate active ignore replacement
  in the reproduced cases.
- Calling one subscription handle's `unsubscribe()` twice reopened and
  retained an empty shared inotify backend in the reproduced case. The test
  adapter therefore caches an idempotent disposal promise.

These are results for exactly 2.5.6, the forced Linux inotify backend, and the
recorded scenarios. They are not claims about every Parcel backend, version,
or workload. The [full correctness and capability findings](conformance-findings.md#parcelwatcher-256)
separate public API facts, tagged-source facts, and reproduced observations.

## What adopting Watchbound changes

Watchbound reports invalidated paths, not an exact event journal. An
integration should therefore:

1. Confirm that it can recompute derived state from a path or root boundary.
2. Call `qualifyRoot(root)` and require `state === "qualified"` before using
   Watchbound for that root.
3. Handle `complete`, `partial`, and `uncertain` coverage separately.
4. Keep Git-ignore, glob, user-interface, and logical-workspace policy in the
   consumer and translate it into Watchbound's exact exclusion policy.
5. Reconcile only recoverable uncertainty and make root-replacement identity
   policy an explicit application decision.
6. Retain the subscription and await its joined `dispose()` during shutdown.

Start with the [installation example](../README.md#install-and-start), then use
the [API and lifecycle contract](api-lifecycle.md) for integration details and
the [benchmark results](benchmark-results.md) for carefully scoped historical
performance evidence.
