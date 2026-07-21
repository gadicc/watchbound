# Consumer and API stabilization decision

Status: support qualification declared on 2026-07-21 for the frozen private
`0.1.0` API and the exact narrow source-build target. The deterministic
identity-barrier and 0.1.0 freeze commits passed both clean target lanes. This
declaration recognizes Watchbound as maintained-unpublished only after its own
exact commit passes the same two-lane gate.

This decision does not publish a package, change package visibility, produce a
prebuild, upload an artifact, or authorize consumer integration.

## Current decision

Recognize the frozen private `0.1.0` package as maintained-unpublished once the
exact support-declaration commit is green. The work
substantially hardened the feasibility implementation: the operational API,
runtime ownership, TypeScript surface, native loader, source-build boundary,
maintenance tests, threat model, and evidence sanitizer now have explicit
contracts. Gadi Cohen <dragon@wastelands.net> owns the initial maintenance
phase.

The technical precursor and exact 0.1.0 freeze both passed clean floor and
moving lanes, and root recovery has deterministic injection at every materially
distinct identity barrier. The capability now declares `supported` only for the
recorded target. Any consumer boundary still requires separate approval.

Ordered batches remain the authoritative observation stream. Coverage and root
state stay explicit; work, queues, timers, traversals, diagnostics, and
disposal remain bounded. No result claims reconstructed detail after
uncertainty.

## Resulting contract audit

| Area | Implemented contract | Remaining boundary |
| --- | --- | --- |
| Capability reporting | Deeply frozen, JSON-serializable schema version 1 separates versions/build identity, observed runtime facts, fixed support target, features, option defaults/hard bounds/accounting, and observability. Qualified version 0.1.0 emits `supported`. | Runtime facts are diagnostic, not support evidence, and cannot widen the fixed target. |
| Coverage and observation | Complete, reasoned partial, and reasoned uncertain states are explicit. Immutable `initialCoverage`/`initialRootState` define sequence zero; frozen `observedState` is the baseline or last batch whose callback entered JavaScript. | `observedState` is deliberately not an atomic native snapshot. Getters and operation acknowledgements may be ahead; ordered batches are authoritative. |
| Operations and errors | Reconciliation, exclusions, and explicit root recovery have bounded acknowledgements. Rust, Node, JavaScript, and TypeScript share schema-version-1 `WatchboundError` codes, operations, retry policy, and bounded diagnostics. | Expected non-attached recovery outcomes remain successful structured results; incompatible schema changes require a later private minor version. |
| Runtime ownership | `createEngine({ nativeWatchBudget })` owns an optional process-wide unique-native-watch budget. Engine construction is resource-free; equal configurations share, conflicts are coded, failed provisional establishment releases ownership, and final disposal joins before reconfiguration. | `watchLimit` remains separate per-subscription logical accounting. TypeScript cannot encode numeric ranges. |
| TypeScript | Strict TypeScript 6.0.3 consumer fixtures cover closed unions, bigint counters, exact bytes, errors, recovery, automatic status, initial state, and observed state. They run from `pnpm typecheck` and both CI lanes. | Additions to closed reason/status/result unions are compatibility changes for exhaustive consumers. |
| Node and platform support | All manifests require Node `>=24.18.0 <25`; native/wrapper manifests declare Linux, x64, and glibc. The loader accepts exactly `watchbound.linux-x64-gnu.node`, requires Node-API 6+, and fails closed with stable platform/libc/ABI/build/version/API diagnostics. | The exact 0.1.0 freeze passed both target lanes. Other distributions, libc families, architectures, Node majors, and operating systems are unsupported. |
| Native delivery | Controlled source build is selected. The root build guard preserves hand-owned entry files, produces the one expected local release addon, and loads it through the production metadata handshake. No runtime compilation/download/fallback or install hook exists. | No prebuild is authorized. Checksums, SBOM, signing/attestation, reproducibility, and distribution controls are documented gates for a future separately approved prebuild proposal. |
| Security and paths | The approved contract is trusted, same-user, stable local roots under ordinary concurrent mutation. Exact Linux child-path bytes, lexical components, symlink rejection, identity checks, watch-before-read ordering, and explicit recovery policy are preserved. | Malicious replacement, hostile multi-user filesystems, mount substitution, and adversarial inode reuse are unsupported. No fd-anchored `openat2` redesign is planned under this threat model. |
| Maintenance | Rust/Node/JavaScript suites, environment teardown, descriptor-lifetime tests, deterministic recovery-barrier injection, 25-cycle bounded soak, three-run large root recovery, and strict ordinary conformance cover the defining lifecycle. | The exact support-declaration commit must pass both lanes before recognition. Forced overflow stays a separately approved milestone gate. |
| Evidence | Private originals remain ignored and content-addressed under their committed SHA-256 manifest. Sanitizer 1.0.0, public schema 1, deterministic placeholders, bounds, linkage checks, and synthetic leak/tamper tests are implemented. | No private report was read or transformed, and no public derivative is approved. Every real derivative still requires named approval and manual review. |
| Compatibility | Everything remains private and unpublished; `0.1.0` freezes the first private API candidate and package-internal policy stays outside the engine. | No target consumer or consumer-boundary approval exists. |

## Choice comparison

| Choice | Current decision |
| --- | --- |
| Preserve as a feasibility prototype | Superseded by completed technical and private-freeze qualification. |
| Recognize as a maintained unpublished package | **Selected, effective after the exact support-declaration commit passes both clean lanes.** |
| Begin consumer-integration preparation | No-go. It needs separate boundary approval and proof that Git, ignore, workspace, UI, retry, and logical-path policy remain outside Watchbound. |

## Entry-criterion audit

| # | Result | Evidence or blocker |
| --- | --- | --- |
| 1 | Pass | Gadi Cohen owns Linux/inotify semantics, dependency upkeep, security assumptions, triage, and release-gate evidence in `maintenance-policy.md`. |
| 2 | Pass | `support-matrix.md`, manifests, capabilities, loader, and CI agree on the narrow source-build target, and the recorded exact 0.1.0 run passed both lanes. |
| 3 | Pass for maintainer stabilization; consumer input deferred | The maintainer approved conservative invalidation, explicit partial/uncertain coverage, and joined disposal. No prospective consumer has been named or approved. |
| 4 | Pass | JavaScript packages are private `0.1.0`; Rust crates have `publish = false`; package-contract tests lock the boundary. |
| 5 | Pass for the candidate | The technical precursor and exact frozen 0.1.0 candidate passed both clean target lanes; the status declaration retains the same exact gate. |
| 6 | Pass | Private archive identity/retention and the implemented sanitizer workflow preserve originals. Real sanitization remains approval-gated. |

## Exit-criterion audit before integration preparation

| # | Result | Evidence or blocker |
| --- | --- | --- |
| 1 | Pass | The first private 0.1.0 API/order/union policy is frozen in `private-api-freeze.md`, and its exact commit passed both lanes. |
| 2 | Pass | Stable structured errors replace message matching across all layers; retry policy derives from codes. |
| 3 | Pass | Immutable establishment state and callback-observed projection are implemented and race-tested without claiming live atomicity. |
| 4 | Pass | Runtime budget ownership, conflicts, sharing, provisional failure rollback, final joined release, and reconfiguration are implemented and tested. |
| 5 | Pass subject to the declaration gate | Both lanes passed the technical precursor and exact 0.1.0 freeze; recognition waits for the exact declaration commit's identical gate. |
| 6 | Pass for the selected delivery model | Controlled source build, exact naming, load failure behavior, and lockstep metadata/version validation are implemented. Future prebuild controls are documented but deliberately not implemented. |
| 7 | Pass by explicit scope rejection | Stable non-adversarial roots are supported; hostile roots require a separately approved fd-anchored redesign. |
| 8 | Pass | Candidate replacement is deterministically injected after capture and drain, across shared/new watch admission, during traversal, and before final validation with conservative cleanup and peer proof. |
| 9 | Pass for format/tooling; per-derivative approval remains | The sanitizer and public schema are complete and synthetic-tested. No real derivative has been authorized. |
| 10 | Blocked on separate approval | Architectural policy separation is documented and no integration occurred; no consumer-boundary approval or named-consumer proof exists. |

## Follow-up verification audit

| Required verification | Result |
| --- | --- |
| Clean install/build/load and environment teardown on every claimed target | Pass in both lanes for the exact frozen 0.1.0 commit. |
| Compiled TypeScript consumer fixtures | Pass locally on exact Node 24.18.0 with TypeScript 6.0.3; wired into both CI lanes. |
| Structured error contracts | Pass across invalid arguments, conflicts, backpressure, interruption, disposal, unavailable roots, and internal failures. |
| Snapshot/batch ordering | Pass for baseline initialization, pre-resolution seam, update-before-callback, callback exception, and acknowledgement-leading-observation cases. |
| Repeated replacement, peers, exclusions, limits, and disposal overlap | Pass: large direct/ancestor recovery, shared old/new identities, peer survival, and every materially distinct candidate-validation barrier are covered. |
| Churn, descriptor lifetime, deferred promotion, callbacks, and cleanup soak | Pass as combined evidence: deterministic reuse/exhaustion/gap unit tests plus 25 live bounded cycles returning exact runtime and near-baseline `/proc` resources. |
| Chosen delivery packaging failures | Pass for controlled source build: clean target install/build/load and unsupported/missing/load/version/API mismatch tests pass. No prebuild checksum behavior exists because prebuild delivery is not selected. |
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
so exact local Node/Rust/tooling results did not promote the Ubuntu 24.04
target. Promotion rests on the hosted exact-commit evidence below.

## Hosted qualification evidence

- Deterministic identity-barrier commit
  [`243f4e3db736576f3b34fcb716b336a51b70a92f`](https://github.com/gadicc/watchbound/commit/243f4e3db736576f3b34fcb716b336a51b70a92f):
  [CI run 29827608740](https://github.com/gadicc/watchbound/actions/runs/29827608740),
  floor job `88624474044` and moving job `88624474174`, both passed.
- Exact private 0.1.0 freeze
  [`9af10f08f01fd15c0d2b39801b00420e65daed3c`](https://github.com/gadicc/watchbound/commit/9af10f08f01fd15c0d2b39801b00420e65daed3c):
  [CI run 29829260196](https://github.com/gadicc/watchbound/actions/runs/29829260196),
  floor job `88629760074` and moving job `88629760120`, both passed.

The freeze run used Ubuntu 24.04 x86_64, Linux 6.17.0-1020-azure, glibc 2.39,
Node 24.18.0, pnpm 10.33.2, Rust 1.88.0 in the floor lane, and Rust 1.97.1 in
the moving lane. Both jobs passed source-only checkout enforcement, controlled
0.1.0 build, TypeScript, tests, warnings-denied checks, bounded maintenance,
and 13/13 strict ordinary conformance with forced overflow disabled. They
uploaded no artifact, cache, package, prebuild, or evidence derivative.

## Final recommendation and reopen conditions

**Recognize Watchbound 0.1.0 as a maintained-unpublished package for the exact
target in `support-matrix.md` once this declaration's exact commit is green.**
Do not publish it, produce prebuilds, or begin consumer integration.

Re-audit the recommendation before any target expansion, incompatible private
API revision, delivery-model change, public evidence derivative, publication,
or consumer integration. A target consumer and boundary still require separate
approval before any integration work.

Publishing, package-visibility changes, prebuild production/distribution,
artifact upload, non-Linux backends, and consumer integration remain outside
this decision.
