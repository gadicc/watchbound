# Initial maintained source-build target

Status: approved target on 2026-07-21; implementation and clean-CI validation
are required before the repository may claim that the target passes.

## Supported target

The initial maintained-unpublished target is deliberately narrow:

| Component | Target |
| --- | --- |
| Operating system | Ubuntu 24.04 LTS |
| Kernel | Linux 6.8 or newer within the Ubuntu 24.04 support line |
| C library | glibc 2.39 |
| Architecture | x86_64 only |
| Node.js | `>=24.18.0 <25` |
| Node-API | 6, as an implementation ABI floor rather than a broader support claim |
| Rust | 1.88 or newer for source builds |
| Native toolchain | Ubuntu `build-essential` and a working C linker |
| Package manager | pnpm 10.33.2 |
| TypeScript validation | TypeScript 6.0.3 |

Support means that a clean controlled source build, native load, tests,
ordinary conformance, TypeScript fixtures, and environment teardown have
passed on this exact class of host. Until clean CI records that evidence, the
table is a target rather than a completed claim.

The package remains Linux-only and source-built. No prebuilt native artifact
is produced or distributed in this phase.

## Explicitly unsupported

The maintained-unpublished claim does not cover:

- Node.js 18, 20, 22, 25, 26, or other versions outside the stated range;
- Linux distributions or glibc versions other than the stated target;
- musl;
- arm64 or any architecture other than x86_64;
- non-Linux operating systems;
- WSL, containers with unusual inotify or mount behavior, network filesystems,
  FUSE, overlay filesystems, or other non-ordinary mounts unless separately
  qualified;
- prebuilt installation, cross-compilation, or an install-time compiler
  fallback;
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

Future target expansion requires target-specific clean evidence and an update
to this document before package metadata or loader behavior is broadened.
