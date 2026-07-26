# Native matrix design and adversarial reviews

## Pre-implementation design review

The accepted design makes the wrapper and loader architecture-neutral and puts
one ELF in each exact optional target package. A single checked-in JSON matrix
drives target names, triples, filenames, CI lanes, Electron pins, capabilities,
and generated manifests. Nix builds from source instead of importing registry
ELFs.

Adversarial findings resolved before implementation:

- A combined multi-architecture package could let an extra or nearby ELF be
  selected. Target packages contain exactly one verified `.node` file.
- Optional dependencies could hide a missing exact target. The loader returns a
  stable missing-target error and never falls back.
- A cross-build could accidentally become “supported.” Qualification requires
  native target execution; QEMU-only evidence is not promoted.
- Existing support fields could silently change meaning. Schema 4 retains them
  as `legacy-primary-target` and adds explicit target/runtime fields.
- A newer builder would leak a newer glibc ABI. Registry builders use Ubuntu
  22.04 and release inspection audits actual `GLIBC_*` symbols.
- Reusing a registry ELF in Nix could be impure or require patching. The Nix
  route builds from locked source and tests its own closure.
- ARMv7 and musl mappings could be mistaken for complete support. Both remain
  explicit exclusions.

## Post-implementation adversarial review

The review traced generated package identity, loader filesystem operations,
workflow artifact flow, semantic-release partial states, ASAR paths, Nix
inputs, and every support statement.

Resolved findings:

- Restored the pre-existing moving Node/Rust lane, strict ordinary conformance,
  maintenance stress, and quick benchmark smoke so matrix expansion does not
  weaken existing gates.
- Added explicit Ubuntu 22.04/glibc 2.35/native-architecture assertions to the
  source and independent-builder jobs.
- Required two builders, byte identity, exact target/triple/architecture/file,
  byte count, SHA-256, and two retained builder records before the publication
  plugin accepts an aggregate artifact.
- Added exact Node 24 range, package manifest/hash, regular-file, one-addon,
  bounded-size, and ELF-machine checks before native load.
- Added ELF dynamic allowlist, RPATH/RUNPATH rejection, GLIBC version audit,
  stripped-section policy, and Node-API symbol policy to release evidence.
- Made registry publication target-first and reject loader/wrapper states with
  missing target versions; exact existing npm integrity and metadata are
  rechecked.
- Added release-artifact distro and Electron ASAR jobs plus canonical overflow
  jobs on native GitHub-hosted Ubuntu 24.04 x64/ARM64 runners instead of relying
  on ordinary source-build artifacts; the checked-in target matrix selects each
  exact runner label and the timings are explicitly non-authoritative.
- Corrected Nix CI to assert the native runner system and build the locked
  current-system flake without updating its lock, and pinned the Nix installer
  action to an exact reviewed commit.
- Removed pending-status assumptions from the installed-package smoke so the
  checked-in matrix remains the only qualification-state source during an
  eventual reviewed promotion.
- Synchronized the native matrix declaration with the returned overflow-runner,
  Codex Electron archive, and ELF inspection fields so typed consumers do not
  receive a narrower contract than runtime consumers.
- Extended installed-package smokes with initial/dynamic exclusions,
  reconciliation, root replacement/recovery, callback serialization,
  cancellation, stop, joined disposal, and resource return.
- Removed stale `1.1.0`/single-target claims from the principal architecture,
  API, delivery, support, release, maintenance, README, and skill documents.

Explicitly blocked rather than waived:

- native ARM64 build/runtime, ARM64 Electron, and ARM64 Nix execution;
- both Nix closures, because Nix is unavailable on the local workstation;
- pinned distro jobs and genuine kernel 5.15 evidence;
- release-canonical forced-overflow evidence (not run casually locally);
- official tarball URLs/integrity and Codex pins, because publication and Codex
  mutation were forbidden; and
- target promotion, which changes to `supported` only when the exact
  status-bearing commit completes all gates.
