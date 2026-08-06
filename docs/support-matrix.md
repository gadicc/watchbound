# Support and qualification matrix

Status: release `2.0.0` publishes the exact x64 and ARM64 GNU/Linux targets
whose statuses are `supported` in the checked-in source matrix. The historical
`1.0.1` release remains limited to its Ubuntu 24.04 x64 contract, and `1.1.0`
was the first published multi-target release.

The current source candidate adds GNU/Linux ARMv7 hard-float delivery under
target id `linux-arm-gnueabihf`. Its status is deliberately
`target-pending-clean-ci`: cross-build, package, loader, QEMU-user runtime, and
system-QEMU kernel-floor jobs are defined, but no exact-revision ARMv7
execution result exists yet.
Until that job passes and a status-bearing follow-up revision is itself green,
the target is buildable but not qualified or published.

Source commit `4dbb0dc1c445de1d00e09d66f252d3d51f713cf2` completed both guarded
release-qualification scenarios. The
[manual overflow run](https://github.com/gadicc/watchbound/actions/runs/30739684199)
and [automatic overflow run](https://github.com/gadicc/watchbound/actions/runs/30743730772)
each passed after a GitHub failed-job rerun. The supervisor's fail-closed review
passed all 25 checks for each run: original failures were limited to
target-specific pinned-kernel QEMU timeouts, rerun jobs passed, and the retained
x64 and ARM64 canonical-artifact evidence was internally consistent. The
maintainer explicitly accepted those infrastructure/environmental conditional
passes, and the subsequent release and post-publication registry smokes passed.

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
| Linux x64 GNU | `@gadicc/watchbound-node-linux-x64-gnu` | Yes; exact native/release/Electron/Nix/kernel basis passed | Linux kernel 5.15, glibc at most 2.35, Node `>=24.15.0 <25` | Published and supported in `2.0.0` |
| Linux ARM64 GNU | `@gadicc/watchbound-node-linux-arm64-gnu` | Yes; exact native/release/Electron/Nix/kernel basis passed | Linux kernel 5.15, glibc at most 2.35, Node `>=24.15.0 <25` | Published and supported in `2.0.0` |

## Source-candidate ARMv7 contract

| Target | Package | Build contract | Runtime contract | Qualification |
| --- | --- | --- | --- | --- |
| Linux ARMv7 GNU hard-float | `@gadicc/watchbound-node-linux-arm-gnueabihf` | `armv7-unknown-linux-gnueabihf`; ELF32, little-endian, `EM_ARM=40`, EABI5 hard-float flags; Ubuntu 22.04 cross toolchain | ARMv7-A hard-float little-endian glibc, kernel 5.15+, Electron 42.3.0 / embedded Node 24.15.0 or a compatible consumer-managed Node 24 build | Cross-build implemented; exact QEMU-user Electron and system-QEMU 5.15 package/load/watch/dispose evidence pending |

The glibc release ceiling remains 2.35, and artifact inspection must prove the
actual maximum `GLIBC_*` symbol no newer than that ceiling. ARMv7 uses the same
kernel floor as the published targets. Its dedicated system-QEMU component
boots Canonical's snapshot-pinned `5.15.0-185-generic-lpae` kernel and initrd,
then runs the production package lifecycle with Electron-as-Node. Its separate
QEMU-user lane constructs an
isolated Ubuntu 22.04 armhf rootfs from the digest-pinned official OCI image,
rewrites APT to the checked-in Ubuntu snapshot timestamp, records the complete
installed-package manifest, and executes the official Electron ARMv7 archive
on the host kernel. The GNU cross compiler's sysroot is build-only and is never
used as runtime qualification evidence. The minimal OCI image initially lacks
a CA bundle, so the lane bootstraps only `ca-certificates` from signed snapshot
metadata, clears the indexes, and then re-fetches them with ordinary TLS peer
verification before installing the runtime closure.

Node's official 24.15.0 download set has no Linux ARMv7 archive. This does not
change Watchbound's Node version contract: an ARMv7 Node host must still be
`>=24.15.0 <25`, Node-API 6 or newer, ARM version 7, hard-float, and
little-endian. The maintained execution lane therefore uses Electron's
official `linux-armv7l` build. A Node version match without those ABI facts is
not accepted.

“Buildable” describes implemented build and packaging paths. It is not a
support claim. `supported` becomes true only when the exact runtime matches a
target whose checked-in status is `supported` and the corresponding
exact-commit evidence is complete.

The oldest supported distro baseline is Ubuntu 22.04: kernel 5.15 and glibc
2.35. ELF symbol inspection is authoritative for the artifact ABI. Both
independently reproduced release artifacts require no symbol newer than
`GLIBC_2.34`.

## Runtime lanes

| Lane | x64 | ARM64 | ARMv7 hard-float | Evidence meaning |
| --- | --- | --- | --- | --- |
| Ubuntu 22.04 pinned / baseline builder | Passed at `4dbb0dc` | Passed at `4dbb0dc` | Cross-build defined; pending exact CI | Release ABI and oldest distro userspace lane |
| Ubuntu 24.04 pinned | Passed at `4dbb0dc` | Passed at `4dbb0dc` | Not configured | Codex advertised Debian-family lane |
| Debian 12 pinned | Passed at `4dbb0dc` | Passed at `4dbb0dc` | Not configured | Codex advertised Debian-family lane |
| Fedora 42 pinned | Passed at `4dbb0dc` | Passed at `4dbb0dc` | Not configured | Codex advertised RPM lane |
| Arch `base-devel` pinned | Passed at `4dbb0dc` | Not in Codex lane | Not configured | Codex advertised pacman lane |
| openSUSE Tumbleweed pinned | Passed at `4dbb0dc` | Passed at `4dbb0dc` | Not configured | Representative current advertised openSUSE RPM lane |
| locked Nix closure | Passed at `4dbb0dc` | Passed at `4dbb0dc` | Not configured | Source-built Nix package and exact Electron closure |
| Electron 42.3.0 / Node 24.15.0 ASAR | Passed at `4dbb0dc` | Passed at `4dbb0dc` | QEMU-user lane defined; pending exact CI | Exact Codex host-runtime boundary |
| Ubuntu 22.04 / kernel 5.15 QEMU component | Passed at `4dbb0dc` | Passed at `4dbb0dc` | ARMv7 system-QEMU lane defined; pending exact CI | Real kernel floor; ARMv7 remains emulated and has no native runner evidence |

The images, official kernel/initrd hashes, and Nix inputs are pinned in
`config/native-matrix.json` and `flake.lock`. A container changes userspace,
not the host kernel. The kernel component therefore boots the real pinned
5.15 kernel under QEMU and labels that result as kernel-floor evidence only;
native x64/ARM64 runners remain mandatory target evidence. ARMv7 boots the
exact generic-LPAE kernel under `qemu-system-arm`; that is real kernel/runtime
execution but still emulated target evidence, not a claim of native ARMv7 CI.

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

## Capability schema 9

The additive schema keeps the schema-4 target and old single-target `support`
fields with
`scope: "legacy-primary-target"`; their Ubuntu 24.04/x64 meaning is not silently
changed. Schema 5 added exclusion feature/option facts, schema 6 added explicit
physical-root resolution, schema 7 separated packaged-target compatibility
from enforceable host/root qualification, schema 8 added explicit bytes-only
physical invalidations, and schema 9 adds exact ARM ABI facts to the packaged
target, runtime, and support entries. New consumers use:

- `build.packagedTarget` for the selected package, binary, triple, and SHA;
- `support.targets[]` for target-specific qualification;
- `support.qualificationLanes[]` for distro/runtime evidence requirements;
- `support.currentRuntime` only for selected packaged-target compatibility;
- `qualifyRoot(root)` for kernel/glibc floors, WSL/container evidence, root
  filesystem classification, and a conservative full qualification state;
- `runtime` for observed facts, which never widen support; and
- `support.intentionallyUnsupported[]` for explicit target exclusions.

The full machine-readable contract is in
[`runtime-qualification.md`](runtime-qualification.md). An environment with
recognized container evidence cannot qualify. Network, FUSE, overlay, WSL,
below-floor, and unknown states never return `qualified`.

## Promotion rule

Promotion of any target to `supported` requires the exact status-bearing
commit to complete its applicable lanes. For x64 and ARM64 this means:

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

ARMv7 has a deliberately narrower initial maintenance basis because no native
GitHub-hosted ARMv7 runner is available: two deterministic Ubuntu 22.04
cross-builds must byte-match, the generated npm package must pass its exact
allowlist and metadata checks, and the canonical artifact must execute the
production loader plus a real start/callback/dispose lifecycle under pinned
Electron 42.3.0 through `qemu-arm` in the snapshot-locked armhf rootfs.
The same package must also pass its start/callback/dispose lifecycle under the
snapshot-pinned ARMHF 5.15 generic-LPAE kernel in `qemu-system-arm`.
Publication and registry verification are gated on both lanes. If either is
unavailable or red, the target remains `target-pending-clean-ci`;
cross-compilation alone never promotes it.

The forced-overflow item is correctness-only and can be satisfied by the
guarded Release workflow dispatch on native GitHub-hosted Ubuntu 24.04 x64 and
ARM64 runners. Its timings are non-authoritative; see
[`overflow-runner-strategy.md`](overflow-runner-strategy.md).
