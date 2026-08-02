# Runtime and root qualification

Watchbound separates package-target compatibility from full host/root
qualification. Loading a native artifact proves only that the loader selected
an artifact it could validate and load. It does not prove kernel or glibc
floors, an ordinary host environment, or a qualified root filesystem.

## Target compatibility

`capabilities.support.currentRuntime` has the explicit scope
`packaged-target-compatibility`. `targetCompatible` is true only when platform,
architecture, libc family, and target triple match the loader-selected artifact
and that target's exact-commit status is `supported`.

This object has no `supported` boolean. It declares
`fullQualification: "qualify-root-required"`; consumers must not reinterpret
`targetCompatible` as a host or root decision. The `runtime` section remains
observed process data rather than a qualification result.

## Full qualification

`qualifyRoot(root)` is synchronous, read-only, and acquires no Watchbound
runtime, inotify descriptor, native watch, or subscription. It returns schema 1
with an aggregate `state` of `qualified`, `unqualified`, or `unknown`, a closed
set of machine-readable `reasons`, and separate `target`, `host`, and `root`
evidence.

The aggregate can be `qualified` only when all of these are true:

1. the packaged target is compatible and its exact-commit status is
   `supported`;
2. the parsed host kernel is at least the target's `kernelMinimum`;
3. the observed glibc runtime is at least the target's published glibc floor;
4. WSL and container markers are not detected and the checks were available;
5. the exact supplied root resolves to a directory; and
6. Linux `statfs` classifies that physical root as an ordinary local ext,
   XFS, or Btrfs filesystem.

Known failures are `unqualified`. Missing or unparsable version data,
unavailable environment evidence, an unavailable root, and an unrecognized
filesystem are `unknown`; they can never become qualified by omission.
Network, FUSE, and overlay filesystem magic values are explicit unqualified
reasons. WSL and container execution are likewise explicit unqualified reasons
even if the kernel, glibc, and filesystem checks would otherwise pass.

The version comparison is numeric by dotted component, so `5.15` accepts
`5.15.0` and later but rejects `5.14.99`; malformed release strings are
unknown. Root resolution follows the filesystem and reports both lexical and
canonical physical bytes. A non-directory candidate is unqualified, while a
resolution/stat failure is unknown because the checker lacks sufficient
evidence.

## Evidence boundary

Environment detection uses the Linux release/version strings, conventional
container marker files, and cgroup/mount information. Absence is meaningful
only when those sources were readable; unavailable sources report unknown.
Filesystem classification is deliberately allowlisted. A new local filesystem
does not inherit qualification because it is neither network nor FUSE; it
remains unknown until its Watchbound behavior is reviewed and the allowlist is
updated with tests.

Qualification is a point-in-time observation, not an authorization boundary or
a promise that a mount cannot later change. The same-user, stable-root threat
model and hostile path/mount exclusions remain in
[`security-threat-model.md`](security-threat-model.md).
