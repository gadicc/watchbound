# Public evidence sanitization plan

Status: initial plan; sanitizer and public derivatives are not implemented.

## Goal

Make selected raw correctness reports safe and useful to commit in a future
public Watchbound repository while retaining a verifiable relationship to the
exact private originals. Sanitization creates derived evidence; it never
changes or replaces an original content-addressed object.

## Proposed shape

- Add a deterministic repository script, tentatively
  `scripts/sanitize-conformance-report.mjs`.
- Require the input SHA-256 to match a committed private-artifact manifest
  entry before transformation.
- Write canonical JSON with a sanitizer schema/version and its own SHA-256.
- Commit selected derivatives under a dedicated path such as
  `benches/evidence/<date>/`, not under the ignored working-results directory.
- Extend the manifest with the sanitizer version, public logical path, public
  hash, and an explicit private-original-to-public-derivative relationship.

Prefer an allowlist of retained report fields over a denylist of known secrets.
At minimum, replace workspace/native absolute paths with stable tokens such as
`$WORKSPACE`, replace per-trial temporary roots with `$TRIAL_ROOT`, and remove
or normalize paths embedded in errors and stacks. Decide explicitly whether
exact timestamps, CPU model, total memory, kernel patch version, process/thread
IDs, file descriptors, load averages, and dirty-status pathnames provide enough
review value to justify their fingerprinting risk. Counts, relative topology,
ordering, coverage states, uncertainty reasons, exclusion generations, checks,
source/native hashes, and cleanup deltas should normally remain.

## Required tests

- Nested fixtures containing home paths, workspace paths, temporary roots,
  errors, stacks, dirty paths, arrays, and path-like object keys.
- Identical input and sanitizer version produce byte-identical output.
- The output contains no original home name, absolute workspace root, trial
  nonce, or unapproved absolute path.
- The sanitizer fails closed on unknown path-bearing fields or a report schema
  it does not support.
- Structural assertions prove that outcome, all checks, counters, ordering,
  coverage transitions, generation evidence, resource restoration, and
  correctness/performance classification were preserved.
- A review fixture proves failed evidence stays visibly failed and cannot enter
  a pass-only aggregate after sanitization.

## Entry and exit criteria

Implementation should start only when public in-repository evidence is needed
and the disclosure policy for host fingerprints is decided. It is complete
only after focused tests pass, a manual leak review finds no private data, each
public hash is recorded, and a reviewer can trace every derivative to an intact
private object by the original hash. Until then, keep the raw reports ignored
and use the private SHA-256 store plus committed manifest.
