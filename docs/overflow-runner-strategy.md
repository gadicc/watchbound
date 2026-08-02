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

### Recoverable qualification guide

Use the repository guide instead of manually reconstructing inputs and prior
steps:

```sh
pnpm release:qualify
```

When the guide discovers an active exact-candidate run, its suggested watch
command polls GitHub until that run completes and then reconstructs the full
qualification state automatically:

```sh
pnpm release:qualify -- watch
```

The watch pins the candidate SHA before polling, so a concurrent `dev` update
cannot redirect the completion check to different source. Interrupting it is
safe: rerunning either the status or watch command recovers from GitHub state.
It never accepts a conditional rerun or dispatches another gate automatically;
those maintainer decisions remain explicit.

The guide resolves the current remote `dev` SHA, lists only Release workflow
dispatches for that exact commit, downloads their retained
`watchbound-qualification-plan` approval records, cross-checks any native
overflow artifact names, and reports the next safe action. It does not keep a
local step counter, so reopening it after a shell restart or midway through a
run reconstructs the same state from GitHub. `--json` emits the complete state
for another read-only tool.

Dispatch remains an explicit command. For example, the first gate is:

```sh
pnpm release:qualify -- dispatch \
  --scenario overflow-reconciliation \
  --attempt 1
```

After that run completes, rerun the status command and review the complete run
and both native artifacts. The suggested automatic-scenario command includes
`--reviewed-run <id>`; the guide refuses to dispatch without that explicit
review record. A failed attempt likewise requires review of the prior run and
an incremented scenario attempt unless one diagnostic rerun meets the
conditional-acceptance policy below. It refuses duplicate scenario attempts,
overlapping dispatches, skipped attempt numbers, stale candidate refs, and
runs whose approval identity is not yet available.

GitHub's **Re-run failed jobs** action keeps the same workflow run ID and
scenario-attempt input while incrementing `github.run_attempt`. The latest run
summary can therefore become green even though it combines jobs from multiple
workflow attempts. The guide reports a successful second workflow attempt
with complete x64 and ARM64 artifacts as a conditional pass. It offers two
explicit paths after review:

- classify every first-attempt failure as infrastructure or environmental,
  then continue with both `--reviewed-run <run-id>` and
  `--accept-rerun <run-id>`; or
- require a clean new scenario attempt using the next scenario-attempt number.

Conditional acceptance is limited to workflow attempt 2. A further rerun,
missing native evidence, conflicting identity, semantic or conformance
failure, or unexplained failure requires a clean scenario attempt instead.
For a conditional candidate, the guide automatically downloads the two
workflow-attempt job records, the original failed-step logs, and both native
overflow artifacts into temporary directories. It accepts the automated review
only when all of these checks pass:

- every original failed job is an allowlisted kernel-5.15 QEMU component and
  its only failed step is the kernel exercise;
- each failed target has a target-specific QEMU `ETIMEDOUT` signature and the
  failed logs contain no known assertion, semantic, or conformance signature;
- workflow attempt 2 completed successfully, contains no failed or cancelled
  job, and every originally failed job passed there;
- both native preflights approve the exact candidate, scenario, scenario
  attempt, target, GitHub run, and original workflow attempt (the overflow
  gates passed before the unrelated kernel jobs were retried);
- both strict conformance reports contain exactly one passing trial, no
  exclusions/errors/skips, all recorded semantic checks passing, and the same
  canonical artifact hash as their preflight.

Temporary evidence is removed after inspection. A failed or unavailable check
is reported by name and disables `--accept-rerun`; `--json` includes every
check and detail. When all checks pass, the guide presents exactly two lettered
dispatch paths. Choose one; they are alternatives, not a command sequence.

For a first-attempt failure, the guide also offers
`gh run rerun <run-id> --failed` as an optional diagnostic. GitHub reruns
failed jobs and their dependents, rather than individual test cases. Use this
to distinguish a repeatable defect from environmental or emulation variance;
it does not erase the original result or automatically qualify the run. Once
requested, let the diagnostic rerun finish and reload the guide so the
automated review can inspect both attempts. Skip the diagnostic command when
the failure is already sufficiently classified.

The guide deliberately qualifies the remote ref, not uncommitted local files.
A dirty local worktree is reported but does not alter GitHub's exact source.
Conversely, committing or pushing the guide itself creates a new candidate SHA;
manual evidence for an earlier SHA does not transfer.

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

The workflow validator rejects a rerun of the qualification-plan job. When
only failed downstream jobs and their dependents are rerun, the guide detects
the increased API attempt and applies the conditional-acceptance policy above.
If review does not classify every original failure as infrastructure or
environmental, create a new dispatch with the incremented scenario attempt and
matching acknowledgement. Failure or completion never authorizes a retry or
the other scenario by itself.

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
