# Support and qualification matrix

Status: release `1.1.0` publishes the exact x64 and ARM64 GNU/Linux targets
whose statuses are `supported` in the checked-in source matrix. The historical
`1.0.1` release remains limited to its Ubuntu 24.04 x64 contract. The current
`1.2.0` exclusion-API source candidate inherits the same intended target matrix
but is not an exact qualified or published artifact; all passing evidence below
continues to identify the immutable `1.1.0` delivery.

Qualification commit `361562d60e79a6337b0b19cbd3c163ea999ac6b3` completed the native
x64/ARM64 source, reproducibility, distro, Electron, Nix, pinned-kernel 5.15,
and both separately supervised overflow scenarios. Its canonical ELFs require
at most `GLIBC_2.34`; see
[`qualification-evidence-2026-07-26.md`](qualification-evidence-2026-07-26.md).
The tagged release commit is `9f207599f828ba8a4d5a3f7c1033745cea7e47ff`;
post-publication npm and JSR Node-route smokes passed on native x64 and ARM64.

## Published target contract

| Target | Package | Buildable | Release baseline | Qualification |
| --- | --- | --- | --- | --- |
| Linux x64 GNU | `@gadicc/watchbound-node-linux-x64-gnu` | Yes; exact native/release/Electron/Nix/kernel basis passed | Linux kernel 5.15, glibc at most 2.35, Node `>=24.15.0 <25` | Published and supported in `1.1.0` |
| Linux ARM64 GNU | `@gadicc/watchbound-node-linux-arm64-gnu` | Yes; exact native/release/Electron/Nix/kernel basis passed | Linux kernel 5.15, glibc at most 2.35, Node `>=24.15.0 <25` | Published and supported in `1.1.0` |

“Buildable” describes implemented build and packaging paths. It is not a
support claim. `supported` becomes true only when the exact runtime matches a
target whose checked-in status is `supported` and the corresponding
exact-commit evidence is complete.

The oldest candidate distro baseline is Ubuntu 22.04: kernel 5.15 and glibc
2.35. ELF symbol inspection is authoritative for the artifact ABI. Both
independently reproduced candidate artifacts require no symbol newer than
`GLIBC_2.34`.

## Runtime lanes

| Lane | x64 | ARM64 | Evidence meaning |
| --- | --- | --- | --- |
| Ubuntu 22.04 pinned / baseline builder | Passed at `361562d` | Passed at `361562d` | Candidate ABI and oldest distro userspace lane |
| Ubuntu 24.04 pinned | Passed at `361562d` | Passed at `361562d` | Codex advertised Debian-family lane |
| Debian 12 pinned | Passed at `361562d` | Passed at `361562d` | Codex advertised Debian-family lane |
| Fedora 42 pinned | Passed at `361562d` | Passed at `361562d` | Codex advertised RPM lane |
| Arch `base-devel` pinned | Passed at `361562d` | Not in Codex lane | Codex advertised pacman lane |
| openSUSE Tumbleweed pinned | Passed at `361562d` | Passed at `361562d` | Representative current advertised openSUSE RPM lane |
| locked Nix closure | Passed at `361562d` | Passed at `361562d` | Source-built Nix package and exact Electron closure |
| Electron 42.3.0 / Node 24.15.0 ASAR | Passed at `361562d` | Passed at `361562d` | Exact Codex host-runtime boundary |
| Ubuntu 22.04 / kernel 5.15 QEMU component | Passed at `361562d` | Passed at `361562d` | Kernel floor only; native runners separately prove architecture |

The images, official kernel/initrd hashes, and Nix inputs are pinned in
`config/native-matrix.json` and `flake.lock`. A container changes userspace,
not the host kernel. The kernel component therefore boots the real pinned
5.15 kernel under QEMU and labels that result as kernel-floor evidence only;
native x64/ARM64 runners remain mandatory target evidence.

## Advertised, recognized, and qualified are different

Codex publicly advertises Debian/Ubuntu and derivatives, Fedora, openSUSE,
Arch-family systems, Nix, and AppImage delivery. Detection also recognizes
Mint, Pop!_OS, elementary, Zorin, Manjaro, EndeavourOS, Artix, RHEL, CentOS,
Rocky, AlmaLinux, Oracle Linux, SLES/SUSE, and Fedora Atomic variants.

For Watchbound, those secondary names are compatibility families only. A
successful Debian, RPM, or pacman baseline may justify compatibility language
after maintainer review, but recognition never becomes separate qualification
and never creates another binary. WSL, unusual containers, network filesystems,
FUSE, overlay filesystems, and adversarially mutated roots remain outside the
ordinary-host claim unless separately qualified.

## Capability schema 5

The additive schema keeps the schema-4 target and old single-target `support`
fields with
`scope: "legacy-primary-target"`; their Ubuntu 24.04/x64 meaning is not silently
changed. Schema 5 adds only exclusion feature/option facts. New consumers use:

- `build.packagedTarget` for the selected package, binary, triple, and SHA;
- `support.targets[]` for target-specific qualification;
- `support.qualificationLanes[]` for distro/runtime evidence requirements;
- `support.currentRuntime` for the selected target, exact-match result,
  qualification state, and supported boolean;
- `runtime` for observed facts, which never widen support; and
- `support.intentionallyUnsupported[]` for explicit target exclusions.

## Promotion rule

To change either candidate target to `supported`, the exact status-bearing
commit must complete:

1. clean source and semantic suites on x64 and native ARM64;
2. two-builder byte reproduction per registry artifact;
3. every applicable pinned distro lane;
4. exact Electron ASAR lanes on both architectures;
5. locked Nix source closure on both systems;
6. pinned kernel-5.15 package/lifecycle evidence on both architectures;
7. canonical-artifact forced-overflow/reconciliation evidence;
8. package/evidence/provenance gates and maintainer review.

A workflow definition, cross-build, QEMU-only result, local x64 pass, or a later
distribution loading the ELF is insufficient on its own.

The forced-overflow item is correctness-only and can be satisfied by the
guarded Release workflow dispatch on native GitHub-hosted Ubuntu 24.04 x64 and
ARM64 runners. Its timings are non-authoritative; see
[`overflow-runner-strategy.md`](overflow-runner-strategy.md).
