# Maintenance and private 0.x policy

Status: approved on 2026-07-21 for the maintained-unpublished phase.

This policy does not authorize publication, a package-visibility change,
prebuilt native artifacts, artifact upload, or consumer integration.

## Ownership

Gadi Cohen <dragon@wastelands.net> is the maintainer for the initial
maintained-unpublished phase. Maintenance ownership includes Linux inotify
semantics, Rust and Node dependency updates, security assumptions, test
triage, and release-gate evidence.

## Project state

Watchbound remains private and unpublished. Version `0.1.0` is the first frozen
private API candidate. The repository may support controlled source builds on
the target in `support-matrix.md`, but it must not imply a public or
consumer-ready compatibility promise.

Recognition as maintained-unpublished requires all ordinary verification and
documentation gates in `consumer-api-stabilization.md` to pass. Approval to do
the work is not itself evidence that those gates pass.

## Compatibility policy

Ordered batches are the authoritative observation stream. The defining
coverage, loss, exact-byte, root-identity, exclusion-generation, boundedness,
peer-truthfulness, and joined-disposal contracts are compatibility-sensitive.
They must not be weakened in a patch release.

For the frozen private `0.1.0` candidate and later private `0.x` revisions:

- patch releases may contain compatible bug fixes, documentation, tests, and
  internal implementation changes;
- minor releases are required for any externally observable change to an
  option, default, callback or batch shape, structured-error code, ordering or
  lifecycle rule, capability schema, or closed discriminated union;
- additions to closed reason, status, and result unions are minor changes and
  must be called out for exhaustive TypeScript consumers;
- the JavaScript wrapper and native binding move in lockstep and must reject a
  version or contract mismatch rather than attempting a best-effort load;
- major-version stability is not claimed during private `0.x` development.

The frozen surface and explicit unsupported scope are recorded in
[`private-api-freeze.md`](private-api-freeze.md).

## Ordinary change gate

Every code change must pass, on the exact claimed target where relevant:

1. focused tests written before the semantic implementation;
2. `pnpm build:node`;
3. `pnpm test`;
4. `pnpm check`;
5. `pnpm test:soak` for lifecycle/resource-affecting changes;
6. applicable strict, non-heavy conformance scenarios, run serially.

`pnpm test:root-recovery-stress` is the ordinary three-run direct-and-ancestor
replacement gate for changes that can affect identity recovery. It bounds each
replacement scan tree to 128 through 512 directories and neither induces
overflow nor records benchmark evidence.

Type declarations are checked by compiled consumer fixtures. Source-build and
loader changes additionally exercise clean build/load, unsupported-platform,
version-mismatch, and environment-teardown behavior.

Forced overflow remains a supervised milestone/release gate. It is never an
automatic per-commit test and requires fresh quiet-host confirmation.

## Release and distribution gates

Maintained-unpublished status does not authorize a release. Before any future
publication or prebuild proposal, separately review package visibility,
versioning, target-specific artifact names, checksums, provenance, SBOM,
signing or attestation, reproducibility, loader fallback, and native/wrapper
version matching.

Publishing, distributing prebuilds, uploading artifacts, or integrating a
consumer always requires fresh explicit approval.
