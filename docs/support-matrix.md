# Narrow support target

Status: the historical private `0.1.0` revision and the implementation baseline
carried by the public `0.0.1` bootstrap have exact-commit clean-CI evidence
recorded below. The immutable bootstrap still reports
`target-pending-clean-ci`. The `1.0.0` async-callback source passed both release
lanes, and the corrected `1.0.1` package is the qualified current release. The
`1.1.0` source candidate adds generation-zero initial exclusions and lowers the
Node 24 floor to 24.15; that wider target is not recognized until both lanes
qualify its exact commit. The registry package bundles only the exact native
target declared by its version; it does not broaden this matrix.

## Qualified and intended target

The target is deliberately narrow:

| Component | Target |
| --- | --- |
| Operating system | Ubuntu 24.04 LTS |
| Kernel | Linux 6.8 or newer within the Ubuntu 24.04 support line |
| C library | glibc 2.39 |
| Architecture | x86_64 only |
| Node.js | `>=24.15.0 <25` |
| Node-API | 6, as an implementation ABI floor rather than a broader support claim |
| Rust | 1.88 or newer for source builds |
| Native toolchain | Ubuntu `build-essential` and a working C linker |
| Package manager | pnpm 10.33.2 |
| TypeScript validation | TypeScript 6.0.3 |

Support for a released version means that a clean controlled source build,
native load, tests, ordinary conformance, TypeScript fixtures, and environment
teardown passed on its exact declared host. The `1.1.0` Node 24.15 floor remains
prospective until that candidate's exact-commit gates pass. Support does not
extend beyond the table.

Historical capability schema version 1 mirrors this table with `supported` for
the qualified `0.1.0` build. Capability schemas 2 and 3 retain the table, with
schema 3 adding callback-completion lifecycle facts; the `1.1.0` candidate
declares `supported` subject to its exact-SHA qualification. The
adjacent `capabilities.runtime`
section reports the platform, architecture, kernel, libc, Node, and Node-API
facts observed in the process that loaded the native binary. Those facts are
diagnostic only: a match does not independently establish or widen support, and
a nonmatch does not broaden the table. Only clean target evidence and a
deliberate document/schema update backed by target-specific clean evidence can
change support status or scope.

The qualified model remains Linux-only. Workspace capabilities describe a
controlled source build. Generated registry packages truthfully describe a
bundled native package for this same single target. No `1.1.0` package may be
published unless its commit passes both lanes. No other
distribution, libc, architecture, Node major, or operating system is implied.

The checked-in CI definition has a floor lane for Node 24.15.0 and Rust 1.88.0
and a moving lane for the latest Node 24 and stable Rust, both on GitHub's x64
Ubuntu 24.04 runner. Each lane asserts the target host, performs the controlled
source build, and runs TypeScript, tests, repository checks, bounded soak/root
recovery stress, and strict ordinary conformance. The floor lane additionally
packs and inspects the proposed npm and JSR payloads, installs the two npm
tarballs offline, exercises real filesystem delivery and callback/disposal
lifecycle behavior, performs a JSR dry run, and emits checksums, release
metadata, and an SBOM. Those ignored local artifacts are not uploaded or
published and do not by themselves qualify a release commit.

## Qualification evidence

The deterministic root-recovery barrier commit
[`243f4e3db736576f3b34fcb716b336a51b70a92f`](https://github.com/gadicc/watchbound/commit/243f4e3db736576f3b34fcb716b336a51b70a92f)
passed both lanes in [CI run 29827608740](https://github.com/gadicc/watchbound/actions/runs/29827608740).
The exact private 0.1.0 freeze
[`9af10f08f01fd15c0d2b39801b00420e65daed3c`](https://github.com/gadicc/watchbound/commit/9af10f08f01fd15c0d2b39801b00420e65daed3c)
then passed both lanes in [CI run 29829260196](https://github.com/gadicc/watchbound/actions/runs/29829260196).

Both freeze jobs passed every step: floor job `88629760074` and moving job
`88629760120`. They ran on Ubuntu 24.04 x86_64, glibc 2.39, Linux
6.17.0-1020-azure, Node 24.18.0, and pnpm 10.33.2. The floor used rustc/cargo
1.88.0; the moving lane used rustc/cargo 1.97.1. Each started from a
source-only checkout, built 0.1.0 locally, compiled the public TypeScript
contracts, passed tests and warnings-denied checks, completed the bounded
25-cycle soak and three-run root-recovery stress, and passed all 13 allowed
strict ordinary conformance scenarios with forced overflow disabled. No
artifact, cache, package, prebuild, or evidence derivative was uploaded.

After the bootstrap was published, exact commit
[`b4200aa6f1d8ebff9a5d7f9010e75643e2a5a632`](https://github.com/gadicc/watchbound/commit/b4200aa6f1d8ebff9a5d7f9010e75643e2a5a632)
passed both lanes in [CI run 30038218924](https://github.com/gadicc/watchbound/actions/runs/30038218924)
(floor job `89311410432`, moving job `89311410443`). That qualifies the
bootstrap implementation baseline, but cannot rewrite the immutable `0.0.1`
capability value. Release run `30103706249` qualified the exact `1.0.0`
async-callback source and independent native artifact. The corrected `1.0.1`
package subsequently passed its release gates and is the current qualified
release. The `1.1.0` source candidate must independently pass the same lanes
before its wider Node-floor `supported` value is recognized.

The exact commit changing the declared status to `supported` is subject to the
same two-lane gate. Landing it is not by itself qualification; maintainer
recognition requires its completed green run. Run and job identifiers are
retained outside that immutable candidate and may be added here later by a
non-release documentation commit, avoiding a self-referential evidence commit.

## Explicitly unsupported

The support claim does not cover:

- Node.js 18, 20, 22, 25, 26, or other versions outside the stated range;
- Linux distributions or glibc versions other than the stated target;
- musl;
- arm64 or any architecture other than x86_64;
- non-Linux operating systems;
- WSL, containers with unusual inotify or mount behavior, network filesystems,
  FUSE, overlay filesystems, or other non-ordinary mounts unless separately
  qualified;
- a bundled native artifact built for any target other than the exact target
  above, cross-compilation, or an install-time compiler fallback;
- hostile or adversarially mutated roots described as out of scope in
  `security-threat-model.md`.

An unsupported target must fail with a stable, actionable diagnostic. A broad
generated napi-rs loader branch or Node-API compatibility must never be
presented as evidence of support.

## Source-build contract

The controlled environment installs the pinned workspace dependencies, builds
the native module from its checked-in Rust source, verifies native/wrapper
contract identity, and then runs the ordinary gate. Runtime installation does
not silently download, select, or fall back to a prebuild.

All three source package manifests remain private at `1.1.0`, declare MIT licensing
and Node `>=24.15.0 <25`, and the wrapper/native manifests declare Linux, x64,
and glibc. The wrapper depends on the native workspace package by its package
name rather than reaching across the repository by relative path.

The hand-owned loader selects only
`watchbound.linux-x64-gnu.node`. It rejects definitive platform, architecture,
libc-family, Node-API, missing-build, load, version, and binding-contract
failures with stable bounded diagnostics. It does not reject every diagnostic
runtime fact outside this table: the package-manager engine range and this
document remain the support authority, while allowing maintainers to diagnose
source builds on newer development hosts. Successful loading on such a host is
not support evidence.

See [`native-delivery.md`](native-delivery.md) for artifact ownership and the
separately gated requirements for any future prebuild proposal.

Future target expansion requires target-specific clean evidence and an update
to this document before package metadata or loader behavior is broadened.
