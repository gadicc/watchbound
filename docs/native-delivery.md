# Native delivery contract

Status: release `2.1.1` publishes the architecture-neutral loader and exact
x64, ARM64, and ARMv7 hard-float GNU/Linux target packages supported by the
checked-in matrix. It retains binding API 5 and advances the public contract to
capability schema 9. Release `2.1.0` first published ARMv7; `2.1.1` is the
current corrective release.

The final ARMv7 artifact passed exact cross-build, packaging, QEMU-user
Electron, system-QEMU kernel-floor, and post-publication npm and JSR Node
lifecycles. Those are real package/load/watch/dispose checks under emulation,
not native-hardware or performance qualification. Exact artifact identities
are in
[`qualification-evidence-2026-08-09-armv7-release.md`](qualification-evidence-2026-08-09-armv7-release.md).

## One matrix, three package roles

`config/native-matrix.json` is the source of truth for the JavaScript Node
floor, native Node-API floor, tested runtime evidence, targets, filenames,
package names, ELF identities, distro lanes, and explicit exclusions.
Generated npm, JSR, CI, release, capability, Electron, and Nix paths consume
that matrix. The separate `buildNode` value pins reproducible build tooling; it
does not narrow runtime support.

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
Node-API floor 6, target triple, release profile, and raw capability schema 5.
The wrapper then verifies the detailed native capability contract and public
capability schema 9.

ELF validation includes the ARM artifact's ELF32 class, little-endian encoding,
`EM_ARM` machine value, and EABI5 hard-float `e_flags`; a soft-float ELF cannot
be relabeled as the armhf package. Generated target metadata repeats the exact
ARM ABI object and is covered by the package manifest and binding SHA.

The JavaScript boundary is Node `>=18.15.0`; the native ABI boundary is process
Node-API 6 or newer. There is no Node upper bound because source and published
ELF inspection found no direct V8, Node C++, or libuv host API dependency.
Tested Node and Electron releases are evidence points, not admission entries.
Stable bounded loader codes and frozen structured details distinguish
unsupported Node/Node-API/platform/architecture/libc/kernel, a missing or
invalid target package, integrity/ELF failures, load failures, and
binding-contract failures. The loader never retries with a nearby artifact.

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
for the native x64/ARM64 target lanes. Its explicit Ubuntu 24.04
`kernelRunner` supplies maintained emulator tooling only; the checksum-pinned
Ubuntu 22.04 rootfs, glibc, kernel, and package smoke remain the evidence.

Builder-side metadata validation follows the same evidence boundary. A native
builder loads the addon through the production loader and verifies its actual
binding metadata. A cross builder cannot execute its addon, so it additionally
requires the expected target and version byte strings as a conservative early
sanity gate after exact ELF validation. Compilers are not required to retain
those strings contiguously, and their presence is not treated as runtime
metadata proof; the exact canonical ARMv7 digest must still pass the mandatory
Electron/QEMU production-loader lane before it contributes qualification.

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
