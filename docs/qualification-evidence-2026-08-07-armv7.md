# ARMv7 qualification evidence — 2026-08-07

This record supports promotion of the exact GNU/Linux ARMv7 hard-float target
from cross-build-only status to the source matrix's `supported` status. It does
not record a publication, tag, GitHub release, native-hardware run, or
performance result.

## Exact source and CI result

- Source revision:
  `1c9b4e33458f20e0aa2a29a4bd29b18901495139`.
- Complete CI run:
  [31166593887](https://github.com/gadicc/watchbound/actions/runs/31166593887),
  conclusion `success`.
- Deterministic cross-build, ELF, package, metadata, loader, and negative ABI
  job:
  [92828757302](https://github.com/gadicc/watchbound/actions/runs/31166593887/job/92828757302),
  conclusion `success`.
- QEMU-user Electron package/load/watch/dispose job:
  [92829079572](https://github.com/gadicc/watchbound/actions/runs/31166593887/job/92829079572),
  conclusion `success`.
- System-QEMU ARMHF kernel-5.15 package/load/watch/dispose job:
  [92829239329](https://github.com/gadicc/watchbound/actions/runs/31166593887/job/92829239329),
  conclusion `success`.

All other jobs in the 24-job CI matrix passed, preserving the existing x64 and
ARM64 behavior and qualification basis.

## Canonical native artifact

| Field | Retained value |
| --- | --- |
| Target id | `linux-arm-gnueabihf` |
| Rust target | `armv7-unknown-linux-gnueabihf` |
| npm package | `@gadicc/watchbound-node-linux-arm-gnueabihf` |
| Filename | `watchbound.linux-arm-gnueabihf.node` |
| Size | 1,293,916 bytes |
| SHA-256 | `9a1af9bbce4a8ecec5aa9bbcef736bb352c13af773dfb1efd361fce3e05de823` |
| ELF identity | ELF32, little-endian, `EM_ARM=40`, EABI5, hard-float ABI |
| ELF flags | `0x5000400` |
| Highest required glibc symbol | `GLIBC_2.34` |

The artifact is below the declared Ubuntu 22.04/glibc 2.35 release ceiling.
The cross-build/package job also verifies two clean builds byte-for-byte, the
target package allowlist and metadata, target triple, dynamic-library allowlist,
loader selection, and fail-closed soft-float, unknown-ABI, musl, and non-Linux
cases.

## QEMU-user Electron lifecycle

The retained `watchbound-electron-asar-qualification` record reports `passed`
for Electron 42.3.0, embedded Node 24.15.0, and Node-API 10. The production
loader selected the exact target package from `app.asar`, loaded the canonical
native SHA above from `app.asar.unpacked`, delivered a real watch callback,
and completed joined disposal.

The lane ran `qemu-arm -cpu cortex-a15` against the digest-pinned Ubuntu 22.04
ARMv7 rootfs and the `20260701T000000Z` Ubuntu snapshot. Retained rootfs
identities are:

- installed-package manifest SHA-256:
  `47140f747830d32928e5880ac65a054423cbf4ed10752e809bf0936ddd1232c7`;
- package database SHA-256:
  `de17a7d70910ccde0bf0d325b1bc023fdccc3e97160531cb48d81b2d4948139e`;
- ASAR SHA-256:
  `5a82f16aa82ddd59f5b754c81e9e5153b5dc8477742e32842c63007df46b4aa6`.

## Kernel-floor lifecycle

The separate system-QEMU lane booted Canonical's ARMHF generic-LPAE kernel and
ran the installed production package lifecycle inside that guest:

- kernel `5.15.0-185-generic-lpae`, SHA-256
  `37c57a9d9e96945889315e2d2dc6f86068e4799e8fd5d6198bf50a4b61d8838d`;
- initrd SHA-256
  `06026ac68eab75c920331793be7d95d5500101c7a74227dfc6f7b5498c3e8994`;
- required initrd module `virtio_blk`;
- glibc 2.35, Node 24.15.0, architecture `arm`;
- installed-package manifest SHA-256
  `95258fcc772f16fe5eada6b3ebd74d75b109557a40593a22d229d6e7076e0134`;
- package database SHA-256
  `89effaab9a35228a47fc2c6864983093032f805476d72993cf2b52c2c8c8e186`.

The guest loaded the canonical native SHA, received a real filesystem event,
joined disposal, and returned inotify descriptors, Watchbound threads, and
native runtime counters to baseline.

## Scope and remaining gate

These two execution lanes qualify the maintained ARMv7 contract defined by
the source matrix: little-endian ARMv7-A, GNU/Linux glibc, hard-float EABI,
kernel 5.15 or newer, and Node `>=24.15.0 <25` with Node-API 6 or newer. Musl,
soft-float, unknown ARM ABI, big-endian ARM, other 32-bit ARM variants, and
non-Linux hosts remain unsupported.

The architecture evidence is emulated ARMv7 execution only; no native ARMv7
hardware runner is available, and timings are non-authoritative. Promotion is
complete only after the follow-up status-bearing revision itself passes the
full CI matrix. Publication remains separately gated and requires explicit
maintainer authorization.
