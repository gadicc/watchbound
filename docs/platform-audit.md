# Codex Desktop Linux platform audit

## 2026-08-14 runtime-policy addendum

Codex Desktop's signed Owl executable reports `process.versions.electron` as
151.0.7922.137, `process.versions.node` as 24.14.0, and
`process.versions.napi` as 10. Electron 42.3.0 remains an application package
dependency, but it is not the signed Owl process's reported Electron identity.
Watchbound does not include that proprietary executable in CI and does not
infer Node from either Electron value. Source and published artifact inspection
found no Node 24.15-only dependency: the checked-in source policy now requires
Node `>=18.15.0` and process Node-API 6 or newer, with no Node upper bound,
while preserving the platform, architecture, ARM ABI, glibc, kernel, ELF,
digest, metadata, and capability gates. A full stock-Node 24.14.0 lifecycle is
the repository regression; Codex retains the signed-runtime integration test.

Candidate commit `1305e2af15853749d12fe06ef9cb370e3bd18800`
subsequently passed three cold signed-Owl x64 lifecycles. That consumer route
required its Owl-safe `process.report` shim before importing Watchbound:
calling Owl's native `process.report.getReport()` directly caused `SIGILL`,
which JavaScript cannot catch. The shim is distinct from, and does not restore,
the removed Node-range workaround. See the
[signed-runtime acceptance record](codex-signed-runtime-acceptance-2026-08-14.md).
The later source loader is report-free, but that source change does not retire
the consumer shim until an exact released candidate passes the same signed-Owl
suite without it.

Audit date: 2026-07-26. Watchbound started at
`df61736cf325b522f24320f8ecc2064dc9ff8781`. The sibling Codex checkout was
read-only at tracked commit `ef284ae8dc07917c42b2e6b6435e4820280df989` on
`codex/integrate-watchbound`; it had user-owned integration changes, which were
not mutated and were not used to broaden Codex's tracked platform claims.

The audit read the Codex README, build/native/Nix documents, target detection,
dependency install, Node runtime, native module, deb/rpm/pacman/AppImage build
scripts, flake, and CI workflows named in the task.

## Evidence layers

| Platform area | Publicly advertised | Detection recognizes | Build code | Codex CI observed | Watchbound conclusion |
| --- | --- | --- | --- | --- | --- |
| x86_64 Linux | Yes | Yes | deb, rpm, pacman, AppImage, Nix, native modules | Broad x64 lanes | Primary candidate |
| aarch64 Linux | Yes through architecture-aware packaging/Nix paths | Yes | deb, rpm, AppImage, Nix, Node/Electron native modules | Less broad than x64; Nix declares ARM64 | Primary candidate, native evidence required |
| armv7l/armhf | Not a complete end-to-end public matrix | Partial | deb/rpm/AppImage and some runtime mappings | No complete Electron/pacman/native release matrix | Intentionally unsupported |
| Ubuntu 22.04 / 24.04 | Yes as Debian family | apt | deb/AppImage | Pinned install/build lanes | Both candidate lanes |
| Debian 12 | Yes | apt | deb/AppImage | Pinned install lane | Candidate lane |
| Fedora 42 | Yes | dnf/rpm | rpm/AppImage | Pinned build lane | Candidate lane |
| Arch | Yes | pacman | pacman/AppImage | Pinned `base-devel` x64 lane | x64 candidate lane |
| openSUSE | Yes | zypper/rpm | rpm/AppImage family | No equivalent dedicated tracked lane found | Added pinned representative lane; pending evidence |
| NixOS/Nix | Yes | Nix | locked flake for x64/ARM64 | x64-heavy tracked CI; flake declares both | First-class source closure for both, pending execution |

Codex detection recognizes Debian derivatives `linuxmint`, `pop`,
`elementary`, and `zorin`; pacman derivatives `manjaro`, `endeavouros`, and
`artix`; RPM families `rhel`, `centos`, `rocky`, `almalinux`, `ol`, `sles`, and
`suse`; and Fedora Atomic variants. These are detection/compatibility facts,
not Watchbound qualification lanes.

## 2026-07-26 runtime conclusions (historical)

- The legacy stock-Electron Codex binary inspected on that date reported
  Electron 42.3.0, Node 24.15.0, and Node-API 10. It was not the later signed
  Owl executable described by the addendum above.
- Codex's x64 and ARM64 Electron archive pins were carried into the Watchbound
  matrix. At that audit point Watchbound kept Node `>=24.15.0 <25`; the
  2026-08-14 addendum above supersedes that runtime admission policy.
- Ubuntu 22.04 supplies the candidate kernel 5.15/glibc 2.35 baseline. Released
  ELFs must independently prove their maximum `GLIBC_*` requirement.
- Codex's musl CLI is not evidence that its Electron host runs on musl; no musl
  Watchbound target was added.
- A single architecture mapping was never treated as end-to-end support.

## Design decision

One GNU/Linux artifact per Node architecture is sufficient for the named
distro families when built against the old glibc baseline and qualified in
their userspaces. The wrapper and loader remain architecture-neutral. Nix
builds from source inside the Nix closure instead of repackaging the registry
ELF, keeping Nix pure and avoiding npm access.

## 2026-08-06 ARMv7 follow-up

The current task supplied additional consumer evidence that
codex-desktop-linux carries ARMv7/armhf through its Debian, RPM, AppImage,
Electron, managed-Node, and dependency setup paths. Watchbound therefore adds
one exact GNU/Linux ARMv7 hard-float target rather than treating all
`process.arch === "arm"` runtimes as compatible.

The new source path cross-compiles `armv7-unknown-linux-gnueabihf`, packages
`@gadicc/watchbound-node-linux-arm-gnueabihf`, and executes the official
Electron 42.3.0 `linux-armv7l` archive through QEMU-user. This supplements but
does not rewrite the historical 2026-07-26 audit table. Both that userspace
lifecycle and the snapshot-pinned 5.15 generic-LPAE system-QEMU lifecycle
passed at implementation revision `1c9b4e3`, so the exact source target is now
supported. Release `2.1.0` first published the binding, and corrective release
`2.1.1` passed both immutable npm and JSR Node registry lifecycles. The
qualification basis remains emulated-only; musl, soft-float, unknown ARM ABI,
big-endian ARM, and non-v7 ARM remain unsupported. No codex-desktop-linux files
are changed here.
