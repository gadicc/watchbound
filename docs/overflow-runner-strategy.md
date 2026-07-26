# Forced-overflow runner strategy

Status: exact-candidate forced-overflow qualification runs on GitHub-hosted
Ubuntu 24.04 x64 and ARM64 virtual machines. This is native-architecture
correctness evidence, not benchmark evidence. The workflow records host state
and treats all timings as non-authoritative.

## Why hosted runners are sufficient here

The two forced-overflow scenarios are pass/fail conformance gates. A passing
trial must prove that the helper genuinely exceeded the kernel queue, the
native overflow counter advanced, coverage became explicitly uncertain with
`event-overflow`, delivery drained, the intended reconciliation path ran, a
post-recovery sentinel arrived, and all resources were restored. Neighboring
host activity can delay the helper or make a trial fail, but it cannot satisfy
those semantic checks and create a false pass.

Dedicated bare metal or a quiet self-hosted VM is still preferable before
recording publishable latency, throughput, or resource ranges. It is not
required for this correctness-only release gate. An Ubuntu container is not a
replacement for either hosted lane because it shares its host kernel and
architecture.

| Environment | Correctness qualification | Performance evidence |
| --- | --- | --- |
| GitHub-hosted `ubuntu-24.04` x64 | Yes | No |
| GitHub-hosted `ubuntu-24.04-arm` ARM64 | Yes | No |
| Ubuntu container on another host | No; shared host kernel | No |
| Prepared dedicated native host | Yes | Yes, after a separate quiet-host gate |

## Manual qualification workflow

The Release workflow has a guarded `workflow_dispatch` mode. A manual run has
repository-read permission only. It cannot receive the publication job's
write or OIDC permissions, and the publication job separately requires a
`push` event on `main` plus a positive semantic-release plan.

For each dispatch:

1. In GitHub Actions, open **Release** and select the exact candidate ref in
   **Run workflow**. For the current process this should be the reviewed `dev`
   tip.
2. Enter that ref's full lowercase 40-character SHA as `candidate_sha`. The
   planner rejects the dispatch unless the selected workflow ref, entered SHA,
   and checked-out SHA are identical.
3. Select exactly one scenario: `overflow-reconciliation` first, or
   `automatic-overflow-reconciliation` only after reviewing the first run.
4. Enter the positive attempt number for that scenario.
5. Type the acknowledgement exactly as
   `I ACKNOWLEDGE FORCED OVERFLOW <scenario> ATTEMPT <n>`, substituting the
   selected scenario and attempt.
6. Monitor both native target jobs and retain their artifacts regardless of
   outcome.

The equivalent CLI form for the first scenario is:

```sh
gh workflow run release.yml \
  --ref dev \
  -f candidate_sha=FULL_40_CHARACTER_DEV_SHA \
  -f scenario=overflow-reconciliation \
  -f attempt=1 \
  -f 'acknowledgement=I ACKNOWLEDGE FORCED OVERFLOW overflow-reconciliation ATTEMPT 1'
```

The workflow refuses GitHub's **Re-run jobs** path because it changes
`github.run_attempt`. If review authorizes a retry, create a new dispatch with
the incremented scenario attempt and matching acknowledgement. Failure or
completion never authorizes a retry or the other scenario by itself.

Run the scenarios in two dispatches:

1. `overflow-reconciliation`, attempt 1;
2. inspect both x64 and ARM64 evidence and the overall run; then
3. `automatic-overflow-reconciliation`, attempt 1.

## What the shared pipeline does

Qualification mode reuses the release pipeline rather than accepting an
ordinary CI binary:

1. validate the one-shot dispatch and create a non-release qualification plan;
2. run the reusable full CI workflow against the same exact SHA;
3. build each target twice in isolated Ubuntu 22.04 builders;
4. byte-compare and aggregate the canonical x64 and ARM64 addons;
5. exercise the canonical artifacts in every distro and Electron lane; and
6. exercise the canonical packages on the pinned real kernel-5.15 QEMU
   component while retaining native runners as the architecture evidence; and
7. run the one selected overflow scenario once on each native Ubuntu 24.04
   hosted architecture.

A normal release push uses the same canonical artifact path and runs both
overflow scenarios before publication. Monitoring is useful operationally,
but the safety boundary is the checked-in event, permission, exact-SHA, and
dependency guards.

## Retained evidence

The qualification-plan artifact contains the validated dispatch approval and
non-release plan. Each target's overflow artifact contains a preflight and, if
the scenario started, its raw conformance report. Upload runs even after a
failed preflight or scenario. Retention is 90 days.

The preflight verifies and records:

- exact Git SHA, package version, Cargo and pnpm lock hashes;
- independent-comparison record hash and canonical addon SHA-256/size;
- native architecture, Ubuntu 24.04, kernel, glibc, Node, and runner identity;
- inotify limits, filesystem/mount identity, blocks and inodes;
- load, memory, `vmstat`, CPU/I/O/memory pressure, governor, and process state;
- scenario, scenario-attempt number, intended report path, and the explicit
  correctness-only/non-authoritative-timing classification.

Raw reports can contain absolute temporary paths and detailed host state.
Treat GitHub artifacts as private evidence and follow
[`artifact-archival.md`](artifact-archival.md) before creating any committed or
public derivative.

## Interpreting outcomes

A green job is native correctness evidence for the exact SHA, architecture,
canonical artifact hash, scenario, and attempt recorded in its files. It is
not a performance result and does not transfer to a changed commit or binary.

A red job is retained evidence, not an automatic product failure. Classify
whether the failure is semantic, infrastructure, or environmental, and review
the artifact before authorizing a new dispatch. Never use a GitHub rerun to
erase or silently replace the first outcome.
