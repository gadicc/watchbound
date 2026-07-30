# Maintenance and release policy

Status: the first multi-target release, `1.1.0`, is published and passed native
x64/ARM64 npm and JSR Node-route registry smokes. Future releases and consumer
production readiness remain separately gated.

The earlier maintained-unpublished policy did not authorize publication,
artifact upload, or consumer integration. The maintainer separately approved
the `0.0.1` npm/JSR bootstrap. Semantic-release is wired to `main`, but later
publication still requires an explicit maintainer merge or push, a
release-worthy Conventional Commit, and completion of the distribution gates
below. Bootstrap publication does not itself authorize consumer integration.
The maintainer has since separately authorized the opt-in Codex Desktop Linux
integration recorded in `docs/architecture.md`. Exact multi-target
qualification and official immutable artifacts are complete for `1.1.0`;
consumer-side artifact pinning and acceptance remain Codex-owned.

## Ownership

Gadi Cohen <dragon@wastelands.net> is the maintainer for the initial
maintained-unpublished phase. Maintenance ownership includes Linux inotify
semantics, Rust and Node dependency updates, security assumptions, test
triage, and release-gate evidence.

## Project state

Version `0.1.0` was the first frozen private API. The subsequent private `0.2.0`
development revision added cancellable establishment and shared
per-environment delivery. The public registry line reset with a `0.0.1`
bootstrap package containing that revision; later public versions are owned by
semantic-release. The immutable bootstrap reports `target-pending-clean-ci`,
although a later exact commit qualified its implementation baseline. The
corrected `1.0.1` package restored the JSR route. Release `1.1.0` adds the
x64/ARM64 target-package matrix while retaining generation-zero exclusions,
promise-aware callbacks, and binding API 3; its capability schema 4 target
entries are `supported` after complete exact-commit qualification.
`support-matrix.md` is the claim authority, and buildability or bootstrap
publication must not imply a broader compatibility promise.

The exact-commit verification and documentation gates supporting recognition
as maintained-unpublished are recorded in `consumer-api-stabilization.md`.
Approval to do work is not itself evidence that a future gate passes.

## Compatibility policy

Ordered batches are the authoritative observation stream. The defining
coverage, loss, exact-byte, root-identity, exclusion-generation, boundedness,
peer-truthfulness, and joined-disposal contracts are compatibility-sensitive.
They must not be weakened in a patch release.

For the frozen private `0.1.0` API and later private `0.x` revisions:

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

Cancellation/shared-delivery changes additionally require deterministic
attempt barriers or fake-native settlement seams, a `UV_THREADPOOL_SIZE=1`
child fixture, one/many/churned registration tests, two live Node environments,
callback-pressure isolation/accounting, and exact final dispatcher,
registration, cleanup-coordinator, descriptor, and thread baselines.

`pnpm test:root-recovery-stress` is the ordinary three-run direct-and-ancestor
replacement gate for changes that can affect identity recovery. It bounds each
replacement scan tree to 128 through 512 directories and neither induces
overflow nor records benchmark evidence.

Type declarations are checked by compiled consumer fixtures. Source-build and
loader changes additionally exercise clean build/load, unsupported-platform,
version-mismatch, and environment-teardown behavior.

Forced overflow remains a supervised milestone/release gate and is never an
automatic per-commit test. Local performance-bearing runs require fresh
quiet-host confirmation; hosted release qualification is correctness-only,
one scenario per guarded dispatch, with non-authoritative timings.

## Release and distribution gates

The historical maintained-unpublished status did not authorize a release. The
separately approved bootstrap and `1.1.0` multi-target release are now
published. The multi-target bundled-native design includes target-specific naming,
checksums, provenance, CycloneDX SBOM, binary inspection, version/delivery
lockstep, independent-builder byte comparison, same-runner defense in depth,
fail-closed loading, and an incident runbook. Before each future publication,
separately review package visibility and versioning, the exact release commit,
remaining production blockers, the narrow support statement, and the generated
evidence.

An intentional maintainer merge or push of the exact qualified commit to
`main` is the fresh publication approval. No branch-protection rule, protected
environment, or separate deployment approval is required. Uploading artifacts
outside the documented workflow or integrating a consumer remains separately
authorized work.

The checked-in release workflow is preparation, not blanket approval. Feature
branches, pull requests, and `dev` pushes cannot publish. A push to `main`
starts the Release workflow; semantic-release may publish the committed
lockstep version only after every pre-publication dependency succeeds and
Conventional Commits require it. A stable release is
published-but-verification-pending until clean exact-version npm and JSR
Node-route installs pass on fresh supported runners.
