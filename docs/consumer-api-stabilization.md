# Consumer and API stabilization decision

Status: stabilization authorized on 2026-07-21; implementation and validation
in progress.
This record does not publish a package, change package visibility, produce a
prebuild, or authorize integration with any consumer.

## Decision

Develop Watchbound into a **maintained unpublished Linux package**. Gadi Cohen
<dragon@wastelands.net> owns the initial maintenance phase, and the narrow
deployment target is recorded in `support-matrix.md`. Keep it private at
`0.0.0` until the entry and verification criteria below pass. Do not prepare
consumer integration yet.

This is the middle of the three evaluated choices. The feasibility prototype
has now demonstrated the differentiating contract—explicit coverage and loss,
bounded shared resources, in-place reconciliation, explicit root identity
recovery, and joined disposal—through the engine, Node binding, wrapper, and
ordinary conformance. Retaining it only as an experiment would preserve the
evidence but leave the API and build assumptions to decay. Integration is
premature because the supported target matrix, native artifact production, and
the broader compatibility policy are not yet stable. Operation failures now
have the schema-version-1 contract in
[`error-contract.md`](error-contract.md).

“Maintained unpublished” means a deliberately supported private package, not a
hidden product dependency. It may be built and tested in controlled Linux
environments while its API is still revised. Any package-visibility change,
prebuild production, publishing machinery, or consumer integration still
requires explicit approval.

The compatibility and release policy is in `maintenance-policy.md`; the
approved non-adversarial path boundary is in `security-threat-model.md`.

## Resulting contract audit

| Area | Implemented contract | Stabilization gap |
| --- | --- | --- |
| Capability reporting | Frozen wrapper capabilities report recursion, moved-in discovery, watch limits, overflow, exclusions, reconciliation, automatic reconciliation, root recovery, and exact child-path bytes. The conformance adapter gates complete operations. | There is no capability schema/version, platform/libc/architecture field, option-limit/default description, or distinction between per-subscription logical limits and the engine's process-wide native budget. |
| Coverage and uncertainty | `complete`, reasoned `partial`, and reasoned `uncertain` are explicit. Stronger loss stays sticky, batches are bounded, and no detailed reconstruction is claimed after uncertainty. Immutable `initialCoverage`/`initialRootState` define the exact sequence-zero establishment baseline; frozen `observedState` projects that baseline or the last batch whose callback entered JavaScript. | `observedState` intentionally is not an atomic live-native snapshot. Live getters and operation acknowledgements may be ahead, and an operation that emits no batch can leave it behind indefinitely; ordered batches remain authoritative for JavaScript observation. |
| Manual reconciliation | `reconcile()` rebuilds the original identity under the committed exclusions and earns only one root boundary after bounded enqueue. Rejections use stable codes for topology conflicts, root-state conflicts, backpressure, interruption, and closure. | A successful acknowledgement can precede its callback and therefore never advances `observedState` optimistically. Consumers that need JavaScript-observed state use the ordered batch projection rather than the operation result. |
| Automatic reconciliation | Disabled by default; finite attempts and timers; one immutable status; never adopts a root; disposal joins active work. Retry and blocking policy uses exact `WATCHBOUND_*` codes and derived retry conditions, never message matching. | Policy status is observational, not a durable event stream. Defaults and bounds exist in code/docs but are not exposed as machine-readable capability data. |
| Root replacement | Root identity, generation, attachment, and bounded loss evidence travel on every batch. `recoverRoot` requires `original-only` or `accept-replacement`, preserves one subscription and exclusion generation, and returns structured expected filesystem outcomes. Lifecycle, transaction, and internal rejections use the same stable operation-error schema. | `(device, inode)` is non-cryptographic and susceptible to inode reuse. Path checks are deliberately non-adversarial and not fd-anchored. |
| Options | Positive integer native options use finite `u32` bounds. Automatic retries are limited to 16 and delays to 10–60,000 ms; defaults are finite. | The public types do not encode numeric ranges. A JavaScript consumer cannot configure the engine's process-wide native-watch budget, and the first live Rust engine fixes that budget for the runtime lifetime. Default changes would be behavioral API changes. |
| Status and errors | Coverage, stats, root state/results, callback errors, bridge delivery errors, and automatic-policy status are visible. Expected root candidate failures have bounded reason variants. Rejected operations expose schema-version-1 `WatchboundError` metadata: a stable code and operation, code-derived retry guidance, and optional bounded system diagnostics. | There is no subscription-level last-error/event channel. The error schema remains compatibility-sensitive while the package is private at `0.0.0`. |
| TypeScript | The wrapper declares discriminated coverage, automatic status, initial and observed root/coverage state, root policy/results, bigint counters, exact bytes, exclusions, reconciliation, recovery, and disposal. | Declarations are handwritten and not compiled in CI against usage fixtures. Native generated types are looser strings, while wrapper types are closed unions. Adding a reason/status is potentially breaking for exhaustive consumers. |
| Node and Linux support | Manifests claim Node `>=18`; Node-API 6 avoids direct V8 coupling. Rust requires 1.88. The engine intentionally fails to compile off Linux. Current local evidence is Linux x64/glibc on Node 25.2.1. | The claimed Node floor has no matrix evidence here. Linux arm64 and musl are not tested. The generated napi loader lists unsupported platforms even though the Rust engine is Linux-only, and package metadata does not declare `os`, `cpu`, or libc support. |
| Native build | A local release build works through pinned napi-rs tooling and records the loaded binary identity in conformance. | Consumers currently need Rust, a C linker, pnpm build tooling, and a compatible host, or an unimplemented trusted prebuild path. There is no ABI/platform artifact matrix, reproducibility check, install fallback contract, or binary size gate. |
| Security and paths | Exact Linux child-path bytes cross the native boundary; root components are retained for symlink validation; directory symlinks are not followed; identity is checked around watch installation and recovery barriers. | The root API itself accepts only a JavaScript string. `canonicalize`/metadata/inotify checks remain path-based TOCTOU defenses for stable, non-adversarial filesystems, not an `openat2`/directory-fd security boundary. Mount replacement and adversarial inode reuse are outside the claim. |
| Maintenance burden | Rust unit/integration suites, Node lifecycle tests, wrapper/policy tests, harness tests, ordinary conformance, and separately gated genuine-overflow evidence cover the defining semantics. | Linux kernel behavior, Node environment teardown, GC, shared allocator fairness, symlink races, and native packaging all require specialist ownership. Genuine overflow is intentionally supervised, host-sensitive, serial, and unsuitable for every commit. |
| Artifact provenance | Ignored raw reports are hashed in a committed manifest and copied to a private content-addressed SHA-256 store. Source/native hashes and caveats are retained. | Raw reports contain private paths/host details, the store is local rather than a release service, restoration is manual, and public sanitization is only planned. Native release artifacts have no SBOM, signing, attestation, or reproducible-build evidence. |
| Compatibility and semver | Everything remains private at `0.0.0`; no stable external promise has been made. | The callback/batch shape, observed-state timing, bigint counters, reason/status unions, default policy, global runtime configuration, exact-byte behavior, disposal timing, and root-boundary credit are all compatibility-sensitive. The wrapper/native package split and future prebuild layout are undecided. |

## Choice comparison

| Choice | Benefit | Cost/risk | Decision |
| --- | --- | --- | --- |
| Retain as a feasibility prototype | Lowest ongoing commitment; preserves the completed evidence and conservative design. | API/build drift, dependency aging, no supported consumption path, and repeated rediscovery if a consumer appears. | Fallback if ownership or a target environment is absent. |
| Develop into a maintained unpublished package | Allows deliberate API changes, CI/support definition, internal artifact work, and security review without public compatibility or product coupling. | Requires a named owner and recurring Linux/Rust/Node maintenance before it delivers product value. | **Recommended next state.** |
| Prepare for eventual consumer integration now | Would test the contract against a real consumer and surface mapping/policy needs. | Prematurely couples evolving state observability, options, packaging, and lifecycle semantics; risks turning consumer behavior into engine policy and bypassing release/security gates. | No-go until the exit criteria below pass and integration is separately approved. |

## Entry criteria for maintained-unpublished status

The technical feasibility evidence is present and criteria 1 through 4 have
been accepted. Recognition still waits for implementation and validation of
the remaining gates:

1. Gadi Cohen owns Linux inotify semantics, Rust/Node dependencies, security
   assumptions, test triage, and release-gate evidence.
2. The first supported target is the exact, narrow source-build target in
   `support-matrix.md`, not the generated loader's broad platform list.
3. Consumers of the private package accept conservative root invalidation,
   explicit partial/uncertain coverage, required joined disposal, and no
   reconstructed detailed-event promise.
4. The repository keeps `private: true`, Rust `publish = false`, and version
   `0.0.0` while the stabilization backlog below can still change the API.
5. Ordinary changes continue to pass `pnpm build:node`, `pnpm test`,
   `pnpm check`, and applicable strict non-heavy conformance. Forced-overflow
   evidence remains a separately approved release/milestone gate.
6. The private artifact store and committed manifest remain recoverable until a
   successor archive is proven; exact raw reports are not made public without
   the planned sanitizer and review.

If criteria 1 or 2 cannot be met, record the repository as a preserved
prototype and do not imply package support.

## Exit criteria before consumer-integration preparation

All criteria are required; meeting them does not itself authorize integration.

1. Freeze a documented private `0.x` API candidate, including callback order,
   batch/root/exclusion generations, coverage transitions, disposal, and which
   additions to discriminated unions are allowed in minor versions.
2. **Complete:** replace message matching with stable structured error codes and
   document which failures are retryable, terminal, or expected structured
   results. The implemented schema-version-1 contract is in
   [`error-contract.md`](error-contract.md).
3. **Complete:** expose immutable establishment state and one race-aware
   callback-observed projection while retaining ordered batches as the
   authority. Live native getters and operation acknowledgements are explicitly
   allowed to be ahead of `observedState`.
4. Decide whether JavaScript needs process-wide native-watch budgeting. If it
   does, expose configuration and global conflict behavior before integration;
   if it does not, document the resource owner and operational limit.
5. Validate the exact Node/Linux/architecture/libc matrix in clean CI and test
   TypeScript consumer fixtures with the oldest supported compiler/runtime.
6. Choose a native delivery model: controlled source builds or reviewed
   prebuilds. Define artifact naming, checksums, provenance, SBOM, signing or
   attestation policy, loader failure behavior, and version matching.
7. Complete a security review against the intended threat model. If watched
   roots can be adversarially mutated, replace the current path-based contract
   with an fd-anchored design (likely `openat2`/directory fds) or explicitly
   reject that use case.
8. Pass the follow-up test gates below without weakening coverage, bounds,
   exclusions, peer truthfulness, root-only recovery, or joined disposal.
9. Produce and review a sanitized public-evidence format linked to private
   originals, or explicitly decide that release evidence stays private.
10. Obtain separate approval for the consumer boundary and prove that Git,
    ignore, workspace, UI, retry, and logical-path policy stay outside the
    engine/Node binding.

## Required follow-up tests

Before an integration-readiness decision, add or run:

- clean CI across every claimed Node/Linux/architecture/libc target, including
  install/load failure cases and environment teardown;
- compiled TypeScript usage fixtures covering exhaustive unions, bigint fields,
  exact-byte exclusions, recovery results, and status narrowing;
- stable structured-error contract tests for invalid arguments, transaction
  conflicts, backpressure, interruption, disposal races, and unavailable roots;
- retain current-state/batch ordering tests for baseline initialization,
  pre-resolution callbacks, update-before-user-callback behavior, callback
  exceptions, and operation acknowledgement races;
- repeated large direct and ancestor replacement with peers, shared old/new
  identities, limits, exclusions, disposal overlap, and candidate changes at
  each validation barrier;
- long-running bounded soak tests for watch churn, descriptor reuse, deferred
  promotion, queue pressure, callback exceptions, and final resource baseline;
- packaging tests for the chosen source-build or prebuild path, including
  checksum/version mismatch and unsupported-platform diagnostics;
- one separately approved supervised genuine-overflow trial for a release or
  semantic milestone that changes loss/reconciliation behavior; never make it
  an automatic per-commit workload;
- adversarial path tests only if the threat model expands, preceded by an
  fd-anchored design rather than by weakening current symlink claims.

## Exit back to preserved-prototype status

Stop package stabilization and retain the evidence-only prototype if there is
no maintainer, no concrete supported Linux target or prospective consumer, the
security model requires an unaffordable fd-anchored redesign, native artifact
maintenance outweighs the contract's value, or repeated conformance cannot
preserve conservative coverage and joined cleanup.

## Change authority

The 2026-07-21 approval authorizes the operational API, source-build,
maintenance, bounded verification, and sanitizer implementation work described
in this decision. It does not authorize changing any `private`/`publish`
setting, versioning the packages, adding release or publishing automation,
producing or distributing prebuilds, uploading artifacts, committing a public
derivative of private evidence, or integrating Watchbound with Codex Desktop
or another consumer.
