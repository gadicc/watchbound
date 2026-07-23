# Security and path threat model

Status: approved on 2026-07-21 for the maintained-unpublished source-build
target.

## Decision

Go for same-user, trusted, stable local roots subject to ordinary concurrent
filesystem mutation. No-go for adversarial path control. Watchbound's current
path-based validation is a conservative correctness mechanism, not a security
boundary.

Do not start an fd-anchored `openat2`/directory-fd redesign for this phase. If a
future consumer needs hostile-root support, stop and review that architecture
before broadening the claim. Never weaken current symlink or identity checks.

## Protected properties

Within the supported threat model, Watchbound protects these contract
properties:

- exact Linux child-path bytes at the native boundary;
- no intentional traversal through directory symlinks;
- watch-before-read discovery ordering;
- explicit root identity and replacement decisions;
- conservative complete, partial, and uncertain coverage;
- bounded watches, traversal, batches, queues, retry timers, and evidence;
- truthful peer subscriptions sharing native watches;
- idempotent disposal joined through native callback completion;
- caller cancellation that cannot leave provisional watches, interests, or a
  runtime lease after rejection; and
- Node-environment generation isolation, bounded callback admission, and
  teardown that does not require JavaScript callbacks to run.

These properties prevent silent overclaims. They do not authenticate a path or
isolate one operating-system user from another.

## Supported actors and mutation

The caller and processes mutating a watched root are trusted to run as the same
user and not to exploit validation races. Ordinary creation, deletion, rename,
replacement, and permission changes may race with scans. The watcher responds
with invalidation, partial coverage, uncertainty, or a structured non-attached
outcome when it cannot prove more.

The root must be on a stable, ordinary local filesystem whose mount and path
ownership are not controlled by an attacker.

## Out-of-scope adversaries

The following are explicit no-go cases:

- a malicious process replacing path components or symlinks between
  `canonicalize`, metadata, traversal, and inotify operations;
- deliberate inode-number reuse intended to impersonate an accepted identity;
- mount, bind-mount, namespace, or filesystem replacement during validation;
- hostile multi-user directories or privilege-boundary monitoring;
- network, FUSE, overlay, or otherwise unusual filesystems whose identity and
  notification behavior have not been qualified;
- treating `(device, inode)` as a cryptographic or permanent identity.

In those cases, path-based checks have unavoidable TOCTOU windows. A caller
must not use a successful subscription or recovery result as authorization to
access the path.

## Audit of the current design

Root setup and recovery retain lexical components for symlink validation,
canonicalize paths, compare metadata identities around watch installation, and
reject directory symlinks. Traversal preserves raw child name bytes. Shared
watch descriptors are generation-tracked and peers retain their own coverage
truth.

Those checks are appropriate for conservative observation under ordinary
mutation, but path re-resolution occurs across separate syscalls. A malicious
actor can change a component, reuse an inode, or replace a mount between those
checks. Inotify watch descriptors are reusable kernel identifiers and must
continue to be paired with engine bookkeeping rather than trusted alone.

Lexical `..` components must continue to be validated before native symlink
decisions; normalizing them away at the JavaScript or Node boundary would
weaken the current contract.

Establishment cancellation is a lifecycle boundary rather than a filesystem
security boundary. A token is single-bind and identified by a checked monotonic
attempt ID; cancellation cleanup uses the worker's existing logical-interest
ownership so it cannot remove a shared peer watch. Raw `napi_env` pointer
values are never stable identities: dispatcher and cleanup registrations
retain a monotonic environment generation, preventing a stale cleanup record
from targeting a later environment that reuses the address. Callback and
command queues remain finite; the dispatcher uses one explicit credit rather
than probing or retrying a full thread-safe-function queue.

## Expansion gate

Supporting adversarial roots would require a separately approved design based
on held directory file descriptors and constrained relative resolution (for
example `openat2` resolve policies), plus an analysis of how inotify watch
installation, recursive discovery, root recovery, mounts, and exact-byte paths
remain anchored. Tests alone cannot convert the existing path API into that
security boundary.
