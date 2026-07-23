# Native delivery contract

Status: controlled source build selected for the maintained-unpublished
package. No prebuilt artifact, publication, upload, or install-time fallback
is authorized.

## Current decision

Watchbound is built from the checked-in Rust workspace in a controlled checkout
after a frozen pnpm install. The only loadable native basename is:

```text
watchbound.linux-x64-gnu.node
```

The build uses pinned `@napi-rs/cli` 3.7.3 with a release profile and `--no-js`.
It may generate the ignored `node/native.generated.d.ts` for inspection, but
`node/index.js`, `node/index.d.ts`, and `node/load-native.cjs` are hand-owned.
The workspace build compares those files before and after native generation,
requires the expected addon, and loads it through the production handshake.

There is deliberately no `preinstall`, `install`, or `postinstall` hook. The
runtime loader does not compile, download, search optional packages, honor a
native-library environment override, or fall back to WASI. A missing local
addon is an actionable `WATCHBOUND_NATIVE_NOT_BUILT` failure rather than an
implicit network or toolchain operation.

## Load and identity checks

Before `require()` reaches native exports, the loader requires Linux x64,
detected glibc, and process Node-API 6 or newer. It then loads only the exact
local basename and validates:

- metadata schema version 1 and binding API version 2;
- identical native, engine, and native-package versions;
- addon Node-API floor 6;
- target triple `x86_64-unknown-linux-gnu`;
- release build profile.

The JavaScript wrapper separately asserts its version against the native
package. Mismatches fail closed; there is no best-effort compatibility mode.
Import-time loader error messages and causes are byte-bounded, and the absolute
addon path is removed from the retained cause. Loader codes are a packaging
contract distinct from subscription operation errors.

The loader's platform checks establish only that the addon is loadable in a
compatible family. The exact maintained support claim remains the narrower
matrix in [`support-matrix.md`](support-matrix.md) and requires clean target
evidence.

## Clean source-build gate

A qualifying clean job must:

1. start from a checkout containing no `.node` or `.so` artifact;
2. assert the exact OS, architecture, libc, kernel floor, Node, Rust, pnpm,
   compiler, and linker facts;
3. install only from the committed lockfile;
4. produce only `node/watchbound.linux-x64-gnu.node` from source;
5. prove native generation did not modify hand-owned entry files;
6. load the addon through the production metadata/version handshake;
7. run TypeScript fixtures, tests, repository checks, real environment
   teardown, bounded maintenance/root-recovery stress, and strict ordinary
   conformance serially.

The recorded qualification runs in `support-matrix.md` completed this source-
build gate. A workflow file or a successful build on a different host cannot
widen the supported target.

## Requirements before any future prebuild proposal

Prebuild work requires fresh approval before configuration or artifact
production. A reviewed proposal must define, for every target:

- an explicit OS/distribution, architecture, libc, kernel, Node range, and
  Node-API matrix backed by clean tests;
- an unambiguous artifact name derived from package version and target identity,
  with no fallback to a nearby target;
- lockstep wrapper, native package, engine, binding API, metadata schema, and
  artifact version validation;
- a SHA-256 checksum manifest whose own identity and retention policy are
  recorded;
- build provenance tying source commit, lockfiles, Rust toolchain, target,
  compiler/linker, runner image, and build command to each artifact;
- an SPDX or CycloneDX SBOM covering Rust, JavaScript build tooling, and the
  native binary;
- signing or verifiable attestation, trust-root ownership, rotation, expiry,
  revocation, and offline verification policy;
- reproducibility checks from at least two clean builders, with documented and
  reviewed explanations for any unavoidable byte differences;
- binary inspection, exported-symbol/Node-API checks, size limits, malware
  scanning, and target-specific load/teardown tests;
- a loader decision for checksum or signature failure that fails closed and
  never silently compiles, downloads another target, or selects an older
  artifact;
- staging, retention, rollback, incident response, and release-approval
  ownership.

No item in this section authorizes implementing that machinery, producing an
artifact, uploading it, changing package visibility, publishing, or integrating
a consumer.
