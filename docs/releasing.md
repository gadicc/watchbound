# Release and registry runbook

Status: `2.1.2` is the current published release and the explicitly selected
qualified native stack. `1.1.0` remains the historical first multi-target
release, and `2.1.0` first published ARMv7. Semantic-release selected and
materialized each version while the checked-in source remained at
`0.0.0-development`. This runbook continues to govern future releases; the
repository configuration is not blanket permission to publish.

Release `2.1.2` carries public capability schema 9, raw native capability
schema 5, and binding API 5. Future checked-in package, Cargo, and lockfile
placeholders must still remain at `0.0.0-development`.

For the next patch candidate, release qualification also consumes the
matrix-generated Node and Electron compatibility lanes. Each architecture's
source-build artifact is retained once and reused byte-for-byte across its Node
versions; Node 18.15.0, 24.14.0, and 26.7.0 run the full installed lifecycle,
while current patches of the other supported even-major lines run admission.
x64 Electron 28.0.0 and 43.2.0 reuse that same x64 addon and assert Electron,
embedded Node, and Node-API independently. These lanes do not replace the
separate distro, glibc, kernel, ARM ABI, Nix, overflow, or registry gates.

## ARMv7 2.1.x release record

1. Implementation revision `1c9b4e3` completed the 24-job CI matrix, including
   deterministic ARMHF cross-build/package, incompatible ARM/libc negatives,
   QEMU-user Electron lifecycle, and the separately retained and pinned
   system-QEMU 5.15 lifecycle artifacts. The reviewed identities are recorded
   in `qualification-evidence-2026-08-07-armv7.md`.
2. The follow-up status-bearing revision changed the ARM target from
   `target-pending-clean-ci` to `supported` and passed the complete CI matrix.
3. Completed 2026-08-07 with separate explicit authorization: the new scoped
   npm name contains only deprecated inert `0.0.0-bootstrap.0`, and its trusted
   publisher is repository `gadicc/watchbound`, workflow `release.yml`. This was
   not a Watchbound release and contains no usable binding.
4. Release `2.1.0` first published the ARMv7 route. Corrective release `2.1.1`
   hardened installed-target discovery and runtime container evidence without
   widening the support contract.
5. Exact revision `096c53174ba6ea6a2e2a065f01423deab09c9de4` passed every
   prepublication gate and all six target-by-registry post-publication routes,
   including ARMv7 npm and JSR Node under QEMU-user, in
   [release run 31325826358](https://github.com/gadicc/watchbound/actions/runs/31325826358).
6. The final tag, package and native hashes, schemas, and retained job URLs are
   recorded in
   [`qualification-evidence-2026-08-09-armv7-release.md`](qualification-evidence-2026-08-09-armv7-release.md).
   That record's consumer recommendation remains historical.
7. Release `2.1.2` at source
   `fa188992ef2cc800f9e65b9395139f85ef945c45` passed Release run
   [32010819262](https://github.com/gadicc/watchbound/actions/runs/32010819262).
   Its full retained and registry identity is the initial explicit selection
   in `config/qualified-native-stack.json`. Consumer changes remain outside
   this repository.

## Release units and selected native baseline

The release planner has three exhaustive outcomes:

| Change class | Registry result | Required gates |
| --- | --- | --- |
| documentation or checked-in skill only | none | ordinary CI |
| wrapper-only `js/**` change | npm `watchbound` and JSR `@gadicc/watchbound` | wrapper/package tests, JSR dry run, and installed npm/JSR smoke against the selected published native stack |
| native or uncertain | every target, `@gadicc/watchbound-node`, npm `watchbound`, and JSR `@gadicc/watchbound` | the complete native qualification and post-publication pipeline in this runbook |

The allowlist is intentionally narrow. Release tooling, workflow, matrix,
engine, binding, loader, packaging, or otherwise unclassified changes select
the native path. `config/qualified-native-stack.json` is a non-publishing
selection change and may accompany a wrapper change. It is never inferred
from npm's `latest` tag or from version ordering.

That descriptor is the durable source of truth for a wrapper-only release. It
names one exact loader/native version, source SHA and tag, successful Release
workflow run and terminal verification job, retained release-metadata,
independent-reproducibility and publication-ledger URLs plus SHA-256 digests,
the pinned build identity, each npm integrity and tarball SHA-256, and each
native binary SHA-256.
`node scripts/verify-qualified-native-stack.mjs` checks the descriptor against
the retained GitHub evidence, immutable tag, successful workflow/job, npm
provenance, downloaded registry tarballs, loader target pins, target delivery
metadata, and native digests.
Ordinary CI and every wrapper prepare/publish preflight run that verifier.

To select a newer native baseline, first complete and registry-verify a full
native release. Then update the descriptor from that release's retained
artifacts and immutable registry records in a reviewed, non-release change.
The descriptor must pass its online verifier before a later wrapper release can
consume it. A wrapper release does not copy or relabel the old native evidence;
its metadata records the descriptor digest and refers to the original native
version, source and evidence.

The generated package identities are therefore independent where safe:

```text
watchbound@WRAPPER_VERSION
  -> @gadicc/watchbound-node@NATIVE_STACK_VERSION
     -> every target package @NATIVE_STACK_VERSION
```

All arrows are exact versions. On a native/full release both identities equal
semantic-release's new version. On a wrapper-only release only the root and
`js/package.json` candidates are materialized to the new wrapper version; the
loader/Cargo/lock sources retain `0.0.0-development`, and the generated wrapper
exact-pins the selected, already-published native version.

The implementation map is:

- `scripts/plan-release.mjs` and `scripts/lib/release-classification.mjs`
  classify all paths since the last release and record both identities in the
  retained plan; `scripts/select-release-plan.mjs` independently recomputes
  that Git diff from the recorded base and rejects a stale, truncated, or
  otherwise malformed plan. Both sides disable rename collapsing so moving a
  native or release file beneath `js/` cannot hide its original path.
- `scripts/lib/release-version.mjs` is the only candidate transform.
  `.github/actions/materialize-release-candidate/action.yml` carries its
  wrapper/native identities consistently between workflow steps.
- `scripts/lib/release-package-plan.mjs` and
  `scripts/prepare-packages.mjs` generate exact dependency graphs. Wrapper
  mode emits only npm/JSR wrapper trees; native mode also emits the loader and
  all target trees.
- `scripts/semantic-release-watchbound.mjs` owns preparation, immutable
  registry preflight, ordered publication, JSR checksum verification, and the
  resumable publication ledger. Semantic-release remains the only version and
  tag authority.
- `scripts/generate-release-evidence.mjs` records full native artifacts and
  reproducibility. `scripts/check-wrapper-packages.mjs` records wrapper
  artifacts plus a reference to the unchanged qualified-native descriptor;
  it does not manufacture new native evidence.
- `.github/workflows/release.yml` selects either the complete native graph or
  the bounded wrapper graph. `scripts/check-registry-packages.mjs` and
  `scripts/check-installed-package.mjs` verify the published wrapper and
  native identities separately after publication.

## Fail-closed release boundary

Only a push to `main` can enter the publication path in
`.github/workflows/release.yml`. Every checked-in npm, Cargo, workspace, and
lockfile version remains `0.0.0-development`. The write-capable planning job
uses semantic-release, Conventional Commits, and release tags to select the
only publication version. Every version-sensitive builder then applies that
version as a deterministic, uncommitted transform of the exact source SHA and
records the transform in its evidence. A native/full transform stamps that
version across wrapper, loader, Cargo and lock identities. A wrapper transform
stamps only the public wrapper manifests and substitutes the exact selected
native-stack dependency.

A separate manual dispatch path can run exact-source qualification with
repository-read permission only. It retains the source placeholder, cannot
satisfy the publication job's independent event, ref, or semantic-release
guards, and is never reused as versioned publication evidence. The custom
plugin requires semantic-release's version to equal the retained release-plan
version and verifies the exact generated candidate before every mutation.

For a native/full release, the plugin refuses preparation unless every matrix
target is checked in as `supported`. For a wrapper-only release it instead
refuses preparation unless the selected published native stack passes every
descriptor, evidence and registry check above. This does not bypass the exact
status-bearing CI, namespace-bootstrap, explicit release-authorization, or
publication gates. Publication remains independently restricted to an
approved semantic-release push on `main`; qualification or credentials alone
never authorize it.

## Exact target pipeline

For each x64, ARM64, and ARMv7 hard-float registry target, a native/full release
workflow:

1. starts two isolated builders from the exact clean source SHA, applies the
   same recorded semantic-release version transform, and builds on Ubuntu
   22.04 with Node 24.15.0, Rust 1.88.0, pnpm 10.33.2, stable remapped Cargo
   paths, no incrementality, `SOURCE_DATE_EPOCH=0`, and UTC; x64/ARM64 build
   natively and ARMv7 uses the pinned GNU armhf cross toolchain;
2. records source/lock/tool/host/build identities and artifact SHA-256;
3. byte-compares the two outputs and fails on any metadata or byte mismatch;
4. aggregates all canonical artifacts with one signed-off comparison record;
5. packages the canonical artifact and exercises every applicable pinned
   distro lane on the same native architecture, or the declared ARMv7 armhf
   QEMU-user lane;
6. runs the canonical package from `app.asar`/`app.asar.unpacked` under exact
   Electron 42.3.0 and Node 24.15.0; ARMv7 executes the official
   `linux-armv7l` archive under `qemu-arm -cpu cortex-a15` with the
   digest-pinned Ubuntu 22.04 armhf OCI rootfs, snapshot-locked packages, and
   retained installed-package manifest;
7. boots the checksum-pinned Canonical Ubuntu 22.04 kernel 5.15 under bounded
   QEMU and reruns the offline package, loader, real-delivery, exclusion-policy,
   recovery, and joined-disposal smoke on x64, ARM64, and ARMv7; ARMv7 uses the
   exact snapshot `5.15.0-185-generic-lpae` package and Electron-as-Node under
   `qemu-system-arm`. This is kernel-floor evidence and does not turn emulated
   ARMv7 into native-runner evidence;
8. runs the I/O-heavy forced-overflow and automatic overflow-reconciliation
   scenarios against the canonical artifact on native GitHub-hosted Ubuntu
   24.04 x64 and ARM64 runners as correctness-only evidence; ARMv7 has no
   overflow-promotion claim in this initial contract; and
9. relies on the reusable CI workflow for full semantics and locked Nix source
   closures on x64 and ARM64.

The release job downloads the aggregate, repeats the current-runner build,
requires its digest to equal the canonical x64 digest, generates all packages,
installs them offline, performs the JSR dry run, and emits ELF inspection,
checksums, build metadata, CycloneDX 1.6 SBOM, and reproducibility evidence.
No mismatch or missing target has a waiver path.

Cross-compilation alone cannot satisfy a target. Container lanes provide
distro userspace evidence but share the runner kernel. The system-QEMU lanes
establish the real pinned kernel floor for all three targets. ARMv7's declared
qualification basis combines reproducible cross-build, strict package/ELF
evidence, a production-loader watch lifecycle in the pinned QEMU-user Electron
runtime, and the same lifecycle on the real 5.15 generic-LPAE kernel under
system QEMU. If either ARM execution lane cannot run, the target stays pending
and release is blocked.

## Supervised hosted overflow qualification

The Release workflow's `workflow_dispatch` mode reuses the complete canonical
artifact pipeline without enabling publication. It accepts an exact candidate
SHA, one scenario, a positive scenario-attempt number, and a typed
acknowledgement. The SHA must equal both the workflow ref selected in GitHub
and the checked-out commit. One green failed-job rerun with complete native
evidence may be conditionally accepted only after the guide's fail-closed
automated review classifies every original failure as an allowlisted QEMU
timeout and the maintainer explicitly confirms it. Otherwise an explicitly
reviewed retry is a new dispatch with an incremented scenario attempt.

Dispatch `overflow-reconciliation` first. Review the full run and both native
overflow artifacts before separately dispatching
`automatic-overflow-reconciliation`. Each scenario runs once per native
architecture. Preflight and conformance evidence is uploaded even when the
gate fails. See [`overflow-runner-strategy.md`](overflow-runner-strategy.md)
for the recoverable `pnpm release:qualify` guide, exact inputs,
acknowledgement, interpretation, and retention policy.

## Publication ordering and partial failure

After every native/full gate, the custom semantic-release plugin checks
immutable registry state and publishes missing packages in this order:

1. `@gadicc/watchbound-node-linux-arm-gnueabihf`;
2. `@gadicc/watchbound-node-linux-x64-gnu`;
3. `@gadicc/watchbound-node-linux-arm64-gnu`;
4. architecture-neutral `@gadicc/watchbound-node`;
5. `watchbound`;
6. JSR `@gadicc/watchbound`.

Existing versions must have exact identity, integrity, dependencies,
`optionalDependencies`, `os`, `cpu`, and `libc`. The plugin refuses a loader or
wrapper version that exists without both exact target versions. It writes a
publication ledger after every mutation so an immutable partial failure can be
handled as an incident rather than overwritten.

For a wrapper-only release, preflight first re-verifies the selected native
baseline, then the only publication order is npm `watchbound` followed by JSR
`@gadicc/watchbound`. Existing wrapper versions must match the locally packed
integrity and exact loader dependency. An existing JSR version must match the
complete generated file set, sizes, and SHA-256 checksums and cannot precede
its npm wrapper. The JSR dry run and publication install the exact selected
loader and current target from npm; they never build a native artifact.

Both release classes are resumable from immutable partial state. Native/full
resume still requires every target before loader and wrapper. Wrapper-only
resume may verify an existing npm wrapper and continue to the missing JSR
operation. Neither class overwrites a version, accepts an integrity mismatch,
or permits JSR to exist before the matching npm wrapper.

npm publication uses trusted publishing and provenance. JSR publication uses
its GitHub OIDC relationship. The workflow has no npm/JSR token. Semantic
release creates the tag and GitHub release only in the normal main-push path.

## Registry bootstrap and trusted publication

The x64 and ARM64 npm target names were bootstrapped with the inert
`0.0.0-bootstrap.0` version. npm required the first version to receive the
`latest` tag; both bootstrap versions are deprecated and also carry the
`bootstrap` tag. Do not depend on them.

The ARMv7 name `@gadicc/watchbound-node-linux-arm-gnueabihf` was bootstrapped
with explicit maintainer authorization on 2026-08-07. Its inert
`0.0.0-bootstrap.0` contains only `package.json` and `README.md`, is deprecated
with the required text, and retains the `bootstrap` tag. Stable releases
from `2.1.0` through `2.1.2` were subsequently published through the trusted
workflow. The selected native baseline is never derived from the mutable
`latest` tag.

The bootstrap tarball has npm shasum
`c55b4956f7cd52805bc141ea3aa35092ee0e1778` and integrity
`sha512-1QGAFl9SRGVQBh9aLz3bR5ix3aOdjAlxTxInsUiwUmuCePEYyWrDBdfdVzoQsYwfLYEXX0IKkaCkeN2HGZhFAw==`.
Trusted publisher configuration `74d2180f-c46d-488e-9407-bbd1c312e01d`
authorizes publish from repository `gadicc/watchbound` and workflow
`release.yml`. That configuration published and verified the stable ARMv7
binding; it does not authorize any future release independently of the normal
main-push and exact-candidate gates.

Semantic release now checks every package namespace before its first registry
mutation. Every native target must expose the exact inert
`0.0.0-bootstrap.0` version, deprecation text, `bootstrap` tag, and Watchbound
repository identity; the loader and wrapper namespaces must already exist.
It then reads and validates every already-published candidate version before
publishing anything. Missing candidates are published ARMv7 first, then the
established native targets, loader, and wrapper, so a new-namespace failure is
contained before stable package versions are mutated.

All established npm package routes use the trusted publisher for repository
`gadicc/watchbound` and workflow `release.yml`; JSR authorizes the same GitHub
workflow for `@gadicc/watchbound`. Ordinary release publication uses OIDC and
has no npm or JSR token. Keep the repository, workflow filename, branch, and
environment constraints exact.

## Post-publication verification

An immutable native/full release is only verified after npm and JSR Node routes
install the exact wrapper/native version on native x64 and ARM64 runners and
the ARMv7 QEMU-user Electron lane. A wrapper-only release runs the native x64
and ARM64 npm/JSR routes with the new wrapper version and selected older native
version, but does not rerun the ARMv7 emulator, distro, kernel, overflow, or
reproducibility lanes. Each applicable smoke confirms the selected target
package and digest, production loader/capability handshake, real delivery,
initial/dynamic whole-policy exclusions, root recovery, reconciliation,
cancellation, callback serialization, joined disposal, and resource return.

If any route fails after publication, stop. Do not replace, unpublish, or
silently retag the immutable version. Retain the ledger and evidence, assess
the partial state, and follow `release-incident-response.md` with a new patch
version where appropriate.

## Support-promotion invariant

- Ensure the exact status-bearing commit has complete green x64/ARM64 source,
  reproducibility, distro, Electron, Nix, pinned kernel-floor, and supervised
  overflow evidence, plus ARMv7 cross-build, package, QEMU-user Electron,
  system-QEMU kernel-floor lifecycle, and negative-ABI evidence.
- Record runner/job URLs, artifact hashes, maximum GLIBC versions, host kernel
  facts, and caveats in a non-release evidence update.
- Complete both adversarial packaging/release reviews.
- Obtain explicit maintainer release approval before publication; target-name
  registry bootstrap is complete.
- Never merge merely to exercise publishing.
