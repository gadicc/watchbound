# Correctness artifact archival

The raw supervised-overflow reports contain absolute workspace and temporary
paths plus detailed host state. They remain private, ignored inputs rather than
public repository content. The committed manifest preserves their identity and
provenance without exposing their raw contents.

The private store is content addressed:

```text
$XDG_DATA_HOME/watchbound/artifacts/sha256/<sha256>.json
```

When `XDG_DATA_HOME` is unset, the approved root is
`~/.local/share/watchbound/artifacts/sha256`. The user confirmed on 2026-07-20
that `~/.local` is backed up. This is an interim project archive, not a package
runtime dependency or a public download service.

## Archival contract

1. Hash and size each ignored source report before copying it.
2. Refuse to overwrite an existing content-addressed object. If the destination
   exists, verify its hash and byte identity instead.
3. Copy rather than move, then hash the destination and compare it byte for byte
   with the source.
4. Add or update a committed manifest entry with the logical filename, hash,
   size, schemas, result, source and native provenance, host-preparation record,
   classification, archive location, and caveats.
5. Keep failed, skipped, and error evidence. Never admit failed semantic trials
   to pass-only performance aggregates.
6. Retain the private object until a successor durable archive and any public
   sanitized derivative are independently verified. A sanitized derivative
   does not by itself authorize deletion of the exact original.

The current collection is recorded in
`docs/artifacts/overflow-reconciliation-2026-07-20.json`. The raw objects are
correctness evidence only; Watchbound never reads them at build time or run
time.

## Public evidence boundary

Do not commit an original report merely because it is small. A public
derivative must be produced by a deterministic, tested sanitizer, identified by
its own hash, and linked to the private original hash in the manifest. The
initial design work for that follow-up is in
`plans/public-evidence-sanitization.md`.
