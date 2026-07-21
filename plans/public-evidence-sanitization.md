# Public evidence sanitization plan

Status: sanitizer `1.0.0` and its synthetic tests are implemented. No private
report has been transformed, no public derivative has been generated or
committed, and each real derivative still requires explicit approval and
manual review.

## Goal

Make selected raw correctness reports safe and useful to commit in a future
public Watchbound repository while retaining a verifiable relationship to the
exact private originals. Sanitization creates derived evidence; it never
changes or replaces an original content-addressed object.

## Implemented shape

- `scripts/sanitize-conformance-report.mjs` accepts conformance report schema 2
  only and emits byte-deterministic, key-sorted JSON for public evidence schema
  1. The schema is
  `docs/schemas/public-conformance-evidence-v1.schema.json`.
- Input and output are bounded by byte size, depth, node count, array length,
  object key count, and string byte size. Unsupported report schemas, new
  top-level/config/system/source fields, unknown path-bearing fields, invalid
  UTF-8, source/native identity mismatches, and redaction collisions fail
  closed.
- The exact input SHA-256 and byte size must match one unique entry in the
  committed private-artifact manifest. Source commit, dirty state/count,
  source digest, report outcome, and every reported Watchbound native artifact
  hash must also match that entry.
- The public document records the private original hash and logical filename,
  source and native identity, result classification, sanitizer version, and
  disclosure policy. The complete derivative file SHA-256 is calculated over
  canonical bytes and returned as the proposed manifest linkage; it cannot be
  embedded in the bytes it hashes.
- The CLI writes without overwrite and only below `benches/evidence/`. That
  directory is intentionally absent until a derivative is separately approved.

## Disclosure policy

The sanitizer allowlists the schema-2 report sections and the system, config,
source-identity, and temporary-filesystem fields it understands. Nested result
evidence remains structurally intact except for explicitly fingerprinting
fields and path/string redaction.

- Workspace, home, configured temporary, and per-trial roots become
  `$WORKSPACE`, `$HOME`, `$TEMP_ROOT`, and `$TRIAL_ROOT`. The same substitutions
  apply inside errors, stacks, diagnostics, arrays, and object keys. An
  unapproved absolute path remaining after substitution rejects the report.
- Exact wall-clock timestamps become `$TIMESTAMP`. Relative monotonic timings
  and durations remain.
- Kernel identity is reduced to major.minor. CPU model, logical CPU count,
  total memory, load averages, temporary-filesystem device/capacity details,
  process/thread IDs, file descriptors, native modification time, and dirty
  pathnames are omitted. Fixed public `/proc` and `/sys` methodology paths are
  allowed.
- Counts, relative topology, ordered sequences, coverage states and
  transitions, uncertainty reasons, exclusion generations, all semantic
  checks, source/native hashes, cleanup/disposal state, and the distinction
  between correctness evidence and pass-only performance samples remain.

## Synthetic verification

`scripts/test/fixtures/conformance-schema-2-private.synthetic.json` contains
only invented identities and paths. Its tests cover nested home/workspace/temp
and trial paths, path-like object keys, errors and stacks, deterministic bytes,
private-literal scanning, unsupported schema and unknown-path rejection,
bounds, source/native linkage, and tampering.

The deliberately failed synthetic trial illustrates the preservation rule:

| Synthetic private value | Sanitized evidence |
| --- | --- |
| `/home/casey-example/src/watchbound` | `$WORKSPACE` |
| `/var/tmp/watchbound-bench-nonce-7QZ/root/missed.txt` | `$TRIAL_ROOT/root/missed.txt` |
| outcome `fail`, one failed check | outcome `fail`, the same failed check |
| aggregate `failed: 1`, `performanceRuns: 0` | unchanged |
| inotify before/after counts | retained, with file-descriptor entries omitted |

The review recomputes the expected derivative, verifies canonical bytes and
the full derivative hash, and separately reports preservation checks for all
checks, counters, ordering, coverage, generations, resource restoration,
classification, and pass-only aggregation.

## Approval-gated real workflow

Do not run the CLI on a private report merely because the tooling exists. For
each proposed derivative:

1. Obtain explicit maintainer approval naming the private logical filename,
   its committed SHA-256, and the intended public logical path.
2. Invoke the CLI with that exact hash as
   `--approved-private-sha256`, name the reviewer with `--reviewed-by`, and
   choose an output below `benches/evidence/`. Argument authorization is
   validated before the private input is read.
3. Preserve the private original. Manually inspect the output for disclosure
   and semantic usefulness even though automated review passes.
4. Record the proposed linkage in the manifest only after review:

   ```json
   {
     "privateOriginalSha256": "<committed-private-sha256>",
     "sanitizerVersion": "1.0.0",
     "publicSchemaVersion": 1,
     "publicLogicalPath": "benches/evidence/<approved-name>.json",
     "publicSha256": "<sha256-of-canonical-derivative-bytes>"
   }
   ```

5. Re-run focused tests and independent leak review before asking for separate
   approval to commit or publish the derivative. Generation does not itself
   authorize a commit, publication, upload, or deletion of the original.

## Entry and exit criteria

The sanitizer implementation is complete when its focused synthetic suite and
repository checks pass. A particular public derivative is complete only after
its separate approval, deterministic generation, manual leak review, recorded
public hash, intact private-object verification, and reviewer sign-off. No real
derivative currently meets those criteria. Until one does, keep the raw reports
ignored and use the private SHA-256 store plus committed manifest.
