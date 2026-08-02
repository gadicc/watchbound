# Symlink-root and resolved-path contract

Watchbound keeps strict root admission as the default. Callers that open a
repository through a symlinked or otherwise lexical pathname may opt in with
`rootPathPolicy: "resolve-physical"`. That option is an explicit namespace
change, not a relaxation of the existing root-ancestry checks.

## Two root identities

Every established subscription exposes one immutable `resolvedRoot` snapshot:

- `lexicalPath` and `lexicalPathBytes` are the absolute pathname spelling
  supplied to the engine. They preserve `.` and `..` components and serve as a
  consumer mapping identity; the watcher does not use them after resolution.
- `physicalPath` and `physicalPathBytes` identify the canonical directory used
  by traversal, inotify, callbacks, exclusions, reconciliation, and recovery.
  The string is `null` when the exact physical bytes are not valid UTF-8.
- `identity` is the physical `(device, inode)` committed at establishment. It
  equals `initialRootState.identity` and remains historical if a later
  `recoverRoot` call adopts a replacement.
- `pathForm` is `physical`, and `aliasTracking` is
  `establishment-snapshot`, so consumers do not have to infer either rule.

With the default `strict` policy, every supplied component is inspected before
lexical cancellation and any symlink is rejected. With `resolve-physical`, the
operating system resolves the exact supplied path in filesystem order. Nested
symlinks are allowed, and `link/..` means the parent of `link`'s resolved target,
not a JavaScript-normalized cancellation of `link`.

## One physical namespace

All callback `invalidatedPaths` and exact `invalidatedPathBytes` use the
canonical physical namespace. `RootState.identity` identifies that physical
root. `initialExclusions`, `excludedDirectoryNames`, `observedExcludedPaths`,
and later `replaceExclusions` policies are root-relative to the same physical
root. Observed excluded boundaries are consequently delivered as physical
absolute paths.

Relative exclusion values must contain only normalized child components.
Absolute paths, `.` and `..` are rejected before topology mutation, so an
exclusion cannot escape the canonical root. Descendant directory symlinks are
still never followed; opting into root resolution changes only admission of the
subscription root itself.

Consumers that retain logical workspace names can map the physical prefix to
the lexical prefix using `resolvedRoot`. They must treat that as their own
logical projection: Watchbound intentionally does not claim the lexical alias
still resolves to the physical directory after establishment. Exact physical
bytes remain authoritative when either side is not representable as UTF-8.

## Alias mutation and recovery

Resolution is a snapshot. Removing, recreating, replacing, or retargeting the
root symlink—or any symlinked ancestor—does not move an established
subscription and does not by itself change `rootState`. Events continue to come
from the captured physical directory. A new subscription resolves the lexical
path again and may therefore choose a different physical root.

`recoverRoot` is also anchored to `resolvedRoot.physicalPath`, never to the
lexical alias:

- alias retargeting while the physical root is attached makes `recoverRoot`
  reject with retryable `WATCHBOUND_ROOT_STATE_CONFLICT`;
- if the physical pathname is absent, the operation returns the non-attached
  `candidate-missing` result even when the lexical alias points elsewhere;
- `original-only` accepts only the original physical `(device, inode)` when it
  returns at the captured physical pathname;
- `accept-replacement` may adopt a different identity only at that same
  physical pathname;
- invalid recovery options and operations after disposal are non-retryable
  errors, while missing, non-directory, unstable, or unwatchable candidates are
  explicit non-attached results whose reason tells the caller what must change.

Neither reconciliation nor automatic reconciliation changes a root identity or
re-resolves a lexical alias.

## Races, escape resistance, and cleanup

Canonical resolution happens before runtime acquisition. The canonical result
is then subjected to the ordinary no-symlink physical-ancestry check, and the
worker captures the physical identity before opening topology, installs a watch
before reading each directory, and validates the root again before committing
establishment. Recovery repeats candidate capture and identity validation at
its admission, watch-installation, traversal, and final-commit barriers. Any
ordinary replacement observed at those boundaries fails establishment or
produces explicit root-loss/identity-unstable evidence; failed establishment,
failed recovery, cancellation, and disposal drain logical interests and native
watches before acknowledgement.

These checks resist accidental and ordinary concurrent alias/path changes; the
alias itself cannot redirect a subscription after canonicalization. They do not
turn Watchbound's path-based engine into a hostile-filesystem security boundary.
A malicious same-user actor that switches components or mounts between syscalls
remains outside the supported threat model in
[`security-threat-model.md`](security-threat-model.md). Supporting that actor
would require held directory descriptors plus constrained `openat2`-style
relative traversal, not a weaker symlink option.
