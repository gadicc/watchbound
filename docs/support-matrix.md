# Support and qualification matrix

Status: the `1.2.0` multi-target work is an unpublished candidate. Its target
status is `target-pending-clean-ci`. The current qualified registry release is
still `1.0.1` under its historical Ubuntu 24.04 x64 contract.

## Candidate target contract

| Target | Package | Buildable | Candidate baseline | Qualification |
| --- | --- | --- | --- | --- |
| Linux x64 GNU | `@gadicc/watchbound-node-linux-x64-gnu` | Yes; local source build and exact Codex Electron ASAR smoke passed | Linux kernel 5.15, glibc at most 2.35, Node `>=24.15.0 <25` | Pending exact clean CI/release matrix |
| Linux ARM64 GNU | `@gadicc/watchbound-node-linux-arm64-gnu` | Yes; native runner, package, loader, release, Electron, and Nix paths are defined | Linux kernel 5.15, glibc at most 2.35, Node `>=24.15.0 <25` | Pending native ARM64 evidence |

“Buildable” describes implemented build and packaging paths. It is not a
support claim. `supported` becomes true only when the exact runtime matches a
target whose checked-in status is `supported` and the corresponding
exact-commit evidence is complete.

The oldest candidate distro baseline is Ubuntu 22.04: kernel 5.15 and glibc
2.35. ELF symbol inspection is authoritative for the artifact ABI. The local
x64 development artifact currently requires no symbol newer than
`GLIBC_2.34`; it was not built on the clean baseline and is not ARM64 or
release qualification.

## Runtime lanes

| Lane | x64 | ARM64 | Meaning before green exact evidence |
| --- | --- | --- | --- |
| Ubuntu 22.04 pinned / baseline builder | Pending | Pending | Candidate ABI and oldest distro lane |
| Ubuntu 24.04 pinned | Pending | Pending | Codex advertised Debian-family lane |
| Debian 12 pinned | Pending | Pending | Codex advertised Debian-family lane |
| Fedora 42 pinned | Pending | Pending | Codex advertised RPM lane |
| Arch `base-devel` pinned | Pending | Not in Codex lane | Codex advertised pacman lane |
| openSUSE Tumbleweed pinned | Pending | Pending | Representative current advertised openSUSE RPM lane |
| locked Nix closure | Pending | Pending | Source-built Nix package and exact Electron closure |
| Electron 42.3.0 / Node 24.15.0 ASAR | Local pass, CI pending | Pending | Exact Codex host-runtime boundary |

The images and Nix inputs are pinned in `config/native-matrix.json` and
`flake.lock`. A container changes userspace, not the host kernel, so kernel 5.15
support still requires genuine kernel evidence; an image label alone cannot
establish it.

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

## Capability schema 4

The additive schema keeps the old single-target `support` fields with
`scope: "legacy-primary-target"`; their Ubuntu 24.04/x64 meaning is not silently
changed. New consumers use:

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
6. canonical-artifact forced-overflow/reconciliation evidence;
7. package/evidence/provenance gates and maintainer review.

A workflow definition, cross-build, QEMU-only result, local x64 pass, or a later
distribution loading the ELF is insufficient on its own.

The forced-overflow item is correctness-only and can be satisfied by the
guarded Release workflow dispatch on native GitHub-hosted Ubuntu 24.04 x64 and
ARM64 runners. Its timings are non-authoritative; see
[`overflow-runner-strategy.md`](overflow-runner-strategy.md).
