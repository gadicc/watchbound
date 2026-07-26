# Release and registry runbook

Status: `1.0.1` remains the qualified published release. `1.2.0` is an
unpublished multi-target candidate. This repository configuration is
preparation, not blanket permission to publish.

## Fail-closed release boundary

Only a push to `main` can enter the publication path in
`.github/workflows/release.yml`. The write-capable planning job computes the
semantic-release decision without changing versions. A separate manual
dispatch path can run exact-candidate qualification with repository-read
permission only; it cannot satisfy the publication job's independent event,
ref, or semantic-release guards. The custom plugin requires the planned
release version to equal the already committed lockstep npm, JSR, Cargo, and
lockfile version.

The plugin refuses preparation unless every matrix target is checked in as
`supported`. Both `1.2.0` targets are currently
`target-pending-clean-ci`, so publication is intentionally blocked even if
credentials or workflow conditions are otherwise present.

## Exact target pipeline

For each x64 and ARM64 registry target, the release workflow:

1. runs two isolated clean builders on a native Ubuntu 22.04 runner with Node
   24.15.0, Rust 1.88.0, pnpm 10.33.2, stable remapped Cargo paths, no
   incrementality, `SOURCE_DATE_EPOCH=0`, and UTC;
2. records source/lock/tool/host/build identities and artifact SHA-256;
3. byte-compares the two outputs and fails on any metadata or byte mismatch;
4. aggregates both canonical artifacts with one signed-off comparison record;
5. packages the canonical artifact and exercises every applicable pinned
   distro lane on the same native architecture;
6. runs the canonical package from `app.asar`/`app.asar.unpacked` under exact
   Electron 42.3.0 and Node 24.15.0;
7. boots the checksum-pinned Canonical Ubuntu 22.04 kernel 5.15 under bounded
   QEMU and reruns the offline package, loader, real-delivery, recovery, and
   joined-disposal smoke on each architecture; this is kernel-floor evidence
   only and composes with, rather than replaces, native runner evidence;
8. runs the I/O-heavy forced-overflow and automatic overflow-reconciliation
   scenarios against the canonical artifact on native GitHub-hosted Ubuntu
   24.04 x64 and ARM64 runners as correctness-only evidence; and
9. relies on the reusable CI workflow for full semantics and locked Nix source
   closures on x64 and ARM64.

The release job downloads the aggregate, repeats the current-runner build,
requires its digest to equal the canonical x64 digest, generates all packages,
installs them offline, performs the JSR dry run, and emits ELF inspection,
checksums, build metadata, CycloneDX 1.6 SBOM, and reproducibility evidence.
No mismatch or missing target has a waiver path.

Cross-compilation and QEMU-only execution cannot satisfy a target. Container
lanes provide distro userspace evidence but share the runner kernel. The QEMU
lane establishes only the real pinned kernel floor and is accepted only in
combination with the complete native architecture matrix.

## Supervised hosted overflow qualification

The Release workflow's `workflow_dispatch` mode reuses the complete canonical
artifact pipeline without enabling publication. It accepts an exact candidate
SHA, one scenario, a positive scenario-attempt number, and a typed
acknowledgement. The SHA must equal both the workflow ref selected in GitHub
and the checked-out commit. GitHub workflow reruns are rejected; an explicitly
reviewed retry is a new dispatch with an incremented scenario attempt.

Dispatch `overflow-reconciliation` first. Review the full run and both native
overflow artifacts before separately dispatching
`automatic-overflow-reconciliation`. Each scenario runs once per native
architecture. Preflight and conformance evidence is uploaded even when the
gate fails. See [`overflow-runner-strategy.md`](overflow-runner-strategy.md)
for the exact inputs, acknowledgement, interpretation, and retention policy.

## Publication ordering and partial failure

After every gate, the custom semantic-release plugin checks immutable registry
state and publishes missing packages in this order:

1. `@gadicc/watchbound-node-linux-x64-gnu`;
2. `@gadicc/watchbound-node-linux-arm64-gnu`;
3. architecture-neutral `@gadicc/watchbound-node`;
4. `watchbound`;
5. JSR `@gadicc/watchbound`.

Existing versions must have exact identity, integrity, dependencies,
`optionalDependencies`, `os`, `cpu`, and `libc`. The plugin refuses a loader or
wrapper version that exists without both exact target versions. It writes a
publication ledger after every mutation so an immutable partial failure can be
handled as an incident rather than overwritten.

npm publication uses trusted publishing and provenance. JSR publication uses
its GitHub OIDC relationship. The workflow has no npm/JSR token. Semantic
release creates the tag and GitHub release only in the normal main-push path.

## Registry bootstrap and trusted publication

The x64 and ARM64 npm target names were bootstrapped with the inert
`0.0.0-bootstrap.0` version. npm required the first version to receive the
`latest` tag; both bootstrap versions are deprecated and also carry the
`bootstrap` tag. Do not depend on them.

All four npm package routes use the trusted publisher for repository
`gadicc/watchbound` and workflow `release.yml`; JSR authorizes the same GitHub
workflow for `@gadicc/watchbound`. Ordinary release publication uses OIDC and
has no npm or JSR token. Keep the repository, workflow filename, branch, and
environment constraints exact.

## Post-publication verification

The immutable release is only verified after npm and JSR Node routes install
the exact version on native x64 and ARM64 runners. Each smoke confirms the
selected target package and digest, production loader/capability handshake,
real delivery, initial/dynamic exclusions, root recovery, reconciliation,
cancellation, callback serialization, joined disposal, and resource return.

If any route fails after publication, stop. Do not replace, unpublish, or
silently retag the immutable version. Retain the ledger and evidence, assess
the partial state, and follow `release-incident-response.md` with a new patch
version where appropriate.

## Before changing a target to supported

- Ensure the exact status-bearing commit has complete green x64/ARM64 source,
  reproducibility, distro, Electron, Nix, pinned kernel-floor, and supervised
  overflow evidence.
- Record runner/job URLs, artifact hashes, maximum GLIBC versions, host kernel
  facts, and caveats in a non-release evidence update.
- Complete both adversarial packaging/release reviews.
- Obtain explicit maintainer release approval and registry bootstrap approval.
- Never merge merely to exercise publishing.
