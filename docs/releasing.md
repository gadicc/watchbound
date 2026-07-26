# Release and registry runbook

Status: `1.0.1` remains the qualified published release. `1.2.0` is an
unpublished multi-target candidate. This repository configuration is
preparation, not blanket permission to publish.

## Fail-closed release boundary

Only a push to `main` can enter `.github/workflows/release.yml`. The planning
job computes the semantic-release decision without changing versions. Expensive
native jobs run only when the exact commit would release. The custom plugin
then requires the planned version to equal the already committed lockstep npm,
JSR, Cargo, and lockfile version.

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
7. runs the explicitly acknowledged, I/O-heavy forced-overflow and automatic
   overflow-reconciliation scenarios against the canonical artifact on a
   prepared self-hosted runner labeled `watchbound-overflow`; and
8. relies on the reusable CI workflow for full semantics and locked Nix source
   closures on x64 and ARM64.

The release job downloads the aggregate, repeats the current-runner build,
requires its digest to equal the canonical x64 digest, generates all packages,
installs them offline, performs the JSR dry run, and emits ELF inspection,
checksums, build metadata, CycloneDX 1.6 SBOM, and reproducibility evidence.
No mismatch or missing target has a waiver path.

Cross-compilation and QEMU-only execution cannot satisfy a target. Container
lanes provide distro userspace evidence but share the runner kernel; kernel
floor evidence must be recorded separately and truthfully.

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

## New-package bootstrap

The two target package names do not yet exist. Their one-time package creation
requires separate explicit maintainer approval and interactive registry
authority. Create only the exact reviewed version with a non-default bootstrap
dist-tag, do not create a semantic-release Git tag, and verify the resulting
registry integrity before enabling ordinary OIDC release. This branch does not
perform that bootstrap.

Configure npm trusted-publisher relationships for the `release.yml` workflow
and JSR package authorization before an ordinary release. Keep the repository,
workflow filename, branch, and environment constraints exact.

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
  reproducibility, distro, Electron, Nix, and supervised overflow evidence.
- Record runner/job URLs, artifact hashes, maximum GLIBC versions, host kernel
  facts, and caveats in a non-release evidence update.
- Complete both adversarial packaging/release reviews.
- Obtain explicit maintainer release approval and registry bootstrap approval.
- Never merge merely to exercise publishing.
