---
name: watchbound
description: Use Watchbound to design, integrate, test, or maintain conservative recursive directory watching on supported Linux hosts. Use when tasks involve the `watchbound` JavaScript package, explicit complete/partial/uncertain coverage, bounded inotify resources and delivery, reconciliation or root replacement, joined callback disposal, or contribution work in the Watchbound repository.
---

# Watchbound

Build filesystem consumers around conservative invalidations and explicit
coverage. Preserve the distinction between what Watchbound observed and what it
can safely claim.

## Establish the applicable contract

Before changing an integration:

1. Inspect the installed `watchbound` version, its declarations, and its
   exported `capabilities`.
2. Check `capabilities.support.currentRuntime.targetCompatible`, the matching
   entry in `capabilities.support.targets`, and `qualifyRoot(root).state`.
   Matching diagnostic runtime facts alone do not widen the declared support
   target. In the current API, the older
   `capabilities.support.currentRuntime.supported` field is removed:
   `targetCompatible` covers only the selected packaged target, while
   `qualifyRoot(root)` supplies the required host and root decision. Older
   packages may still expose the removed field or only the legacy single-target
   fields.
3. Confirm that the consumer can rescan after a conservative root invalidation
   and can operate honestly with partial or uncertain coverage.
4. Prefer another watcher when the consumer needs a cross-platform package,
   exact event history, typed create/update/delete events, or cannot own joined
   native disposal.

The source repository can be ahead of immutable registry releases. Do not use a
source-candidate API merely because this skill describes it; verify that the
selected package version exports the capability.

Treat support as deliberately evidence-bound. Use the installed package's
capabilities and immutable registry, tag, and release records instead of a
hard-coded release number. The checked-in source matrix declares
supported x64 and ARM64 GNU/Linux targets with a kernel 5.15/glibc 2.35
baseline and Node `>=24.15.0 <25`; exact native, distro, Electron, Nix,
reproducibility, kernel-floor, separately supervised overflow, and registry
smoke evidence backs those declarations. The exact ARMv7 hard-float source
target is also supported after deterministic cross-build/package, QEMU-user
Electron, and system-QEMU kernel-floor lifecycles passed; it has no published
usable binding and no native-hardware or performance evidence.

An environment with recognized container evidence cannot qualify. Treat
`container-unknown` as unknown evidence, never as a negative container result;
`not-detected` covers only the designated probes and is not exhaustive.
Detected WSL and network, FUSE, or overlay roots cannot qualify. Musl,
soft-float/unknown/non-v7 ARM, big-endian ARM, and non-Linux hosts are
unsupported. Exact GNU/Linux ARMv7 hard-float retains both declared emulated
execution lanes as continuing support gates. Distro recognition, successful
loading, and runtime facts never widen the selected package's exact target
status.

## Preserve the semantic model

Interpret invalidated paths as places whose derived state may need recomputing,
not as an exact filesystem journal. Never infer create, update, delete, or
rename history from a batch.

Handle every coverage variant:

- `complete`: Watchbound claims coverage of the included tree. Paths remain
  conservative invalidations.
- `partial`: Some logical directories are not watched. Surface degraded
  coverage or provide an ongoing fallback; a one-time rescan does not remove
  the future blind spot.
- `uncertain`: Delivered detail may be incomplete. Rebuild from a safe boundary,
  normally the root, and use reconciliation or explicit root recovery where
  applicable.

Use `invalidatedPathBytes` when exact Linux path bytes matter. If
`pathEncoding` is `root-collapsed`, treat the physical string root invalidation
as the safe boundary rather than reconstructing an unrepresentable child. If it
is `bytes-only`, `invalidatedPaths` is intentionally empty and the exact byte
paths are the only authoritative invalidations; never substitute a lexical
alias.

Keep cardinality bounded throughout the consumer. Bound pending work, coalesce
duplicate invalidations, and prefer one root rebuild over an unbounded queue of
possibly incomplete detail.

## Integrate the JavaScript API

Use the lazy top-level `subscribe()` for a single default configuration. Use
`createEngine({ nativeWatchBudget })` when the process must explicitly bound
unique native watches or inspect process-global runtime statistics.
`watchLimit` counts subscription-local logical directories; the native watch
budget counts process-wide unique native watches. A `null` limit means no
Watchbound-imposed limit, not unlimited kernel resources.

Start from this lifecycle shape, adapting the recovery policy to the consumer:

```ts
import { subscribe } from "watchbound";

const subscription = await subscribe(
  workspaceRoot,
  async (batch, { signal }) => {
    if (batch.coverage.state === "uncertain") {
      await rebuildWorkspace(workspaceRoot, { signal });
      return;
    }

    if (batch.coverage.state === "partial") {
      reportDegradedCoverage(batch.coverage);
    }

    await invalidateDerivedState(batch.invalidatedPaths, { signal });
  },
  {
    signal: establishmentAbortController.signal,
    initialExclusions: ["generated"],
    excludedDirectoryNames: [".git", "node_modules"],
    observedExcludedPaths: [".git"],
    watchLimit: 50_000,
    maxBatchPaths: 2_048,
    outputQueueCapacity: 8,
  },
);

try {
  await runConsumer(subscription);
} finally {
  await subscription.dispose();
}
```

Treat those option values as examples. Read accepted bounds and defaults from
`capabilities.options` for the selected build.

Use `initialExclusions` when excluded directories are already known before
subscription. Prefixes are exact normalized root-relative directory paths, not
globs or basenames, and are applied before the generation-zero topology scan.
An empty prefix excludes the root. Watchbound does not discover Git ignores or
application policy; consumers must compute and update that complete prefix set.

When `capabilities.features.directoryNameExclusions` and
`capabilities.features.observedExcludedPaths` are true, use
`excludedDirectoryNames` for exact directory components that must be pruned at
every depth, including future and renamed-in directories. Use
`observedExcludedPaths` for nonempty exact root-relative excluded boundaries
whose creation, deletion, rename, replacement, or identity change should
trigger policy refresh. Observation overrides only boundary delivery:
descendants remain unwatched and symlinks are not followed. Both options join
`initialExclusions` at generation zero.

`subscription.replaceExclusions(generation, policy)` atomically replaces all
three sets. Omitted object fields are empty. The legacy array form remains a
prefix-only replacement and clears the newer sets, so an integration using the
new behavior should always send the complete policy object.

Check `initialCoverage` immediately after establishment. Use ordered callback
batches as the authoritative JavaScript observation boundary.
`observedState`, operation results, and native-backed getters intentionally can
describe different points in time; do not optimistically advance observed
state after an operation acknowledgement.

Callbacks are promise-aware and serialized per subscription. Keep them
cooperative with the callback context's `signal`, and make their workload
bounded. Synchronous throws and rejections are contained and counted, but still
represent consumer failures.

The `SubscriptionOptions.signal` cancels establishment only. After
`subscribe()` resolves, stop with `subscription.dispose()`. Inside a callback,
call `context.stop()` to request disposal and join it later from outside the
current callback. Never await `subscription.dispose()` from that callback,
await a later callback from the same subscription, or wait for observed state
that requires the current callback credit.

Retain the subscription strongly and dispose it explicitly. Joined disposal is
idempotent, waits for an already admitted Promise-like callback, and guarantees
that no callback begins after the promise resolves. A callback that never
settles can therefore keep disposal pending unless it observes its signal.

## Recover coverage deliberately

Call `reconcile()` only for recoverable uncertainty:
`event-overflow`, `topology-race`, or `consumer-backpressure`. It rebuilds
topology and emits a conservative root boundary; it never reconstructs lost
events. Automatic reconciliation is opt-in, bounded, and does not make a
replacement-root decision.

Treat `root-replaced` separately. Call
`recoverRoot({ identityPolicy: "original-only" })` when the original root
identity must return, or explicitly choose `"accept-replacement"` when the
application authorizes adopting the candidate at the same lexical path. Do not
silently choose identity policy on the user's behalf.

Expect reconciliation, exclusion replacement, and root recovery to share a
topology transaction gate. Handle structured `WatchboundError` fields and
`retryAfter`; never parse diagnostic message text. Keep retries bounded and
wait for the named condition to change.

## Translate exclusions at the consumer boundary

Supply the complete replacement exclusion policy with a strictly increasing
`bigint` generation. Prefixes and observed boundaries are normalized
root-relative paths; directory names are exact single components at every
depth. Every value is compared with exact Linux bytes. They are not globs,
Git-ignore rules, workspace mappings, or application defaults.

Keep ignore-policy translation in the consumer. Do not move it into the Rust
engine or Node binding. Preserve caller-supplied root components until native
symlink-ancestry validation; do not normalize away `symlink/..` before calling
Watchbound. Never follow directory symlinks.

## Contribute to the repository

Read `AGENTS.md` and `CONTRIBUTING.md` before editing. Use `docs/README.md` to
find the relevant contract, evidence, or decision records. Maintain these
ownership boundaries:

- Put filesystem semantics and the Linux inotify state machine in `engine/`.
- Keep `node/` to representation translation and lifecycle bridging.
- Put ergonomic API policy, callback handling, and automatic reconciliation in
  `js/`.
- Keep consumer ignore rules, UI policy, and logical workspace mapping outside
  the engine.

Use test-driven changes for watcher semantics and lifecycle. Run focused tests
while iterating, then run:

```sh
pnpm test
pnpm check
```

After public declaration or API-documentation changes, also run:

```sh
deno doc --lint js/index.d.ts
```

Before handing off declaration, entrypoint, package-surface, or package
documentation changes, also run:

```sh
pnpm test:packages
```

Preserve bounded queues, exact Linux path bytes, explicit watch limits, no
directory-symlink following, and the no-later-callback disposal guarantee. On
loss or pressure, prefer a root invalidation and explicit uncertainty over
over-detailed claims.

Do not record final benchmark readings until the user confirms the host is
quiet and prepared. Do not run forced-overflow conformance casually. Do not
publish packages or integrate Watchbound into Codex Desktop unless the user
explicitly expands the scope.
