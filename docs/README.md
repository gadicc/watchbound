# Watchbound documentation

This index groups Watchbound's design, contract, qualification, evidence, and maintenance records by reader task.

## Start with the public contract

- [Architecture and decision record](architecture.md): project boundary, semantic model, ownership, and implemented decisions
- [API and lifecycle](api-lifecycle.md): establishment, delivery, exclusions, recovery, and joined disposal
- [Structured errors](error-contract.md): stable `WATCHBOUND_*` codes, operations, and retry conditions
- [Runtime and root qualification](runtime-qualification.md): target, host, environment, and filesystem evidence
- [Support matrix](support-matrix.md): supported native targets, tested runtime lanes, and promotion requirements
- [Security and path threat model](security-threat-model.md): protected properties and out-of-scope adversaries

## Evaluate correctness and performance

- [Benchmark and conformance methodology](benchmark-methodology.md): adapters, scenarios, measurements, host preparation, and commands
- [Benchmark results](benchmark-results.md): retained measurements, artifacts, host state, ranges, and caveats
- [Conformance findings](conformance-findings.md): reproduced behavior and capability conclusions
- [Benchmark harness guide](../benches/README.md): local commands and report accounting
- [Overflow runner strategy](overflow-runner-strategy.md): guarded forced-overflow qualification and interpretation
- [Correctness artifact archival](artifact-archival.md): private raw evidence and public derivative rules

## Understand implementation boundaries

- [Node binding](node-binding.md): napi-rs ownership, native loading, identity, and lifecycle
- [Native delivery](native-delivery.md): loader selection, package roles, artifact controls, and unsupported targets
- [Symlink root contract](symlink-root-contract.md): lexical and physical root identities
- [Root recovery decision](root-replacement-follow-up.md): explicit identity-policy-gated replacement recovery
- [Callback contract review](callback-contract-review.md): delivery admission, completion, failure, and teardown hazards
- [Private API revision history](private-api-freeze.md): exported surface and compatibility decisions

## Follow native qualification and integration work

- [Native matrix migration](native-matrix-migration.md): architecture-neutral loader and target package plan
- [Native matrix reviews](native-matrix-design-review.md): design and adversarial implementation findings
- [Local native matrix evidence](local-native-matrix-evidence.md): local artifact inspection and package checks
- [Qualification evidence](qualification-evidence-2026-07-26.md): retained x64 and ARM64 qualification record
- [Platform audit](platform-audit.md): Codex Desktop Linux runtime and packaging boundary
- [Codex integration handoff](codex-integration-handoff.md): consumer-side requirements and remaining gates

## Maintain and release

- [Contributing](../CONTRIBUTING.md): local setup, tests, documentation invariants, and benchmark safety
- [Maintenance policy](maintenance-policy.md): ownership, compatibility, ordinary change gates, and release gates
- [Release runbook](releasing.md): exact candidate qualification, publication, and post-release verification
- [Release incident response](release-incident-response.md): containment, registry actions, communication, and recovery
- [Consumer and API stabilization](consumer-api-stabilization.md): feasibility decision history and reopen conditions
- [Migrate runtime qualification](migrate-root-qualification.md): migration from target compatibility to `qualifyRoot()`
