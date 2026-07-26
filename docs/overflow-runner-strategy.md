# Forced-overflow runner strategy

Status: the release workflow now routes x64 and ARM64 canonical-artifact
overflow jobs only to prepared self-hosted runners carrying the
`watchbound-overflow` label. Provisioning, quiet-host confirmation, and active
supervision remain operator responsibilities; a label alone is not evidence.
The policy in [`benchmark-methodology.md`](benchmark-methodology.md) remains
authoritative.

## Recommendation

Use a dedicated baseline-compatible x64 or ARM64 VM/bare-metal self-hosted
runner for qualifying forced-overflow evidence. Keep GitHub-hosted runners for
ordinary CI, independent clean builds, and quick benchmark functionality
smoke.

An Ubuntu 24.04 Docker container can be useful as a non-qualifying packaging
and compatibility check, but it is not an Ubuntu host:

- it shares the host kernel, inotify configuration, CPU, memory, and I/O
  contention;
- on the current development machine it would still use the CachyOS kernel
  rather than the supported Ubuntu kernel line; and
- its working tree is normally overlay-backed unless the operator deliberately
  supplies another filesystem.

Docker can therefore catch distribution userspace, libc, dependency, build,
install, and import failures. It must not be presented as support
qualification, quiet-host performance evidence, or a substitute for the
supported host.

| Execution environment | Useful for | Qualifying overflow evidence |
| --- | --- | --- |
| GitHub-hosted Ubuntu 24.04 | CI, clean builds, ordinary conformance, quick benchmark smoke | No: neighboring host activity and readiness are not controlled |
| Ubuntu 24.04 container on another host | Ubuntu/glibc packaging and install smoke | No: host kernel, inotify limits, contention, and usually filesystem remain different |
| Dedicated Ubuntu 24.04 VM or bare-metal self-hosted runner | Exact-candidate supervised conformance | Yes, after identity, filesystem, quietness, and supervision checks pass |

## Proposed quiet-host gate

A future checker should poll measured activity rather than trust a fixed sleep.
Run the exact-candidate build first, allow an initial five-second cooldown, then
sample once per second for at most 60 seconds. Proceed only after ten
consecutive samples pass. If no quiet window appears, fail without starting the
overflow helper.

The first implementation can use these conservative starting thresholds; they
must be validated on the eventual runner before becoming policy:

| Signal | Proposed quiet condition |
| --- | --- |
| CPU busy | Below 20% during each sample |
| CPU I/O wait | Below 2% during each sample |
| Runnable queue | No sustained queue above the runner's expected idle level |
| Block devices | No request in flight and no material read/write burst |
| Swap | No swap-in or swap-out |
| I/O PSI | `full` is zero and `some` is below 1% |
| Memory PSI | `full` is zero |

Load averages should be retained as context, not used alone as the gate: their
decay makes them a poor signal for a newly quiet machine. Record the raw
`/proc/stat`, `/proc/diskstats`, `/proc/pressure/{cpu,io,memory}`, swap, load,
governor, active-process summary, filesystem identity, space/inodes, and
inotify limits for every sample window.

The retained preflight JSON should also name:

- exact Git SHA and source-input digest;
- package version and intended scenario;
- native artifact path, byte count, and SHA-256;
- Node, Rust, pnpm, kernel, distribution, glibc, and runner identity;
- cooldown, polling interval, maximum wait, consecutive-pass requirement, and
  thresholds; and
- the final pass/fail decision with every observed sample.

## Supervision and ordering

Quiet-host automation does not replace supervision. The operator sequence
remains:

1. verify the supported host, clean exact candidate, pinned toolchains, and
   independently approved native digest;
2. build, cool down, and pass the bounded quiet-host poll;
3. stop for approval naming SHA, version, native hash, scenario, attempt, and
   output path;
4. run the manual-reconciliation overflow scenario once and retain every
   outcome;
5. poll host quietness again;
6. stop for a second approval; and
7. run the automatic-reconciliation scenario once.

Neither failure nor completion authorizes a retry or the other scenario.

## Possible future automation

If a dedicated runner becomes available, keep overflow evidence in a separate
operator-triggered workflow or host-side command. A workflow must target
explicit labels such as `self-hosted`, `linux`, `x64`, `ubuntu-24.04`, and
`watchbound-quiet`, with no GitHub-hosted fallback. It should upload the private
preflight and conformance artifacts even on failure, but must not publish
packages or broaden the `main`-push release authorization boundary.

Adding such an operator-triggered workflow would be a deliberate exception to
the repository's current no-manual-dispatch configuration and requires a new
maintainer decision. Until then, use the documented host-side supervised
commands.

An optional Docker smoke could instead be automatic and non-gating. Pin the
Ubuntu image by digest, use isolated container-owned caches and build output,
prefer a container tmpfs for bounded filesystem checks, and label every result
as container compatibility evidence rather than host qualification or
performance data.
