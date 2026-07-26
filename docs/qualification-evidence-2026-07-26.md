# Native matrix qualification evidence: 2026-07-26

Status: reviewed non-release evidence through closing candidate
`361562d60e79a6337b0b19cbd3c163ea999ac6b3`. This record supplies the basis
for a deliberate source-matrix promotion. It does not publish a package or
expose the raw supervised-overflow reports.

## Pre-kernel candidate runs

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

## Closing candidate and kernel-floor runs

- [Canonical `dev` CI run 30213989948](https://github.com/gadicc/watchbound/actions/runs/30213989948)
  qualified exact candidate `361562d60e79a6337b0b19cbd3c163ea999ac6b3`.
  The first attempt completed every native, distro, Electron, and kernel lane;
  its x86_64 Nix fetch received transient crates.io HTTP 403 responses. The
  isolated failed-job retry passed without a source change. The pinned-kernel
  jobs were [x64](https://github.com/gadicc/watchbound/actions/runs/30213989948/job/89825057184)
  and [ARM64](https://github.com/gadicc/watchbound/actions/runs/30213989948/job/89825057182).
- [Supervised overflow-reconciliation run 30214244941](https://github.com/gadicc/watchbound/actions/runs/30214244941)
  completed the full read-only canonical release pipeline and the manual
  scenario. The native overflow jobs were
  [x64](https://github.com/gadicc/watchbound/actions/runs/30214244941/job/89825665737)
  and [ARM64](https://github.com/gadicc/watchbound/actions/runs/30214244941/job/89825665614).
- [Supervised automatic-overflow-reconciliation run 30214675101](https://github.com/gadicc/watchbound/actions/runs/30214675101)
  independently repeated the full pipeline and automatic scenario. The native
  overflow jobs were
  [x64](https://github.com/gadicc/watchbound/actions/runs/30214675101/job/89826817998)
  and [ARM64](https://github.com/gadicc/watchbound/actions/runs/30214675101/job/89826817999).

Both closing dispatches ended at `Manual qualification verified`; publication
and registry jobs were skipped by the read-only plan. Their downloaded private
reports recorded clean exact source SHA-256
`684a7bd8a2343a3d6312c3a1fdbb2f269f105d4ab5d43045f4abd81c73bb5238`,
one induced overflow per architecture, one passed run, 45 passing checks, no
failed checks, no async or cleanup errors, scan progress on the original
subscription, and complete coverage after reconciliation.

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

The GitHub artifact-service digests for the retained pre-kernel overflow
bundles were:

| Scenario | x64 bundle | ARM64 bundle |
| --- | --- | --- |
| manual reconciliation | `sha256:c577a928989572e8d29424e51d987e84c08929ac552086b642e420a868db2e2c` | `sha256:92d383c46e6fa63ec3d369dd47d75aa9a25fa50be766939fd3830e7c91ce2eac` |
| automatic reconciliation | `sha256:b24ca918ef8832a788db8d6a0be5f873a34c95bb56f870479494002071a13e38` | `sha256:311c71ddebc974a82baa80d502a316a7ad12b51a5fedfd3f47f4e24a7e9e6968` |

The closing candidate's retained overflow bundle digests were:

| Scenario | x64 bundle | ARM64 bundle |
| --- | --- | --- |
| manual reconciliation | `sha256:a8d54616dedfb8d8c09ff669314aba50bd5ed7be166d8adf489b70538c0705f8` | `sha256:3a6560fc70e811bc36ea3d9d99bd9ac3ffe7887e59f42c5948215b68fb2dcf9a` |
| automatic reconciliation | `sha256:0bf65b26d00a070aa3b9d0a032a85e2699680bf86e45e23b8b26e1cffd9a4a5a` | `sha256:626de1a54dde85b0a2e4db3da5c146ef6895a628cf7c1a952b175af6219a1e18` |

The canonical CI kernel artifacts booted Canonical
`5.15.0-185-generic` with pinned Ubuntu 22.04/glibc 2.35 userspace. The x64
evidence bundle digest was
`sha256:4f5416f7932d65bda7161f982b25c865b39813935957c698ef8ba819b5725ee0`;
the ARM64 digest was
`sha256:802a32e4472adc5d65be0af27044ea7975c0405752c9c2cd77e22e2de5c3a5d7`.
Both installed the exact local packages, loaded the production binary, ran
real filesystem and lifecycle checks, and returned status `passed`.

## Closed claim boundary and promotion invariant

The earlier `ecc593a` runs did not execute on the advertised kernel 5.15 floor.
Ubuntu containers share the newer hosted-runner kernel, so their labels could
not fill that gap. Closing candidate `361562d` executed the pinned real kernel
component on both architectures and repeated the native and supervised matrix.

The follow-up kernel component boots Canonical's checksum-pinned
`5.15.0-185-generic` x64 and ARM64 kernels under bounded QEMU, combines them
with the pinned Ubuntu 22.04/glibc 2.35 userspace, installs the exact local
packages offline, and runs the production loader/filesystem/lifecycle smoke.
It is deliberately labeled kernel-floor evidence only. Target architecture
qualification still comes from the separate native runner matrix, so QEMU is
never the sole support basis.

The deliberate status-bearing commit must itself pass the kernel component,
complete native matrix, and both separately supervised overflow scenarios; the
closing candidate evidence authorizes that promotion but does not waive its
exact-commit follow-up. Upstream action Node-runtime deprecation annotations on
the reviewed runs were informational and did not weaken a gate.
