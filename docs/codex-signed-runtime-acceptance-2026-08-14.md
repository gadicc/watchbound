# Codex signed-runtime acceptance — 2026-08-14

This is the historical acceptance record for candidate `1305e2a`, whose
loader still depended on a consumer-supplied report shim. Later source removes
that dependency, but requires a new exact-candidate signed-runtime run before a
Codex integration may remove the shim.

## Verdict and scope

Watchbound candidate `1305e2af15853749d12fe06ef9cb370e3bd18800`
passed the consumer-owned signed Linux x64 acceptance suite across three cold
processes. The suite's original aggregate label said
`failed-expected-runtime-identity` only because the supplied expectation for
`process.versions.electron` was wrong; every Watchbound loader, lifecycle,
qualification, cleanup, and negative-integrity assertion passed.

This is consumer integration evidence, not a Watchbound CI lane and not a
claim about ARM64. It binds only the named Watchbound source commit, signed
executable digest, and candidate native digest. A later release candidate must
be rebound to its exact source SHA under the consumer's evidence policy.

## Exact identities

| Item | Observed identity |
| --- | --- |
| Watchbound source | `1305e2af15853749d12fe06ef9cb370e3bd18800` |
| Signed executable SHA-256 | `0f199039694c663fa61ffef73e0efaf05bb774341a63a1db9fa32055432005d4` |
| Platform | Linux x64, kernel 7.1.5-arch1-2, glibc 2.44 |
| `process.versions.electron` | `151.0.7922.137` |
| `process.versions.node` | `24.14.0` |
| `process.versions.napi` | `10` |
| Target | `@gadicc/watchbound-node-linux-x64-gnu@0.0.0-development` |
| Native triple | `x86_64-unknown-linux-gnu` |
| Native SHA-256 | `e6fc8033ca7efbd23890d401bff9945887f33e4aec6149b6823e77c15faa79bb` |

Electron 42.3.0 was present as an application package dependency, but Owl
reported 151.0.7922.137 for both its Electron and Chrome process-version
fields. The acceptance suite recorded Electron, Node, and Node-API separately
and did not infer one from another.

The executed ELF was byte-identical to the extracted signed OpenAI executable.
The hybrid test preserved the official ASAR main entrypoint and inserted the
candidate packages and validation hook. The production loader selected the one
expected x64 package and loaded its matching unpacked `.node` file without a
fallback.

## Results

The loader admitted Node `>=18.15.0` without an upper bound and retained the
Node-API 6, kernel 5.15, glibc 2.35, ELF, target, digest, metadata schema 1,
binding API 5, raw capability schema 5, public capability schema 9, release
profile, and package/native/engine version gates.

Each cold process passed:

- package import, exact native selection, and inactive engine creation;
- complete initial observation and create/change/delete delivery;
- initial, dynamic, directory-name, and observed-boundary exclusions;
- reconciliation and stable replacement recovery;
- establishment cancellation and callback-context stopping;
- concurrent, repeated, joined disposal with no callback after resolution;
- return to zero Watchbound inotify instances, worker threads, native watches,
  subscriptions, and deferred interests; and
- normal exit with no terminating signal.

Process-level Watchbound thread and inotify-descriptor counts returned to their
respective baselines in all three iterations. `qualifyRoot()` returned
`qualified` for the real Codex workspace root each time. A tampered native file
failed cleanly with `WATCHBOUND_NATIVE_INTEGRITY_MISMATCH`.

## Required Owl report shim

The Codex route's existing Owl-safe `process.report` shim remained necessary.
Calling Owl's native `process.report.getReport()` directly caused `SIGILL`, so
there is no JavaScript exception for Watchbound to catch. The consumer must
install the shim before importing Watchbound and must retain its trustworthy
glibc family/version evidence. This requirement is independent of the removed
Watchbound 2.1.1 Node-range metadata workaround; adopting the new packages
removes that workaround but does not remove the Owl shim.

## Remaining limitation

No signed ARM64 executable or ARM64 execution environment was available.
Signed ARM64 acceptance is therefore untested, not failed. Watchbound's native
ARM64 Node and stock-Electron qualification remains separate evidence and does
not substitute for a consumer-owned signed ARM64 run.

The full raw logs and generated JSON remain consumer-owned because they embed
paths and signed-application execution details. Codex should retain a durable,
sanitized record rather than relying on the original temporary-directory
artifacts.
