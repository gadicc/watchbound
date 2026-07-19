# Benchmark and conformance methodology

Status: harness complete; final performance run intentionally deferred until
the host can be made quiet.

## What the harness compares

Every adapter is loaded in a fresh child process for every trial:

- local Watchbound release-mode Rust engine through its Node-API proof;
- the exact current Codex Linux JavaScript helper loaded directly from its
  exported function;
- exactly `@parcel/watcher` 2.5.6 with `backend: "inotify"` forced.

The Codex helper path is configurable with `WATCHBOUND_CODEX_WATCHER_PATH` and
its SHA-256, size, and modification time are recorded. Parcel's adapter refuses
any version other than 2.5.6. The Watchbound adapter records the actual loaded
`.node` path, SHA-256, size, modification time, any native-library override, and
its batching/queue settings. The report also records a deterministic digest of
the Watchbound Rust/Node/JavaScript source inputs plus Git HEAD/dirty state when
available. The expected build command uses Cargo's release profile; the binary
hash, rather than that expectation, is the authoritative artifact identity.

Each trial is serial and isolated. Adapter order rotates across repetitions so
slow temperature, cache, or background-system drift does not always favor the
same implementation.

## Scenario matrix

Conformance exercises:

- an existing deep-file change;
- a populated tree moved into the root, followed by a deep change;
- watched-root move and same-path replacement, requiring either successful
  same-path recovery or an explicit `root-replaced` coverage loss; a lifecycle
  notification alone is diagnostic and cannot pass the scenario;
- an explicit low watch limit; watch counts are diagnostic, and only an adapter
  exposing both explicit limits and structured partial coverage receives an
  applicable pass/fail contract check;
- a deliberately blocked JavaScript callback with a two-entry native output
  queue, requiring a recorded dropped native batch, an explicit
  consumer-backpressure report, and root invalidation (only for adapters
  exposing that contract); the per-batch path limit is held above the
  workload's unique-path cardinality so it cannot satisfy this check;
- a forced native queue overflow and post-overflow sentinel;
- active dynamic exclusions where the adapter truly supports them;
- file, directory, and rename bursts;
- mutation after disposal resolves.

The timed benchmark adds first-subscription and second-subscription startup for
1,000 and 10,000 directory trees by default. Bursts default to 1,000 operations.
Larger trees may be added as a separately labelled series.

“Cold” means the first subscription in a fresh process. “Warm” means a second
subscription after one complete subscribe/dispose cycle in that fresh process.
These labels do **not** claim cold or warm kernel page cache. Trees are newly
created for each trial and cache state is not forcibly changed.

## Measurements

The report preserves every raw trial, including failures, skips, and errors.
Numeric performance aggregates use completed **passing** trials only, expose
their sample count as `performanceRuns`, and retain separate all-completed
correctness summaries. This prevents a missed-event timeout or partial-coverage
startup from masquerading as a slow or fast implementation.

Pass-only min/median/max/mean aggregates cover:

- adapter load and subscription latency;
- process CPU time;
- RSS, JS heap, external, and array-buffer deltas;
- startup and post-burst steady-state memory deltas;
- inotify instance and watch-descriptor deltas from `inotify wd:` records in
  `/proc/self/fdinfo/*`;
- callback/batch count separately from flattened path-event count;
- first/final callback latency, first-expected latency, and true
  time-to-all-expected-paths;
- missed and duplicate expected paths;
- disposal latency, CPU, memory, and inotify instance/watch release.

Raw trials retain structured coverage and adapter statistics where public.
Mutation duration is measured separately. For synchronous mutation scenarios,
delivery clocks start when the mutation loop ends; they do not include the time
spent generating the workload. Watchbound uses a recorded 10 ms native batch
window, Parcel uses its versioned native debouncer, and the Codex helper emits
unbatched callbacks. Callback count and callback latency therefore describe the
real adapter policy, while time-to-all-expected-paths is the common semantic
completion measure.

Every phase records whether callbacks reached the configured quiet window.
Multi-phase scenarios do not begin a later mutation after a phase fails to
quiesce. The fixed topology delay is a discovery/recovery observation window;
the report keeps it explicit rather than treating it as an unreported constant.

RSS is allocator and high-water-state evidence, not precise ownership. Small
differences and any single sample are not treated as meaningful. CPU time does
not identify which native thread consumed it. Latency includes scheduler noise.
All conclusions should start with medians and ranges, then inspect raw trials.

## Quiet-host preparation for the final run

Before recording final readings:

1. Finish the release build and test pass first, so compilation and dependency
   I/O are outside the measurement window.
2. Put the machine on stable AC/power and use one documented CPU governor. Do
   not change it between implementations.
3. Stop or wait for builds, package managers, indexers, backups, downloads,
   virtual machines, and other disk- or CPU-intensive work.
4. Use one local filesystem and one temp parent with sufficient free space.
   Record the filesystem if it is not the normal local filesystem.
5. Leave inotify sysctls unchanged throughout the run and record their values
   from the report.
6. Do not casually drop kernel caches. If a privileged cold-cache series is
   desired, run and label it separately with the exact preparation procedure.
7. Prefer at least seven benchmark repetitions for final comparisons. Keep the
   default rotating adapter order.
8. Retain the raw JSON and summarize it in `docs/benchmark-results.md`; do not
   replace ranges with a lone rounded number.
9. Confirm the report's source digest, native artifact hash, temp-filesystem
   identity, CPU governor, inotify limits, and pass-only sample counts before
   promoting any aggregate.

## Forced-overflow safety and interpretation

The I/O-heavy overflow scenario is conformance evidence, not a performance
reading. A detached helper waits on its own IPC channel while the trial reports
its process group to the unstopped controller; only the controller-notification
send callback releases the helper to stop the watcher. The controller kills
that group and resumes/kills the watcher on a hard timeout.
The helper confirms `/proc/<pid>/status` reached a stopped state before creating
more distinct files than `max_queued_events`, and always attempts `SIGCONT` on
normal errors and handled termination signals.

The report separates this induction evidence from the adapter's loss report.
After resume it waits for activity and a quiet window before writing the
sentinel; there is no fixed post-resume sentinel delay. Failure to establish a
quiet boundary is reported separately and the sentinel phase is not started.
An uncatchable helper failure is still contained by the controller's process-
group timeout cleanup.

## Commands

Small non-authoritative harness/functionality check (forced overflow is
omitted) is allowed before host preparation:

```sh
node benches/conformance.mjs --quick --output benches/results/conformance-smoke.json --quiet
```

Final correctness run, including the I/O-heavy forced-overflow case, after the
user confirms the host is ready:

```sh
node benches/conformance.mjs \
  --runs 3 \
  --output benches/results/conformance-final.json \
  --quiet
```

Final performance run after the user confirms the host is ready:

```sh
node --expose-gc benches/benchmark.mjs \
  --runs 7 \
  --directories 1000,10000 \
  --burst-count 1000 \
  --output benches/results/benchmark-final.json \
  --quiet
```

The comparison suite intentionally contains negative baseline cases, so
`--strict` is useful for adapter-specific gates but not for the all-adapter
evidence run. Strict mode fails errors, failed checks, skips/exclusions, cleanup
errors, and zero-completion runs. `--quick` rejects an explicitly requested
overflow-only suite instead of producing a successful empty report.
