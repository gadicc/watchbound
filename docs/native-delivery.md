# Native delivery contract

Status: source checkouts remain controlled builds. The public `0.0.1` npm/JSR
bootstrap is an explicit one-target bundled native package. The prospective
`1.0.0` async-callback candidate commits its exact version and support
declaration, but remains unpublished and is not recognized as qualified until
its own exact-SHA gates pass.

## Current decision

Watchbound development is built from the checked-in Rust workspace in a
controlled checkout after a frozen pnpm install. The only loadable native
basename is:

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

Release-package validation copies that exact locally built addon into
`@gadicc/watchbound-node` and smoke-tests the wrapper against it. The package
manifest is the source of truth for delivery:

- workspace/source manifests use `controlled-source-build`, and capabilities
  report `prebuilt: false`;
- generated npm and JSR manifests use `bundled-native-package`, and
  capabilities report `prebuilt: true`.

The wrapper and native package require matching versions and matching delivery
identities before loading. This closes the earlier capability-reporting
mismatch without implying support for another target or an install-time build.

## Load and identity checks

Before `require()` reaches native exports, the loader requires Linux x64,
detected glibc, and process Node-API 6 or newer. It then loads only the exact
local basename and validates:

- metadata schema version 1 and binding API version 3;
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

## Bundled native release controls

The `0.0.1` bundled-native bootstrap received explicit release approval.
Later releases still require the documented approval boundary. For the sole
target, the implementation now provides:

- exact target basename and package `os`, `cpu`, `libc`, and Node constraints;
- lockstep wrapper/native/engine/binding metadata and delivery validation;
- a SHA-256 checksum manifest and deterministic release metadata;
- a CycloneDX 1.6 SBOM covering the npm boundary and Rust dependency graph;
- npm and JSR OIDC provenance after the one-time interactive local bootstrap;
- two isolated clean Ubuntu 24.04 builders whose transferred native binaries
  are re-hashed and byte-compared, plus same-runner repetition as defense in
  depth;
- ELF class/architecture, dynamic-library allowlist, RPATH/RUNPATH absence,
  stripped-symbol status, Node-API export, maximum-size, tarball allowlist,
  load, and teardown checks;
- a `main`-push semantic-release boundary, non-publishing manual rehearsal,
  immutable-version registry checks, and an incident-response runbook.

The following requirements are stable-release gates:

- exact-commit green evidence on both supported CI lanes;
- exact SHA-256 and byte identity from two independent builders, with any
  mismatch failing closed rather than being waived;
- fresh supervised manual and automatic forced-overflow evidence for the exact
  candidate SHA, version, and independently approved native digest;
- maintainer acceptance that the single Ubuntu 24.04 x64/glibc 2.39 artifact is
  the entire public support promise;
- production-blocker resolution; and
- immediate post-publication exact npm and JSR Node-route registry-install
  smoke, with immutable-version incident response on failure.

There is no runtime checksum/signature lookup because the addon is already
inside the immutable npm package whose registry provenance and tarball digest
are verified before installation. The loader fails closed: it never downloads,
compiles, selects a nearby target, or falls back to an older artifact.
