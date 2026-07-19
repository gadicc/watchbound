# Correctness and capability findings

Status: independent Linux findings as of 2026-07-19. These are correctness
observations, not final performance readings.

## Exact Codex JavaScript helper

The baseline imports
`codexLinuxStartDirectoryOnlyWorkingTreeWatch` directly from the existing
feature; it does not copy or approximate the implementation. The feature was
introduced by commit `b49b4d661567093f2e472a933dfa9affbe9c02b4`; the inspected
worktree was at `f126ebe6b4495e8013804486f982f262b1ab866b` with `patch.js` SHA-256
`e619307502b7330421232b703757b8acbc9b7136c2b1942898eade214ade5f6e`.

- All 110 upstream tests passed on Node 25.2.1.
- The standalone adapter confirmed one working-tree watch per included
  directory and deterministic release.
- Independent harness smoke cases passed normal deep changes, populated
  moved-in subtrees, same-path root replacement, bursts, and post-disposal
  silence.
- Its callbacks are not event batches: a single filesystem operation may emit
  multiple callbacks and duplicate logical paths.
- Public coverage deliberately reports non-recursive coverage to Codex policy,
  but it does not expose structured complete/partial/uncertain engine state.
- Runtime name exclusions are unavailable. Git-derived exclusions do update;
  that scenario still needs a normal, non-sandboxed final conformance run.
- There is no explicit public native-overflow result.

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
- Forced queue overflow generated 20,480 distinct files. Only 16,451 paths were
  delivered; 4,029 were missing, no error or invalidation was reported, and a
  later sentinel still arrived. The source explicitly skips `IN_Q_OVERFLOW`.
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

- Thirteen filesystem integration tests cover initial recursive coverage,
  newly created topology, moved-in populated trees with a later deep write,
  bounded batching and sequence order, current watch-limit/deferred accounting,
  symlink ancestry, direct and ancestor root replacement, and joined disposal.
  Ten backend unit tests cover overflow, full-consumer-queue bounds, unmount and
  unexpected watch loss, symlink/descriptor-alias defenses, uncertainty
  precedence, stale root establishment, and interruptible runtime scanning.
- The Node-API proof covers subscription, exact path bytes, batched callbacks,
  structured initial coverage, strict numeric options, synchronous absolute-root
  capture, statistics, callback versus bridge errors, per-environment teardown
  signaling, concurrent idempotent disposal, and no callback after disposal
  resolves. Wrapper tests cover non-UTF-8 collapse and GC cleanup when a callback
  captures its subscription.
- Small harness checks passed normal deep changes, populated moved-in subtrees,
  file/directory/rename bursts, and disposal.
- Root move/replacement is explicitly reported as uncertain and invalidates the
  root. A 250 ms lexical path-identity check also detects an ancestor move.
  Automatic same-path replacement recovery is not implemented, so a deep
  follow-up in the replacement is not delivered.
- Native overflow parsing is explicit and sticky-uncertain in unit tests. The
  new process-level forced-overflow scenario is ready but deliberately not run
  after final-measurement preparation became a user-controlled stop point.
- Dynamic exclusions and process-wide multi-root fairness are not implemented.

## Provisional direction

Continue to the controlled measurement gate rather than switching immediately
to a Parcel wrapper. The reproduced moved-in-tree and overflow behavior means
Parcel's public API cannot currently satisfy “never silently claim more coverage
than exists.” This is a provisional go: final performance readings, full forced
overflow against Watchbound, and the cost/complexity of shared multi-root
scheduling can still change the decision.
