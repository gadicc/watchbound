# Consumer and API stabilization decision

Status: private `0.1.0` API freeze in progress on 2026-07-21. The technical
candidate and deterministic identity barriers passed, but Watchbound remains a
feasibility prototype until the exact frozen candidate and subsequent support
qualification commit pass clean CI. Its capability support status remains
`target-pending-clean-ci`.

This decision does not publish a package, change package visibility, produce a
prebuild, upload an artifact, or authorize consumer integration.

## Current decision

Preserve the first frozen private `0.1.0` candidate while it is qualified. The work
substantially hardened the feasibility implementation: the operational API,
runtime ownership, TypeScript surface, native loader, source-build boundary,
maintenance tests, threat model, and evidence sanitizer now have explicit
contracts. Gadi Cohen <dragon@wastelands.net> owns the initial maintenance
phase.

Recognition as a maintained unpublished package is still withheld. The
technical precursor passed both clean lanes and root recovery now has
deterministic injection at every materially distinct identity barrier. The
`0.1.0` freeze must still pass both lanes, followed by a separate pending-to-
supported status commit and its own green run. Any consumer boundary still
requires separate approval.

Ordered batches remain the authoritative observation stream. Coverage and root
state stay explicit; work, queues, timers, traversals, diagnostics, and
disposal remain bounded. No result claims reconstructed detail after
uncertainty.

## Resulting contract audit

| Area | Implemented contract | Remaining boundary |
| --- | --- | --- |
| Capability reporting | Deeply frozen, JSON-serializable schema version 1 separates versions/build identity, observed runtime facts, pending support target, features, option defaults/hard bounds/accounting, and observability. | Runtime facts are diagnostic, not support evidence. Version 0.1.0 continues to emit `target-pending-clean-ci` until separate qualification. |
| Coverage and observation | Complete, reasoned partial, and reasoned uncertain states are explicit. Immutable `initialCoverage`/`initialRootState` define sequence zero; frozen `observedState` is the baseline or last batch whose callback entered JavaScript. | `observedState` is deliberately not an atomic native snapshot. Getters and operation acknowledgements may be ahead; ordered batches are authoritative. |
| Operations and errors | Reconciliation, exclusions, and explicit root recovery have bounded acknowledgements. Rust, Node, JavaScript, and TypeScript share schema-version-1 `WatchboundError` codes, operations, retry policy, and bounded diagnostics. | Expected non-attached recovery outcomes remain successful structured results; incompatible schema changes require a later private minor version. |
| Runtime ownership | `createEngine({ nativeWatchBudget })` owns an optional process-wide unique-native-watch budget. Engine construction is resource-free; equal configurations share, conflicts are coded, failed provisional establishment releases ownership, and final disposal joins before reconfiguration. | `watchLimit` remains separate per-subscription logical accounting. TypeScript cannot encode numeric ranges. |
| TypeScript | Strict TypeScript 6.0.3 consumer fixtures cover closed unions, bigint counters, exact bytes, errors, recovery, automatic status, initial state, and observed state. They run from `pnpm typecheck` and the CI definition. | Additions to closed reason/status/result unions are compatibility changes for exhaustive consumers. Clean target execution is pending. |
| Node and platform support | All manifests require Node `>=24.18.0 <25`; native/wrapper manifests declare Linux, x64, and glibc. The loader accepts exactly `watchbound.linux-x64-gnu.node`, requires Node-API 6+, and fails closed with stable platform/libc/ABI/build/version/API diagnostics. | The technical precursor passed both target lanes; the exact 0.1.0 and final support commits remain pending. Other distributions, libc families, architectures, Node majors, and operating systems are unsupported. |
| Native delivery | Controlled source build is selected. The root build guard preserves hand-owned entry files, produces the one expected local release addon, and loads it through the production metadata handshake. No runtime compilation/download/fallback or install hook exists. | No prebuild is authorized. Checksums, SBOM, signing/attestation, reproducibility, and distribution controls are documented gates for a future separately approved prebuild proposal. |
| Security and paths | The approved contract is trusted, same-user, stable local roots under ordinary concurrent mutation. Exact Linux child-path bytes, lexical components, symlink rejection, identity checks, watch-before-read ordering, and explicit recovery policy are preserved. | Malicious replacement, hostile multi-user filesystems, mount substitution, and adversarial inode reuse are unsupported. No fd-anchored `openat2` redesign is planned under this threat model. |
| Maintenance | Rust/Node/JavaScript suites, environment teardown, descriptor-lifetime tests, deterministic recovery-barrier injection, 25-cycle bounded soak, three-run large root recovery, and strict ordinary conformance cover the defining lifecycle. | The exact 0.1.0 and final support commits still require clean target execution. Forced overflow stays a separately approved milestone gate. |
| Evidence | Private originals remain ignored and content-addressed under their committed SHA-256 manifest. Sanitizer 1.0.0, public schema 1, deterministic placeholders, bounds, linkage checks, and synthetic leak/tamper tests are implemented. | No private report was read or transformed, and no public derivative is approved. Every real derivative still requires named approval and manual review. |
| Compatibility | Everything remains private and unpublished; `0.1.0` freezes the first private API candidate and package-internal policy stays outside the engine. | No target consumer or consumer-boundary approval exists. |

## Choice comparison

| Choice | Current decision |
| --- | --- |
| Preserve as a feasibility prototype | **Selected while qualification is incomplete.** Retain the frozen candidate without claiming completed target support. |
| Recognize as a maintained unpublished package | Reconsider after the exact 0.1.0 and final support commits both pass clean target CI. |
| Begin consumer-integration preparation | No-go. It needs separate boundary approval and proof that Git, ignore, workspace, UI, retry, and logical-path policy remain outside Watchbound. |

## Entry-criterion audit

| # | Result | Evidence or blocker |
| --- | --- | --- |
| 1 | Pass | Gadi Cohen owns Linux/inotify semantics, dependency upkeep, security assumptions, triage, and release-gate evidence in `maintenance-policy.md`. |
| 2 | Pass as a target definition | `support-matrix.md`, manifests, capabilities, loader, and CI agree on the narrow source-build target. This is not yet successful-target evidence. |
| 3 | Pass for maintainer stabilization; consumer input deferred | The maintainer approved conservative invalidation, explicit partial/uncertain coverage, and joined disposal. No prospective consumer has been named or approved. |
| 4 | Pass | JavaScript packages are private `0.1.0`; Rust crates have `publish = false`; package-contract tests lock the boundary. |
| 5 | Partial | The technical precursor passed both clean target lanes. The exact frozen candidate and final support commit have not yet passed. |
| 6 | Pass | Private archive identity/retention and the implemented sanitizer workflow preserve originals. Real sanitization remains approval-gated. |

## Exit-criterion audit before integration preparation

| # | Result | Evidence or blocker |
| --- | --- | --- |
| 1 | Pending exact-CI proof | The first private 0.1.0 API/order/union policy is frozen in `private-api-freeze.md`; this commit must still pass both lanes. |
| 2 | Pass | Stable structured errors replace message matching across all layers; retry policy derives from codes. |
| 3 | Pass | Immutable establishment state and callback-observed projection are implemented and race-tested without claiming live atomicity. |
| 4 | Pass | Runtime budget ownership, conflicts, sharing, provisional failure rollback, final joined release, and reconfiguration are implemented and tested. |
| 5 | Partial | Both lanes passed the technical precursor; exact 0.1.0 and final support qualification remain. |
| 6 | Pass for the selected delivery model | Controlled source build, exact naming, load failure behavior, and lockstep metadata/version validation are implemented. Future prebuild controls are documented but deliberately not implemented. |
| 7 | Pass by explicit scope rejection | Stable non-adversarial roots are supported; hostile roots require a separately approved fd-anchored redesign. |
| 8 | Pass | Candidate replacement is deterministically injected after capture and drain, across shared/new watch admission, during traversal, and before final validation with conservative cleanup and peer proof. |
| 9 | Pass for format/tooling; per-derivative approval remains | The sanitizer and public schema are complete and synthetic-tested. No real derivative has been authorized. |
| 10 | Blocked on separate approval | Architectural policy separation is documented and no integration occurred; no consumer-boundary approval or named-consumer proof exists. |

## Follow-up verification audit

| Required verification | Result |
| --- | --- |
| Clean install/build/load and environment teardown on every claimed target | The technical precursor passed both lanes; exact frozen/support commits remain. |
| Compiled TypeScript consumer fixtures | Pass locally on exact Node 24.18.0 with TypeScript 6.0.3; wired into both CI lanes. |
| Structured error contracts | Pass across invalid arguments, conflicts, backpressure, interruption, disposal, unavailable roots, and internal failures. |
| Snapshot/batch ordering | Pass for baseline initialization, pre-resolution seam, update-before-callback, callback exception, and acknowledgement-leading-observation cases. |
| Repeated replacement, peers, exclusions, limits, and disposal overlap | Pass: large direct/ancestor recovery, shared old/new identities, peer survival, and every materially distinct candidate-validation barrier are covered. |
| Churn, descriptor lifetime, deferred promotion, callbacks, and cleanup soak | Pass as combined evidence: deterministic reuse/exhaustion/gap unit tests plus 25 live bounded cycles returning exact runtime and near-baseline `/proc` resources. |
| Chosen delivery packaging failures | Partial pending clean target install. Local source build plus unsupported/missing/load/version/API mismatch tests pass; no prebuild checksum behavior exists because prebuild delivery is not selected. |
| Genuine overflow | Historical supervised evidence remains archived. No current run was made because fresh quiet-host approval is required; it is never an automatic per-commit gate. |
| Adversarial path tests | Deliberately not applicable under the approved threat model. They require an fd-anchored design first. |

## Private 0.1.0 local verification snapshot

The private-freeze gate used Node 24.18.0 through Corepack with pnpm 10.33.2
and Rust 1.88.0:

- controlled `pnpm build:node`: pass with native, engine, and wrapper version
  0.1.0;
- `pnpm test`: pass, including 114 engine tests, three Rust Node-binding unit
  tests, the Node smoke and 25 Node tests, and 89 JavaScript/harness tests;
- `pnpm check`: Rust formatting, warnings-denied workspace Clippy, 47
  JavaScript syntax checks, and strict TypeScript compilation pass;
- `pnpm test:soak`: 25/25 cycles pass in 5.252 seconds, with the steady and
  final process at 19 file descriptors and 11 tasks, zero overflow/drops, and
  exact inactive runtime stats after each cycle;
- `pnpm test:root-recovery-stress`: 3/3 strict runs pass, using 512-directory
  direct and ancestor replacement trees per run;
- strict quick ordinary conformance: 13/13 scenarios pass serially with
  rotating order and `allowForcedOverflow: false`.

This host is an unsupported development host (CachyOS, Linux 7.1, glibc 2.43),
so exact local Node/Rust/tooling results cannot promote the Ubuntu 24.04 target.
The technical precursor passed both clean lanes, but the exact 0.1.0 commit and
the subsequent support-status commit still require their own green runs.

## Final recommendation and reopen conditions

**Preserve Watchbound as a feasibility prototype during qualification**, with
the frozen 0.1.0 work retained as a maintained-unpublished candidate. Do not
claim supported-package status and do not begin integration.

Re-audit the recommendation after:

1. both clean Ubuntu 24.04 CI lanes pass on the exact 0.1.0 commit;
2. a separate support-status commit passes both lanes on its exact SHA;
3. any real public evidence derivative receives its named approval and review;
4. a target consumer and boundary receive separate approval before any
   integration work.

Publishing, package-visibility changes, prebuild production/distribution,
artifact upload, non-Linux backends, and consumer integration remain outside
this decision.
