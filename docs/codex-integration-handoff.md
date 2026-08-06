# Codex Desktop Linux handoff

Status: release `2.0.0` is published. The retained native, distro, Electron, Nix,
reproducibility, pinned-kernel, and both supervised-overflow scenarios are green
for x64 and ARM64, and post-publication npm and JSR Node-route smokes passed on
both architectures. A maintainer-reported, locally unpublished Codex Desktop
pilot is running without observed crashes as of 2026-07-30, but has not yet
exercised every integration path deliberately. This repository records the
package boundary; acceptance of the local Codex Desktop integration remains
consumer-owned.

## Package and loader contract

| Architecture | Exact npm package | Native file | Rust target |
| --- | --- | --- | --- |
| x64 | `@gadicc/watchbound-node-linux-x64-gnu` | `watchbound.linux-x64-gnu.node` | `x86_64-unknown-linux-gnu` |
| ARM64 | `@gadicc/watchbound-node-linux-arm64-gnu` | `watchbound.linux-arm64-gnu.node` | `aarch64-unknown-linux-gnu` |
| ARMv7 hard-float | `@gadicc/watchbound-node-linux-arm-gnueabihf` | `watchbound.linux-arm-gnueabihf.node` | `armv7-unknown-linux-gnueabihf` |

All routes also install `watchbound@<version>` and
`@gadicc/watchbound-node@<same-version>`. The loader selects exactly one local
target and verifies package metadata, SHA-256, ELF identity, binding metadata,
versions, Node-API, triple, and release profile. Capability schema 8 retains
`build.packagedTarget`, per-target qualification, and current-runtime matching;
it also declares exclusion feature and option facts.

The ARMv7 row describes the source candidate, not a published artifact. It
requires little-endian ARM version 7, the hard-float EABI, and glibc; all other
32-bit ARM variants fail closed. Capability schema 9 reports those ABI facts.

## Proposed 2.1.0 ARMv7 handoff

After the exact status-bearing revision passes both deterministic cross-builds,
package validation, and the QEMU-user Electron start/callback/dispose lane, the
proposed next release is `2.1.0`. Do not enable or pin the ARMv7 route before
that release exists and its npm/JSR registry smokes pass.

Codex will need these five exact lockstep package records:

| Package | Version after release | Required identity |
| --- | --- | --- |
| `watchbound` | `2.1.0` | registry tarball URL, `dist.integrity`, npm shasum, tarball SHA-256 |
| `@gadicc/watchbound-node` | `2.1.0` | registry tarball URL, `dist.integrity`, npm shasum, tarball SHA-256 |
| `@gadicc/watchbound-node-linux-x64-gnu` | `2.1.0` | package identities plus native path and SHA-256 |
| `@gadicc/watchbound-node-linux-arm64-gnu` | `2.1.0` | package identities plus native path and SHA-256 |
| `@gadicc/watchbound-node-linux-arm-gnueabihf` | `2.1.0` | package identities plus `watchbound.linux-arm-gnueabihf.node` SHA-256 |

Also pin tag `v2.1.0`, the tag's exact source commit, native-matrix schema 1,
capability schema 9, binding API 5, metadata schema 1, Node-API floor 6, and the
ARM target's `armv7-unknown-linux-gnueabihf` triple and ARMv7/hard/little ABI
object. The release commit, npm integrities and shasums, tarball hashes, and
native hashes do not exist yet; copy them from the retained release evidence
and immutable registry responses after publication, never from this local
development build.

The consumer selector should map only its normalized Linux `arm`/`armhf`
runtime with proven ARMv7 hard-float little-endian facts to the new record. It
must retain exact x64 and ARM64 selection, reject musl/soft-float/unknown ARM,
and install only the selected native target with the neutral loader and
wrapper. This Watchbound change does not modify codex-desktop-linux.

## Published 1.2.0 exclusion-API manifest update

Release `1.2.0` adds capability schema 5, raw native capability schema 4,
binding API 4, `excludedDirectoryNames`, and `observedExcludedPaths`. Codex must
adopt only the official immutable release artifacts and must not reuse the
`1.1.0` hashes under the new version. Update the Codex manifest with these exact
four lockstep coordinates:

| Package | Expected version | Archive/binary identity |
| --- | --- | --- |
| `watchbound` | `1.2.0` | npm tarball for `watchbound-1.2.0.tgz` |
| `@gadicc/watchbound-node` | `1.2.0` | npm tarball for `watchbound-node-1.2.0.tgz` |
| `@gadicc/watchbound-node-linux-x64-gnu` | `1.2.0` | target tarball plus `watchbound.linux-x64-gnu.node` |
| `@gadicc/watchbound-node-linux-arm64-gnu` | `1.2.0` | target tarball plus `watchbound.linux-arm64-gnu.node` |

For every package record, copy the official registry tarball URL,
`dist.integrity`, npm SHA-1 shasum, and downloaded tarball SHA-256. For each
target record also copy the generated native-file path and declared/computed
native SHA-256. Pin the release tag and exact source commit, require package
version lockstep, capability schema 5, binding API 4, metadata schema 1,
native-matrix schema 1, and Node-API floor 6. The new integrity, shasum, archive
SHA-256, native SHA-256, tag, and final release-commit values now exist; record
them from release evidence and the registry, never from a local development
build.

## Published 1.1.0 registry coordinates

Release tag `v1.1.0` points to
`9f207599f828ba8a4d5a3f7c1033745cea7e47ff`. The following values were read
from the npm registry and verified against downloaded immutable tarballs:

| Package | npm shasum | Tarball SHA-256 |
| --- | --- | --- |
| `watchbound` | `9b8268b18e463e34ce1cda03702a2af675567c5c` | `4b2c187947323ba6a5d77ef463528f4ab48891cdbe2b92193e825b94cb909b71` |
| `@gadicc/watchbound-node` | `e73b6266cc89bda6089e83bca42f3cdf2b35215c` | `2dcbba9c3492a405cfaf5adc80c89faea53b18a10323a9ea9a2393854732c3e9` |
| `@gadicc/watchbound-node-linux-x64-gnu` | `b8f128447e88b2c0f288f7de1af0076207d4f7e3` | `ab322b0118ef9b3937f3a30c4556e608ddbf75dd8c74334c1cc74f651d50d2d9` |
| `@gadicc/watchbound-node-linux-arm64-gnu` | `ec9b349fc5d282256ae9027841b73846f19e327f` | `7f3f2b9e4cb7138a1565f7bb301b98ec911172a6d0a7c655ac9e6436789866eb` |

The exact tarballs are:

```text
https://registry.npmjs.org/watchbound/-/watchbound-1.1.0.tgz
https://registry.npmjs.org/@gadicc/watchbound-node/-/watchbound-node-1.1.0.tgz
https://registry.npmjs.org/@gadicc/watchbound-node-linux-x64-gnu/-/watchbound-node-linux-x64-gnu-1.1.0.tgz
https://registry.npmjs.org/@gadicc/watchbound-node-linux-arm64-gnu/-/watchbound-node-linux-arm64-gnu-1.1.0.tgz
```

Their registry `dist.integrity` values, in the same order, are:

```text
sha512-PnsFQ/nxZdQtwCy5mdCG8URk8sorOSE6XE2+RjVNPrqAi/UZF3orrgFVlBUuXY1VGGQhYuBWKVOymw3a6ymqcA==
sha512-2fpaPB0RkD8TTmdaqrpFPxgTuydoMchTFmG8m/fFW8khxX9FAA4qNLVXyScXb72O/91zuQIvtw4d8BQ9Fw98dg==
sha512-57RbiAXwt9JkjceHUm07bveSd+U8COpQyof9+dwrgGjUjTNkZqPacK3Z80BQEXdvWFv6ilbpgU1cu4yvkDLpPw==
sha512-f9rvGOjbSO33jiBN8yQHSOJuBuuySH9J7aWCIAFwirEWeS301Skl2pDIFAR2FmO79gUVkLKmjhSChPRgy4ek7w==
```

The x64 package declares and verifies native SHA-256
`a58f01eb09ae8f5c7a2c2a06bf97ea88fd7c5a9371611cc3dff461b7680648d9`;
the ARM64 package declares and verifies
`fc89bb178304c20315b5a74a0e531fbe066c55791288ddcdf4d418e2e6bbd33b`.
Re-read the registry metadata when deliberately adopting a later version; do
not substitute `latest` or synthesize integrity from a local build.

## Codex integration requirements

1. After `2.1.0` is published and verified, keep wrapper, neutral loader, x64,
   ARM64, and ARMv7 hard-float target records in lockstep.
2. Select the target record from Codex's normalized `x64`, `arm64`, or exact
   `arm`/`armhf` Linux target; reject musl and every unproven ARM ABI. Do not
   add a fallback.
3. Keep all five packages at exact version `2.1.0` and pin the official URL,
   npm integrity/shasum, tarball SHA-256, native path, and native SHA-256.
4. Stage the JS packages in `app.asar`, allow the `.node` file to be unpacked
   by the existing `{*.node,*.so,*.dylib}` ASAR rule, and retain the package
   directory relationship expected by Node resolution.
5. Require `capabilities.support.currentRuntime.targetCompatible`, then call
   `qualifyRoot(workspaceRoot)` and require `state === "qualified"`; do not
   infer support from `runtime`, successful load, or legacy fields.
6. Enable x64 only on exact green Ubuntu 22.04/24.04, Debian 12, Fedora 42,
   Arch, openSUSE, Electron, and release-artifact evidence. Enable ARM64 only
   after its applicable native lanes are green. Enable ARMv7 only after the
   exact release's cross-build/package and QEMU-user Electron lifecycle plus
   registry smokes are green. Derivative families remain compatibility claims,
   not separately qualified lanes.
7. Keep soft-float, unknown/big-endian/non-v7 ARM, musl, non-Linux, and
   unqualified families disabled.

For Nix, consume Watchbound's source/lock-based derivation pattern or vendor the
same locked source into the Codex flake; do not fetch npm during a derivation.
Re-enable the feature only after both `x86_64-linux` and `aarch64-linux` checks
run through Codex's actual Electron closure and Codex pins the exact Watchbound
source revision.

## Remaining consumer-side gates

- Kernel 5.15 floor evidence remains deliberately separate from native Ubuntu
  24.04 overflow correctness evidence; both release components are complete.
- Codex must retain exact artifact pins, target selection, ASAR staging, and
  capability-based fail-closed checks in its own repository.
- Codex should exercise its actual Electron startup, repository-preview,
  cancellation, degraded-coverage, callback-pressure, and joined-shutdown
  paths on x64, ARM64, and ARMv7 hard-float before treating the integration as
  production-ready.
- Codex repository changes and production enablement remain consumer-owned;
  Watchbound's registry smokes do not substitute for that acceptance evidence.
