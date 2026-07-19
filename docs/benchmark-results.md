# Final benchmark results

Status: intentionally pending.

The benchmark harness is implemented and has received small functional smoke
coverage. No smoke timing or RSS observation is promoted to a final reading.
Per the measurement stop condition, the final 1,000/10,000-directory and burst
series will run only after the user confirms that unrelated I/O-intensive work
has stopped and the host is prepared as described in
`docs/benchmark-methodology.md`.

The readiness pass now keeps failed trials out of semantic performance
aggregates, measures mutation generation separately from delivery, reports true
time-to-all-expected-paths, supervises the forced-overflow helper, enforces
phase quiescence, and records exact Watchbound source/binary identities. These
changes were verified with syntax, focused harness-unit checks, and a
six-scenario Watchbound-only functional smoke (normal, moved-in, root loss,
watch limit, bridge backpressure, and disposal). All six passed. That smoke is
non-authoritative and did not trigger a full/final comparison, overflow case,
or performance run; none of its timing or memory fields are promoted here.

The readiness pass also prevents diagnostic watch counts or root lifecycle
notifications from becoming false passes: the watch-limit contract requires
structured partial coverage, and root replacement requires recovery or typed
coverage loss. Native bridge backpressure has its own conformance-only case,
and overflow startup now uses a controller handshake rather than a timing
delay.

The final update to this file should include:

- raw-result filenames and exact source/package identities;
- the report schema version, pass-only `performanceRuns` counts, and any skipped,
  observed, failed, or errored trials;
- medians and ranges for startup, memory, CPU, watch count, delivery, and
  disposal;
- mutation-duration and time-to-all-expected-path ranges, without substituting
  callback latency for semantic completion;
- missed/duplicate counts and conformance failures;
- important host state, source/native hashes, filesystem identity, CPU governor,
  inotify limits, and methodology deviations;
- the final continue / Parcel-wrapper / change-direction recommendation.
