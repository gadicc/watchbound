# Native delivery contract

Status: the multi-target work is an unpublished source candidate. The current
qualified registry release remains `1.0.1` with its historical one-target
contract. The candidate's exact x64 and ARM64 GNU/Linux targets are supported
by the checked-in source matrix; that does not claim official registry
availability before an approved publication.

## One matrix, three package roles

`config/native-matrix.json` is the source of truth for runtime versions,
targets, filenames, package names, ELF identities, distro lanes, and explicit
exclusions. Generated npm, JSR, CI, release, capability, Electron, and Nix
paths consume that matrix.

The generated public boundary is:

| Role | Package | Architecture metadata |
| --- | --- | --- |
| ESM wrapper | `watchbound` / JSR `@gadicc/watchbound` | Linux, architecture-neutral |
| CommonJS loader | `@gadicc/watchbound-node` | Linux, architecture-neutral; optional exact target packages |
| x64 artifact | `@gadicc/watchbound-node-linux-x64-gnu` | `os=linux`, `cpu=x64`, `libc=glibc` |
| ARM64 artifact | `@gadicc/watchbound-node-linux-arm64-gnu` | `os=linux`, `cpu=arm64`, `libc=glibc` |

Workspace manifests remain private controlled-source packages. A source build
places exactly the current host target beside `node/index.js`. Public package
trees are generated under ignored `dist/` paths and are never the development
source of truth.

There are no `preinstall`, `install`, or `postinstall` scripts. Neither loader
nor wrapper compiles code, downloads an artifact, reads a native-library
override, searches a cache, or falls back to another architecture/libc.

## Exact loader selection

On Linux glibc, the loader maps only `process.arch === "x64"` or `"arm64"` to
one matrix entry. It then chooses one of two explicit delivery modes:

1. controlled source build: the one exact local matrix filename beside the
   loader; or
2. generated package: the exact matrix package selected by platform and
   architecture.

The public-package path verifies package name, version, delivery kind, target
identifier, Rust triple, architecture, libc, filename, declared SHA-256, one
regular non-symlink `.node` file, bounded size, computed SHA-256, ELF magic,
class, endianness, and machine before `require()`. After load it verifies
metadata schema 1, binding API 3, wrapper/native/engine version lockstep,
Node-API floor 6, target triple, and release profile.

Node is restricted to `>=24.15.0 <25`. The Codex boundary is Electron 42.3.0,
embedded Node 24.15.0, and Node-API 10. Stable bounded loader codes distinguish
unsupported Node/platform/architecture/libc, a missing or invalid target
package, integrity/ELF failures, load failures, and binding-contract failures.
The loader never retries with a nearby artifact.

Electron qualification packs the wrapper and loader inside `app.asar` with the
native file materialized by Electron under `app.asar.unpacked`. The fixture
must load through the production package resolver and deliver a real callback.

## Artifact controls

For each registry native artifact, release qualification requires:

- two clean isolated native builders on the target architecture and Ubuntu
  22.04/glibc 2.35 baseline;
- exact source/version/tool/environment metadata and byte identity;
- SHA-256, ELF class/machine, exact dynamic-library allowlist, no
  RPATH/RUNPATH, and maximum required `GLIBC_* <= 2.35`;
- a stripped release binary with no `.symtab` or debug sections;
- exactly the `napi_register_module_v1` exported Node-API entry point and no
  undefined linked Node-API symbols (napi-rs resolves the host table at
  runtime);
- bounded size, tarball allowlists, offline installation, production loader
  handshake, and resource teardown;
- callback serialization, cancellation, initial and dynamic exclusions,
  reconciliation, root recovery, and joined disposal;
- checksum-pinned Ubuntu 22.04 kernel-5.15 execution under bounded QEMU as a
  kernel-floor component, combined with separate native architecture evidence;
- release-only, explicitly acknowledged forced-overflow and automatic
  overflow-reconciliation runs for the canonical target artifact;
- CycloneDX 1.6 SBOM, checksums, release/build metadata, npm/JSR provenance,
  and exact post-publication registry smokes.

Cross-compilation can demonstrate that source compiles. It cannot qualify a
target. ARM64 execution uses a native ARM64 runner. Container distro lanes use
the matching native host. The separate QEMU lane proves only that the exact
package semantics run on the pinned 5.15 kernel; it never substitutes for the
native target lanes.

## Nix boundary

`flake.nix` builds the Rust addon from the locked source and Cargo lock inside
Nix for `x86_64-linux` and `aarch64-linux`. It generates the same package
layout without npm access, loads it with Nix Node 24, and packs/runs it with the
exact pinned Nix Electron 42.3.0 closure. The Nix addon is a source-built Nix
output, not the registry ELF: Nix may apply its own interpreter/RPATH closure,
so registry no-RPATH evidence and Nix closure evidence remain separate.

## Deliberate exclusions

- ARMv7 is unsupported. Codex contains partial mappings, but its Electron,
  pacman, native-addon, release, and native-runtime paths do not form a complete
  qualified target.
- musl is unsupported. Codex can embed a musl CLI, but Watchbound runs inside
  the host glibc Electron process.
- non-Linux systems are unsupported because the engine is inotify-specific.

See `support-matrix.md`, `platform-audit.md`, and `releasing.md` for the claim
boundary and promotion gates.
