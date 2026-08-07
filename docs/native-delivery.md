# Native delivery contract

Status: release `2.0.0` publishes the architecture-neutral loader and exact x64
and ARM64 GNU/Linux target packages supported by the checked-in source matrix.
It keeps the package roles and binary filenames introduced in `1.1.0` while
advancing the native contract to binding API 5 and capability schema 8. The
historical `1.0.1` release retains its one-target contract.

The current source candidate adds a source-supported ARMv7 hard-float target
package and capability schema 9. Its exact cross-build, packaging, QEMU-user
Electron lifecycle, and system-QEMU kernel-floor lanes passed at implementation
revision `1c9b4e3`; it is not part of release `2.0.0`, has no usable published
artifact, and has no native-hardware or performance qualification claim.

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
| ARMv7 hard-float artifact | `@gadicc/watchbound-node-linux-arm-gnueabihf` | `os=linux`, `cpu=arm`, `libc=glibc`; manifest requires ARMv7, hard-float, little-endian |

Workspace manifests remain private controlled-source packages. A source build
places exactly the current host target beside `node/index.js`. Public package
trees are generated under ignored `dist/` paths and are never the development
source of truth.

There are no `preinstall`, `install`, or `postinstall` scripts. Neither loader
nor wrapper compiles code, downloads an artifact, reads a native-library
override, searches a cache, or falls back to another architecture/libc.

## Exact loader selection

On Linux glibc, the loader maps `process.arch === "x64"`, `"arm64"`, or
`"arm"` to one matrix entry. The `arm` route first accepts exact Node build
variables reporting ARM version 7 and `arm_float_abi === "hard"`. When both
variables are absent, as in the maintained Electron runtime, it instead
requires an `armv7l`, `armv8l`, or compatible `aarch64` Linux machine and reads
only the fixed ELF header of `/proc/self/exe` to prove ELF32, little-endian
`EM_ARM`, EABI5, and the hard-float calling convention. Partial or contradictory
build variables never fall back. ARMv6 machines, soft/softfp executables,
big-endian ARM, or unreadable evidence fail with
`WATCHBOUND_UNSUPPORTED_PLATFORM`. Musl fails independently with
`WATCHBOUND_UNSUPPORTED_LIBC`. The loader then chooses one of two explicit
delivery modes:

1. controlled source build: the one exact local matrix filename beside the
   loader; or
2. generated package: the exact matrix package selected by platform and
   architecture.

The public-package path verifies package name, version, delivery kind, target
identifier, Rust triple, architecture, libc, filename, declared SHA-256, one
regular non-symlink `.node` file, bounded size, computed SHA-256, ELF magic,
class, endianness, and machine before `require()`. After load it verifies
metadata schema 1, binding API 5, wrapper/native/engine version lockstep,
Node-API floor 6, target triple, and release profile.

ELF validation includes the ARM artifact's ELF32 class, little-endian encoding,
`EM_ARM` machine value, and EABI5 hard-float `e_flags`; a soft-float ELF cannot
be relabeled as the armhf package. Generated target metadata repeats the exact
ARM ABI object and is covered by the package manifest and binding SHA.

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

- two clean isolated Ubuntu 22.04/glibc 2.35 builders, native for x64/ARM64 and
  the pinned GNU armhf cross toolchain for ARMv7;
- exact source/version/tool/environment metadata and byte identity;
- SHA-256, ELF class/machine, exact dynamic-library allowlist, no
  RPATH/RUNPATH, and maximum required `GLIBC_* <= 2.35`;
- a stripped release binary with no `.symtab` or debug sections;
- exactly the `napi_register_module_v1` exported Node-API entry point and no
  undefined linked Node-API symbols (napi-rs resolves the host table at
  runtime);
- bounded size, tarball allowlists, offline installation, production loader
  handshake, and resource teardown;
- callback serialization, cancellation, initial and dynamic whole-policy exclusions,
  reconciliation, root recovery, and joined disposal;
- checksum-pinned Ubuntu 22.04 kernel-5.15 execution under bounded QEMU as a
  kernel-floor component; x64/ARM64 combine it with native runner evidence,
  while ARMv7 is explicitly retained as emulated evidence;
- release-only, explicitly acknowledged forced-overflow and automatic
  overflow-reconciliation runs for the canonical target artifact;
- CycloneDX 1.6 SBOM, checksums, release/build metadata, npm/JSR provenance,
  and exact post-publication registry smokes.

Cross-compilation can demonstrate that source compiles. It cannot qualify a
target. ARM64 execution uses a native ARM64 runner. Container distro lanes use
the matching native host. The separate system-QEMU lane proves only that the
exact package semantics run on the pinned 5.15 kernel; it never substitutes
for the native x64/ARM64 target lanes.

ARMv7's initial lane is explicitly different: Ubuntu 22.04 x64 builders use
`arm-linux-gnueabihf-gcc` for `armv7-unknown-linux-gnueabihf`, then the
canonical ELF is loaded by the official Electron 42.3.0 `linux-armv7l` archive
under `qemu-arm -cpu cortex-a15` and a digest-pinned Ubuntu 22.04 armhf rootfs.
The cross-build installs `libc6-dev-armhf-cross` explicitly because the
workflows disable recommended packages; GCC alone does not supply the armhf
startup objects and libc linker metadata.
The rootfs is populated only from the checked-in Ubuntu snapshot timestamp,
and its complete installed-package manifest is hashed into the retained
evidence. Its minimal-image CA bootstrap relies on signed APT metadata, then
clears and re-fetches indexes with normal TLS verification before installing
the closure. The fixture loads the production packages from ASAR and performs
a real watch callback and joined disposal. That emulated execution is the
target's maintained userspace evidence until a native ARMv7 lane is available.
A second lane installs the exact snapshot `5.15.0-185-generic-lpae` image and
modules, verifies the kernel image hash, boots it under `qemu-system-arm`, and
runs the same production package lifecycle with Electron-as-Node. If either
execution lane does not run, the matrix must keep the target pending and
documentation must say only “cross-build supported.”

## 32-bit implementation audit

The ARMv7 review found no pointer-width representation in the filesystem
identity or ordering contracts:

- Linux device and inode identities, root generations, subscription ids,
  sequence numbers, exclusion generations, delivery ids, and cumulative event
  counters remain `u64` through the engine and Node boundary. JavaScript sees
  identity/order fields as `bigint` where required; none are narrowed to
  `usize`.
- Linux inotify watch descriptors and poll timeouts remain kernel-compatible
  `i32`. File descriptors use the platform `RawFd`; they are not stored in an
  unsigned pointer-sized field.
- User-configurable counts are first validated as positive `u32`. Their later
  conversion to `usize` is lossless on the 32-bit target. Exported live-count
  snapshots use an explicit saturating `usize` to `u32` conversion rather than
  truncation.
- Native read lengths and inotify name lengths are converted to `usize` only
  after being bounded by the fixed 64 KiB input buffer and checked against the
  available slice. Batch and queue allocation remain bounded by the existing
  `u32` public maximums.
- Filesystem object sizes are not part of the watch identity or event contract.
  The one delivery size check is the loader's bounded 8 MiB addon file size,
  which is exactly representable on both JavaScript and 32-bit Rust hosts.
- The engine and delivery layer use `AtomicU64` for monotonic ids and counters
  and `AtomicUsize` for live resource counts. Rust reports 8/16/32/64/pointer
  atomic support for `armv7-unknown-linux-gnueabihf`; the cross-compile lane is
  the continuing guard against target regressions.
- Node environment keys are derived from a native pointer as `usize`, which is
  the correct width on ARM32. Fixed napi-rs resource-name lengths are the only
  `usize`-to-`isize` conversions and are bounded static strings.

No Rust or Node-API semantic type change was required. Artifact ELF flags,
loader runtime facts, and the executed lifecycle lane provide the ABI checks
that source-level integer review cannot.

## Nix boundary

`flake.nix` builds the Rust addon from the locked source and Cargo lock inside
Nix for `x86_64-linux` and `aarch64-linux`. It generates the same package
layout without npm access, loads it with Nix Node 24, and packs/runs it with the
exact pinned Nix Electron 42.3.0 closure. The Nix addon is a source-built Nix
output, not the registry ELF: Nix may apply its own interpreter/RPATH closure,
so registry no-RPATH evidence and Nix closure evidence remain separate.
ARMv7 is not added to the Nix outputs by this change.

## Deliberate exclusions

- ARM soft-float, ARM versions other than 7, unknown ARM ABI, and big-endian
  ARM are unsupported. The one ARM route is exact GNU/Linux ARMv7 hard-float.
- musl is unsupported. Codex can embed a musl CLI, but Watchbound runs inside
  the host glibc Electron process.
- non-Linux systems are unsupported because the engine is inotify-specific.

See `support-matrix.md`, `platform-audit.md`, and `releasing.md` for the claim
boundary and promotion gates.
