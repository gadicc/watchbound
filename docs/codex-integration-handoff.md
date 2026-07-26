# Codex Desktop Linux handoff

Status: qualified source matrix, pre-publication. The native, distro, Electron,
Nix, reproducibility, pinned-kernel, and both supervised-overflow scenarios are
green for x64 and ARM64, but do not enable or pin this candidate in Codex until
official immutable packages exist. The sibling repository was not modified.

## Package and loader contract

| Architecture | Exact npm package | Native file | Rust target |
| --- | --- | --- | --- |
| x64 | `@gadicc/watchbound-node-linux-x64-gnu` | `watchbound.linux-x64-gnu.node` | `x86_64-unknown-linux-gnu` |
| ARM64 | `@gadicc/watchbound-node-linux-arm64-gnu` | `watchbound.linux-arm64-gnu.node` | `aarch64-unknown-linux-gnu` |

Both routes also install `watchbound@<version>` and
`@gadicc/watchbound-node@<same-version>`. The loader selects exactly one local
target and verifies package metadata, SHA-256, ELF identity, binding metadata,
versions, Node-API, triple, and release profile. Capability schema 4 adds
`build.packagedTarget`, per-target qualification, and current-runtime matching;
the JavaScript subscription API is otherwise compatible.

## Registry coordinates not yet available

Because this task explicitly forbids publication, there are no official
tarballs for the multi-target candidate and therefore no truthful npm integrity, npm shasum, registry
tarball digest, ARM64 native SHA-256, or official URL to place in Codex's
artifact manifest. Expected registry URL forms after an approved publication
are:

```text
https://registry.npmjs.org/watchbound/-/watchbound-<version>.tgz
https://registry.npmjs.org/@gadicc/watchbound-node/-/watchbound-node-<version>.tgz
https://registry.npmjs.org/@gadicc/watchbound-node-linux-x64-gnu/-/watchbound-node-linux-x64-gnu-<version>.tgz
https://registry.npmjs.org/@gadicc/watchbound-node-linux-arm64-gnu/-/watchbound-node-linux-arm64-gnu-<version>.tgz
```

Treat those as coordinates, not existing artifacts. After publication, obtain
the exact `dist.tarball`, `dist.integrity`, and `dist.shasum` with
`npm view <package>@<version> --json`; download once, verify integrity, record the
tarball SHA-256 and the package-declared/computed native SHA-256, and pin all
four immutable packages. Never synthesize integrity from a local rehearsal.

## Codex changes after publication

1. Replace the single x64 Watchbound artifact record with wrapper, neutral
   loader, x64 target, and ARM64 target records in lockstep.
2. Select the target record from Codex's normalized `x64`/`arm64` Linux target;
   reject ARMv7 and musl. Do not add a fallback.
3. Remove the current x64-only staging rejection only after both target records
   contain official URL, npm integrity/shasum, tarball SHA-256, native path,
   and native SHA-256.
4. Stage the JS packages in `app.asar`, allow the `.node` file to be unpacked
   by the existing `{*.node,*.so,*.dylib}` ASAR rule, and retain the package
   directory relationship expected by Node resolution.
5. Read `capabilities.support.currentRuntime.supported`; do not infer support
   from `runtime`, successful load, or the legacy single-target fields.
6. Enable x64 only on exact green Ubuntu 22.04/24.04, Debian 12, Fedora 42,
   Arch, openSUSE, Electron, and release-artifact evidence. Enable ARM64 only
   after its applicable native lanes are green. Derivative families remain
   compatibility claims, not separately qualified lanes.
7. Keep ARMv7, musl, non-Linux, and unqualified families disabled.

For Nix, consume Watchbound's source/lock-based derivation pattern or vendor the
same locked source into the Codex flake; do not fetch npm during a derivation.
Re-enable the feature only after both `x86_64-linux` and `aarch64-linux` checks
run through Codex's actual Electron closure and Codex pins the exact Watchbound
source revision.

## Handoff blockers

- Kernel 5.15 floor evidence remains deliberately separate from native Ubuntu
  24.04 overflow correctness evidence; both components are complete.
- The npm target-name bootstrap is complete, but no official candidate package
  has been published.
- Publication, official integrity values, and Codex repository edits were
  explicitly outside this task's authority.
