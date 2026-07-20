# Correctness and capability findings

Status: final first-milestone Linux findings as of 2026-07-19, with targeted
manual, overflow, and opt-in automatic reconciliation follow-up on 2026-07-20.
Performance ranges and the continuation decision are in
`docs/benchmark-results.md`.

## Second-milestone correctness update

The benchmark's intermittent directory-burst `topology-race` was reproduced
deterministically by expiring a batch deadline during serialized subtree
discovery. The engine had treated the expired delivery window as proof of a
filesystem race, invalidated the root, and discarded otherwise valid detailed
paths. The worker now completes the watch-before-read topology transition and
lets the event loop perform the already-bounded flush immediately afterward.

The regression first failed with the measured root-collapse behavior. It now
passes together with eight live 1,000-directory rounds using a 1 ms batch
window, a 64-path batch maximum, and a bounded 64-batch output queue. Every
round retained complete coverage, all 1,000 detailed paths, monotonic sequence
numbers, 1,001 live directory watches, and the configured batch bound. This was
a targeted stress check, not a replacement final conformance or benchmark run.

The rebuilt release Node-API proof then passed all eight serial focused harness
trials with zero missed or duplicate paths, invalidations, drops, asynchronous
errors, or cleanup errors. The raw schema-2 report is
`benches/results/conformance-second-milestone-directory-burst-targeted.json`
(SHA-256 `11ce5527f1f2f7a7747070b7dcf71e4e939cb4acfcf0a0eaef4ec29bb899629a`),
with source digest
`254b88cd4055af4e365f6524c7e7e658595686ee3e51fb47664cc430370c2c32`
and native artifact SHA-256
`43a39a898613560d7ed34042288ee2535dabe6ac20000921a7c5ce1f74d87eaf`.
All-path delivery ranged from 6.20 to 17.96 ms, but the host was not prepared or
sampled for final performance work (load average 3.20 to 3.19 on 24 logical
CPUs, `powersave`, tmpfs), so that range is functionality context only.

## Public reconciliation conformance update

The next targeted milestone adds a dedicated Watchbound reconciliation
scenario through the Node/JavaScript public subscription and benchmark adapter.
It induces recoverable `consumer-backpressure` deterministically by blocking a
callback while bounded native output is pressured, waits for the path to drain,
and calls `reconcile()` on the same subscription. The checks retain the
uncertain interval, unchanged exclusion generation, ordered batches and
coverage transitions, one root-only conservative recovery boundary, matching
result/root coverage, post-reconciliation delivery, peer-subscription
isolation, errors, and joined native cleanup. Unsupported adapters are excluded
by strict capability checks rather than credited with a pass.

This is ordinary-development correctness and stress evidence. No new final
conformance or benchmark readings are recorded here, and the historical series
below is unchanged. Callback-blocking does not induce a real kernel queue
overflow, so it is not evidence for native-overflow recovery; the supervised
forced-overflow run remains separately gated on explicit host preparation.
Recovery of a replaced root identity remains open.

## Opt-in automatic reconciliation update

The wrapper now owns a default-disabled bounded policy over the existing public
reconciliation primitive. Focused deterministic tests cover all three allowed
reasons, repeated-loss coalescing before and during an attempt, one active call,
post-enqueue loss, capped exponential backoff and terminal exhaustion,
root-replacement blocking, incomplete coverage, timer cancellation, active
join, idempotent disposal, and no later retry. Native reconciliation and
exclusion tests remain authoritative for generations, transaction conflicts,
root-only delivery, sequences, and current/future exclusions; no engine or
Node-API contract changed.

The ordinary `automatic-reconciliation` harness scenario passed its targeted
strict quick run through the public wrapper. The harness made zero manual
reconciliation calls and retained one original subscription. Deterministic
`consumer-backpressure` was explicit, generation one stayed committed, exactly
one singleton root recovery boundary matched complete policy coverage, all
sequence/generation evidence was complete and monotonic, excluded prefixes did
not leak, a peer delivered during the scan, the deep sentinel arrived, and
inotify, eventfd, thread, and subscription state returned to baseline. This
unsaved development run is correctness evidence only, not a performance
reading and not genuine-overflow evidence. Failed recovery remains raw
correctness evidence and is excluded from pass-only performance aggregates.

## Supervised overflow-reconciliation evidence

After explicit quiet-host confirmation, the dedicated
`overflow-reconciliation` scenario passed one strict targeted trial through the
public Node/JavaScript surface. The detached helper confirmed the watcher was
stopped before creating 20,480 distinct files against a 16,384-event queue and
confirmed resume afterward. Watchbound reported typed `event-overflow`,
invalidated the root, advanced its native overflow counter, drained with no
output drop, remained uncertain through the interval mutation, and reconciled
the original subscription to complete coverage.

Generation zero and committed generation one remained unchanged, every batch
had monotonic sequence/generation evidence, and recovery produced exactly one
singleton root batch whose coverage matched the public result. Current and
future exclusions remained effective; interval detail received no guaranteed
reconstruction credit; the shared-stream peer reported truthful uncertainty
and delivered during the scan; the deep sentinel arrived afterward. Joined
disposal restored watches, inotify descriptors, the runtime eventfd, bridge
threads, worker, and subscription state to baseline, rejected later
reconciliation, and admitted no later callback.

Capability checks exclude adapters without public reconciliation, explicit
overflow/coverage, atomic exclusions, or the supervised mechanism; synthetic
loss and deterministic consumer backpressure do not receive genuine-overflow
credit. `--quick` removes both forced-overflow scenarios, and selecting either
heavy scenario requires `--allow-forced-overflow` before any probe or trial can
start. That flag does not establish host readiness. The passing raw artifact and
the retained first-attempt harness-bookkeeping failure are identified in
`docs/benchmark-results.md`; neither replaces the historical performance
series. Automatic genuine-overflow recovery has not been run in this milestone;
root-replacement recovery remains open.

## Exact Codex JavaScript helper

The baseline imports
`codexLinuxStartDirectoryOnlyWorkingTreeWatch` directly from the existing
feature; it does not copy or approximate the implementation. The feature was
introduced by commit `b49b4d661567093f2e472a933dfa9affbe9c02b4`; the inspected
worktree was at `f126ebe6b4495e8013804486f982f262b1ab866b` with `patch.js` SHA-256
`e619307502b7330421232b703757b8acbc9b7136c2b1942898eade214ade5f6e`.

- All 110 upstream tests passed on Node 25.2.1.
- The standalone adapter confirmed one working-tree watch per included
  directory. Callbacks stopped after disposal, but the final harness still
  observed one retained inotify instance after the disposal window in all ten
  measured disposal trials.
- Independent harness smoke cases passed normal deep changes, populated
  moved-in subtrees, same-path root replacement, bursts, and post-disposal
  silence.
- Its callbacks are not event batches: a single filesystem operation may emit
  multiple callbacks and duplicate logical paths.
- Public coverage deliberately reports non-recursive coverage to Codex policy,
  but it does not expose structured complete/partial/uncertain engine state.
- Runtime name exclusions are unavailable. Git-derived exclusions updated
  successfully in all three unrestricted final conformance trials.
- There is no typed public native-overflow result. In all three forced-overflow
  trials the adapter conservatively invalidated the root and later delivered
  the sentinel, but could not identify overflow as the reason.

## `@parcel/watcher` 2.5.6

The released Linux x64/glibc prebuild was forced to its inotify backend.
Independent live reproductions and the tagged source agree:

- A normal existing deep-file update was delivered.
- Moving a populated nested tree into the root emitted the incoming directory,
  but a later modification of its deep existing file emitted nothing. The
  Linux backend adds the incoming directory watch without recursively scanning
  its existing descendants. See the tagged
  [inotify backend](https://github.com/parcel-bundler/watcher/blob/v2.5.6/src/linux/InotifyBackend.cc#L165-L184).
- Moving the watched root away emitted its deletion, but a new directory at the
  same pathname was not watched and a deep replacement change emitted nothing.
  See [root self-event handling](https://github.com/parcel-bundler/watcher/blob/v2.5.6/src/linux/InotifyBackend.cc#L193-L214).
- Each final forced queue overflow generated 20,480 distinct files. Exactly
  8,192 paths were delivered and 12,288 were missing in all three runs; no
  error or invalidation was reported, and a later sentinel still arrived. An
  earlier independent induction produced different counts but the same silent
  loss. The source explicitly skips `IN_Q_OVERFLOW`.
  See [overflow handling](https://github.com/parcel-bundler/watcher/blob/v2.5.6/src/linux/InotifyBackend.cc#L96-L132).
- The public API has static ignores only. Overlapping subscriptions are not a
  safe atomic-update emulation because the cached directory tree is keyed by
  root rather than ignore set; live tests produced both stale extra watches and
  missing newly included watches.
- Calling one subscription handle's `unsubscribe` twice reopened and retained
  an empty shared inotify backend in the reproduced case. The adapter therefore
  caches an idempotent disposal promise.

Parcel remains a strong stable-tree performance and packaging baseline, but a
small faithful wrapper cannot reconstruct coverage or loss information that its
Linux backend does not surface.

## Watchbound prototype

- Fourteen filesystem integration tests cover initial recursive coverage,
  newly created topology, moved-in populated trees with a later deep write,
  bounded file and repeated directory bursts with sequence order, current
  watch-limit/deferred accounting, symlink ancestry, direct and ancestor root
  replacement, and joined disposal.
  Ten backend unit tests cover overflow, full-consumer-queue bounds, unmount and
  unexpected watch loss, symlink/descriptor-alias defenses, uncertainty
  precedence, stale root establishment, and interruptible runtime scanning.
- The Node-API proof covers subscription, exact path bytes, batched callbacks,
  structured initial coverage, strict numeric options, synchronous absolute-root
  capture, statistics, callback versus bridge errors, per-environment teardown
  signaling, concurrent idempotent disposal, and no callback after disposal
  resolves. Wrapper tests cover non-UTF-8 collapse and GC cleanup when a callback
  captures its subscription.
- The unrestricted final conformance suite passed all 30 applicable Watchbound
  trials: normal deep changes, populated moved-in subtrees, root replacement,
  watch limits, bridge backpressure, forced overflow, all three burst types,
  and disposal.
- Root move/replacement is explicitly reported as uncertain and invalidates the
  root. A 250 ms lexical path-identity check also detects an ancestor move.
  Automatic same-path replacement recovery is not implemented, so a deep
  follow-up in the replacement is not delivered.
- In all three process-level forced-overflow trials, the helper confirmed the
  watcher was stopped before creating 20,480 files against a 16,384-event
  queue. Watchbound reported `event-overflow`, invalidated the root, drained,
  and delivered the later sentinel.
- One of seven measured directory bursts reported `topology-race`, invalidated
  the root, and missed 864 detailed paths. The final three conformance repeats
  passed. The failure was explicit but remains next-milestone work.
- At the time of the first final series, dynamic exclusions and process-wide
  multi-root fairness were not implemented. Later engine milestones added both;
  the statement is retained here as historical context for those readings.

## Original first-series direction (historical)

Continue Watchbound to a second Linux engine milestone rather than switching to
a Parcel wrapper. The reproduced moved-in-tree, root-lifecycle, and silent
overflow behavior means Parcel's public API cannot currently satisfy “never
silently claim more coverage than exists.” Benchmark startup and memory are
close enough to Parcel that performance is not a stop signal. Do not integrate
or publish until the intermittent topology race, shared multi-root scheduling,
and exclusion design are resolved.

The shared-runtime scheduling, dynamic-exclusion, and explicit bounded
reconciliation gaps named in that decision have since been implemented and are
covered by targeted tests. That later work does not replace the recorded first-
series measurements. Automatic policy is now implemented above the unchanged
native primitive; root replacement remains the separate recovery gap.
