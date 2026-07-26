# Native matrix qualification evidence: 2026-07-26

Status: reviewed non-release evidence for candidate
`ecc593a87a006affa19868f31f488968ba723cc4`. This record does not promote a
target, publish a package, or expose the raw supervised-overflow reports.

## Exact candidate runs

- [Canonical `dev` CI run 30205322444](https://github.com/gadicc/watchbound/actions/runs/30205322444)
  completed the native x64/ARM64 source suites, pinned distro lanes, exact
  Electron lanes, and locked Nix closures.
- [Supervised overflow-reconciliation run 30205432027](https://github.com/gadicc/watchbound/actions/runs/30205432027)
  completed the reusable CI pipeline, two-builder release artifacts, every
  release distro/Electron lane, and the one-shot overflow scenario. The native
  jobs were [x64](https://github.com/gadicc/watchbound/actions/runs/30205432027/job/89802697761)
  and [ARM64](https://github.com/gadicc/watchbound/actions/runs/30205432027/job/89802697707).
- [Supervised automatic-overflow-reconciliation run 30205594436](https://github.com/gadicc/watchbound/actions/runs/30205594436)
  repeated the canonical pipeline and completed the separately authorized
  automatic scenario. The native jobs were
  [x64](https://github.com/gadicc/watchbound/actions/runs/30205594436/job/89803148511)
  and [ARM64](https://github.com/gadicc/watchbound/actions/runs/30205594436/job/89803148505).

Both dispatches ended at the read-only `Manual qualification verified` gate.
The publication and registry jobs were skipped by design. Hosted-runner timing
is non-authoritative.

## Canonical native identities

Both scenario runs reproduced the same target bytes independently. Static ELF
version inspection found a maximum requirement of `GLIBC_2.34` for each
artifact, below the configured glibc 2.35 ceiling.

| Target | Bytes | Native SHA-256 | Maximum GLIBC |
| --- | ---: | --- | --- |
| `linux-x64-gnu` | 1,406,728 | `1d129f9db602e0188949a8fef3f1dc0af405f25a591abeff346edd49342cd5f0` | `GLIBC_2.34` |
| `linux-arm64-gnu` | 1,214,176 | `17f5d5d05721ec946a7afc8f117d00326ea5339bbf8fd6d79086294cad7b11d7` | `GLIBC_2.34` |

The independent comparison record was
`5869a49d675c808d7afbf8175fa1a5aa34225268aff9491eb929eac1be395a62`
in run 30205432027 and
`a3399039bad568a468bd3679e7c670b8b9d2465cdf97cdb5e560dd42ff21fe1c`
in run 30205594436. Both builders used native Ubuntu 22.04/glibc 2.35 runner
labels. Their retained build manifests recorded kernel
`6.8.0-1062-azure`; the supervised overflow jobs used the configured native
Ubuntu 24.04 runner labels. Detailed overflow host state remains only in the
private raw preflight artifacts under the repository archival policy.

The GitHub artifact-service digests for the retained overflow bundles were:

| Scenario | x64 bundle | ARM64 bundle |
| --- | --- | --- |
| manual reconciliation | `sha256:c577a928989572e8d29424e51d987e84c08929ac552086b642e420a868db2e2c` | `sha256:92d383c46e6fa63ec3d369dd47d75aa9a25fa50be766939fd3830e7c91ce2eac` |
| automatic reconciliation | `sha256:b24ca918ef8832a788db8d6a0be5f873a34c95bb56f870479494002071a13e38` | `sha256:311c71ddebc974a82baa80d502a316a7ad12b51a5fedfd3f47f4e24a7e9e6968` |

## Remaining claim boundary

These runs did not execute on the advertised kernel 5.15 floor. Ubuntu
containers share the newer hosted-runner kernel, so their labels cannot fill
that gap. The matrix therefore remains `target-pending-clean-ci`.

The follow-up kernel component boots Canonical's checksum-pinned
`5.15.0-185-generic` x64 and ARM64 kernels under bounded QEMU, combines them
with the pinned Ubuntu 22.04/glibc 2.35 userspace, installs the exact local
packages offline, and runs the production loader/filesystem/lifecycle smoke.
It is deliberately labeled kernel-floor evidence only. Target architecture
qualification still comes from the separate native runner matrix, so QEMU is
never the sole support basis.

Promotion requires a future exact status-bearing commit to pass that kernel
component, the complete native matrix, and both separately supervised overflow
scenarios. Upstream action Node-runtime deprecation annotations on the reviewed
runs were informational and did not weaken a gate.
