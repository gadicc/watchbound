# Codex Desktop Linux handoff

## Signed-runtime follow-up

The source-candidate loader accepts Node 24.14.0 through the general Node
`>=18.15.0` plus Node-API 6 policy; it no longer equates a tested Node patch
range with ABI compatibility. Watchbound CI exercises the full lifecycle under
stock Node 24.14.0 but intentionally cannot exercise OpenAI's signed Owl
executable. Codex Desktop must retain a consumer-owned test that records
Electron, Node, and Node-API independently, selects the expected immutable
Watchbound target digest, completes initial observation and
create/change/delete delivery, preserves exclusions, joins disposal, and exits
cleanly.

The first signed x64 acceptance bound to candidate `1305e2a` passed all of
those checks across three cold processes. Owl reported Electron
151.0.7922.137, Node 24.14.0, and Node-API 10; its Electron 42.3.0 application
dependency was not its process-reported Electron identity. The exact evidence
and limitations are summarized in
[`codex-signed-runtime-acceptance-2026-08-14.md`](codex-signed-runtime-acceptance-2026-08-14.md).
ARM64 signed-runtime evidence remains unavailable rather than failed.

Release `2.1.1` still requires the separate Owl-safe `process.report` shim.
Directly invoking Owl's native `process.report.getReport()` caused `SIGILL`,
which terminates the process rather than throwing a JavaScript exception. The
current source loader removes that dependency: it obtains bounded libc
evidence from the running ELF interpreter and shares one admitted snapshot
with capabilities. Codex may remove the shim only when it adopts a later exact
lockstep release containing that change and the no-shim signed-Owl lifecycle
passes for the exact release candidate. The old 2.1.1 Node-range rewrite must
also remain removed; these are independent compatibility changes.

Status: release `2.1.1` is published. The retained native, distro, Electron,
Nix, reproducibility, pinned-kernel, and supervised-overflow scenarios are
green for the applicable target matrix. Post-publication npm and JSR Node-route
smokes passed on native x64 and ARM64 and under the pinned ARMv7 QEMU-user
runtime. Signed-runtime acceptance and its raw evidence remain
codex-desktop-linux-owned.

## Package and loader contract

| Architecture | Exact npm package | Native file | Rust target |
| --- | --- | --- | --- |
| x64 | `@gadicc/watchbound-node-linux-x64-gnu` | `watchbound.linux-x64-gnu.node` | `x86_64-unknown-linux-gnu` |
| ARM64 | `@gadicc/watchbound-node-linux-arm64-gnu` | `watchbound.linux-arm64-gnu.node` | `aarch64-unknown-linux-gnu` |
| ARMv7 hard-float | `@gadicc/watchbound-node-linux-arm-gnueabihf` | `watchbound.linux-arm-gnueabihf.node` | `armv7-unknown-linux-gnueabihf` |

All routes also install `watchbound@<version>` and
`@gadicc/watchbound-node@<same-version>`. The loader selects exactly one local
target and verifies package metadata, SHA-256, ELF identity, binding metadata,
versions, Node-API, triple, and release profile. Capability schema 9 retains
`build.packagedTarget`, per-target qualification, and current-runtime matching;
it also declares exclusion feature, option, runtime qualification, and exact
ARM ABI facts.

The ARMv7 row is published in `2.1.1`. It requires little-endian ARM version 7,
the hard-float EABI, and glibc; all other 32-bit ARM variants fail closed. Its
qualification is QEMU-backed rather than native-hardware or performance
evidence.

## Published 2.1.1 ARMv7 handoff

Pin tag `v2.1.1` at source revision
`096c53174ba6ea6a2e2a065f01423deab09c9de4`. Release `2.1.0` first published
ARMv7, but `2.1.1` is the current corrective release and completed every
post-publication route. The exact release record is
[`qualification-evidence-2026-08-09-armv7-release.md`](qualification-evidence-2026-08-09-armv7-release.md).

Codex will need these five exact lockstep package records:

| Package | Version | Release-tarball SHA-256 | Native filename / SHA-256 |
| --- | --- | --- | --- |
| `watchbound` | `2.1.1` | `29567421c1efee041658db4b50093f91558604d352178cb2e76dd331e7c5544d` | Architecture-neutral |
| `@gadicc/watchbound-node` | `2.1.1` | `1f8241d08771f8cf00d50ef8953278934493e7712ae77dcb6418487e167f5284` | Architecture-neutral |
| `@gadicc/watchbound-node-linux-x64-gnu` | `2.1.1` | `0903c9eec6ebe127cb3aae7bce92ddb375c21503ef5438a132c28a19517e44c3` | `watchbound.linux-x64-gnu.node` / `45f40617c86c95e6f023f27891b09805d82e7dc21e295bf886ff5f6a7d541eac` |
| `@gadicc/watchbound-node-linux-arm64-gnu` | `2.1.1` | `a2acdc589d34499b979401b471f73173db33f7b82941f429bfdf4ea287f1e5e3` | `watchbound.linux-arm64-gnu.node` / `9d7208e8fd961af3e26d4cc23403b593b2efdfd686af1ef6a70f462798357fb4` |
| `@gadicc/watchbound-node-linux-arm-gnueabihf` | `2.1.1` | `b651f72ef6869672368fb25cf88a6edee8564aa94d22a80c8c29de77992042b8` | `watchbound.linux-arm-gnueabihf.node` / `ea5a885fa48715e9ebc5bfc82088b307b0bc9ee99b22b60cad6f4b58df558998` |

Also pin native-matrix schema 1, capability schema 9, raw native capability
schema 5, binding API 5, metadata schema 1, Node-API floor 6, and the ARM
target's `armv7-unknown-linux-gnueabihf` triple and ARMv7/hard/little ABI
object. The release-evidence record contains every npm tarball URL,
`dist.integrity`, and shasum; use those immutable values rather than a local
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

1. Pin `2.1.1` and keep wrapper, neutral loader, x64, ARM64, and ARMv7
   hard-float target records in lockstep.
2. Select the target record from Codex's normalized `x64`, `arm64`, or exact
   `arm`/`armhf` Linux target; reject musl and every unproven ARM ABI. Do not
   add a fallback.
3. Keep all five packages at exact version `2.1.1` and pin the official URL,
   npm integrity/shasum, tarball SHA-256, native path, and native SHA-256.
4. Stage the JS packages in `app.asar`, allow the `.node` file to be unpacked
   by the existing `{*.node,*.so,*.dylib}` ASAR rule, and retain the package
   directory relationship expected by Node resolution.
5. Require `capabilities.support.currentRuntime.targetCompatible`, then call
   `qualifyRoot(workspaceRoot)` and require `state === "qualified"`; do not
   infer support from `runtime`, successful load, or legacy fields.
6. Treat the exact `2.1.1` x64, ARM64, and ARMv7 Watchbound release lanes as
   complete. Enable each Codex route only after its own target selection,
   staging, and lifecycle acceptance passes; Watchbound's green release lanes
   do not prove the consumer integration. Derivative families remain
   compatibility claims, not separately qualified lanes.
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
