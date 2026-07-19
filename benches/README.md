# Watchbound baseline harness

This directory contains a standalone Linux benchmark and conformance harness for the local
prototype and two exact baselines:

- the Watchbound Rust engine through its Node-API proof;
- the current Codex JavaScript directory watcher exported by `patch.js`;
- `@parcel/watcher` 2.5.6 with its `inotify` backend selected explicitly.

Every capability probe and every measured trial runs in a fresh Node child process. Trials run
serially. The controller receives results over IPC, so implementation logs on stdout or stderr do
not corrupt the report's JSON.

## Commands

```sh
node benches/conformance.mjs --quick --pretty
node benches/conformance.mjs --adapter watchbound --scenario reconciliation --quick --strict --pretty
pnpm test:reconciliation-stress
node --expose-gc benches/benchmark.mjs --pretty
node --expose-gc benches/benchmark.mjs --quick --pretty
```

The benchmark defaults to three trials, 1,000- and 10,000-subdirectory startup trees, and
1,000-operation file, directory, and rename bursts. Use `--help` for filters, sizes, timeouts, and
the strict exit-code mode. Adapter order rotates across repetitions to balance system drift. The
report includes raw trials and median/min/max/mean aggregates.

`WATCHBOUND_CODEX_WATCHER_PATH` selects the exact Codex helper and defaults to:

```text
/home/dragon/src/codex-desktop-linux/linux-features/directory-only-working-tree-watch/patch.js
```

The adapter records the loaded file's SHA-256 digest, size, and modification time. Parcel must
resolve to exactly version 2.5.6. `WATCHBOUND_PARCEL_WATCHER_PATH` can point at that package when it
is not resolvable from this workspace. The Watchbound adapter records the resolved native binary's
path, SHA-256, size, modification time, expected release build command, and batching/queue options;
the report records a deterministic source-input digest and Git state as well.

## Scenarios and accounting

The suite covers ordinary deep changes, populated moved-in trees followed by a deep modification,
root move/same-path replacement followed by a deep modification, forced inotify queue overflow,
an explicit low watch limit, explicit native-to-JavaScript bridge backpressure, dynamic exclusions, file and
directory creation bursts, in-place post-loss reconciliation, rename bursts, and post-disposal mutation. Cold startup is the first
subscription in a fresh child, with module loading measured separately. Warm startup creates and
disposes one subscription in that fresh child before measuring the second subscription. Both trials
measure subscription and disposal separately.

The report keeps callback/batch count separate from the number of delivered path events. Mutation
duration is separate from delivery latency, whose clock begins at mutation end. It records true
time-to-all-expected-paths in addition to callback latency, missed expected paths, duplicate expected
events, process CPU time, RSS/heap/native memory snapshots, and disposal latency. Numeric performance
aggregates contain passing trials only; every failed/skipped/error raw trial remains in the report.
On Linux, inotify usage is the delta of
`inotify wd:` records in `/proc/self/fdinfo`; lack of readable procfs is reported as an unsupported
measurement rather than inferred as zero.

Parcel has no public active-subscription exclusion update. Watchbound exercises its
generation-based atomic exclusions, while the Codex adapter exercises its Git-ignore-derived
refresh, which is dynamic but not atomic; if `git` cannot run, that trial is an explicit runtime
skip.

RSS is allocator/high-water-state data and can be noisy even with `--expose-gc`. Use repeated runs
and the aggregates rather than treating a single RSS delta as precise implementation ownership.

Forced overflow is intentionally omitted by `--quick`. The full conformance command uses a detached,
controller-supervised helper. An IPC/stdin handshake records the helper process group before it can
stop the watcher; it then confirms the watcher reached `SIGSTOP` and creates
`max_queued_events + 4096` distinct files. It records that mutation began only after the stop was
confirmed, finished before resume, and that `/proc` no longer showed the watcher stopped afterward.
After resume, the watcher must show activity and reach a
quiet boundary before the harness starts a separate sentinel phase. Induction evidence, explicit
coverage/loss reporting, drain status, and sentinel delivery are separate results. It is a correctness
stress case and should be run only after the user explicitly confirms that the host is quiet and
prepared. Selecting `queue-overflow` or `overflow-reconciliation` requires
`--allow-forced-overflow`; the acknowledgement never infers host readiness. Both scenarios are
removed by `--quick`, and an overflow-only quick selection fails because no scenario remains.

The bridge-backpressure case is likewise conformance-only: it blocks the first JavaScript callback,
keeps producing mutations, and requires both a native output-queue drop and a typed root-dominant
`consumer-backpressure` invalidation. Adapters without that public contract are excluded rather than
credited with a pass.

The reconciliation case uses the same deterministic callback-blocking mechanism to make recoverable
`consumer-backpressure` uncertainty observable without overflowing the kernel queue. It calls
`reconcile()` on the existing Watchbound subscription after the output path drains; it never
unsubscribes and resubscribes. The scenario records the committed result, unchanged exclusion
generation, ordered batches and coverage transitions, the single conservative root boundary,
post-reconciliation sentinel delivery, peer-subscription progress, timings, errors, and final
resource state. Current and future excluded prefixes must remain excluded, and mutations made while
coverage is uncertain or reconciliation is scanning are represented by the root boundary rather
than reconstructed as guaranteed detail.

Capability gating is strict: the adapter must expose the complete public existing-subscription
method together with explicit coverage, typed consumer backpressure, and atomic exclusions.
Unsupported adapters are excluded with a reason and receive no pass credit. A successful
acknowledgement means the matching result coverage and root batch have entered the bounded native
output path; it does not mean the JavaScript callback has already run. Joined disposal must release
both subscriptions, watches, descriptors, bridge state, and the final worker without allowing a
later callback or reconciliation.

The quick strict command above runs this scenario but still omits forced overflow. For modest repeat
coverage, use `pnpm test:reconciliation-stress`, which expands to:

```sh
node benches/conformance.mjs --adapter watchbound --scenario reconciliation --runs 5 --burst-count 100 --strict
```

The repeat command intentionally omits `--quick`, because that preset selects one run. Both commands
are ordinary-development evidence only. They do not prove recovery from a real inotify overflow; the
separately supervised forced-overflow run remains gated on explicit host-preparation confirmation.

`overflow-reconciliation` combines the two evidence paths without treating one as the other. It
requires Watchbound's public existing-subscription reconciliation, typed `event-overflow`, explicit
coverage, atomic exclusions, and the supervised helper; unsupported adapters are excluded with an
explicit reason and receive no pass credit. After genuine overflow is reported and the output path
quiesces, the scenario mutates during the still-uncertain interval and calls `reconcile()` on the
original subscription. It requires unchanged generation zero and committed generation one, complete
monotonic batch counters, one singleton root recovery boundary with coverage identical to the public
result, truthful peer coverage and delivery during the bounded scan, exclusion preservation, a deep
post-recovery sentinel, lifecycle rejection after idempotent disposal, and restoration of watches,
inotify descriptors, the runtime eventfd, bridge threads, worker, and subscription state.

Loss-interval detail is retained only as diagnostic evidence; it is never credited as guaranteed
reconstruction. `root-replaced` remains non-recoverable. Reconciliation acknowledgement means the
matching root boundary entered the bounded output path, while the JavaScript callback may start
later. The targeted heavy command is `pnpm test:overflow-reconciliation`, but it embeds the permission
flag and must not be invoked until the user separately confirms host preparation. This implementation
did not run it or record a new final result.
