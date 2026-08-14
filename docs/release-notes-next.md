# Draft next patch release notes

These are draft notes for the next semantic-release patch. They do not assign a
version, publish packages, create a tag, or authorize a release.

## Fixed

- Accept Node 24.14.0, including Electron hosts that embed it, when every
  platform, artifact, JavaScript-floor, Node-API, metadata, and capability
  check passes.
- Replace the Node `>=24.15.0 <25` allowlist with separate JavaScript
  (`>=18.15.0`) and native Node-API (`>=6`) admission requirements.
- Remove the Node upper bound after source and published-binary inspection
  confirmed that the native host boundary uses ABI-stable Node-API rather than
  V8, Node C++, or libuv APIs directly.
- Return structured loader diagnostics with observed and required
  compatibility facts.

## Qualification

- Reuse each architecture's exact retained addon across Node runtime lanes.
- Run full installed lifecycles on Node 18.15.0, Node 24.14.0, and Node 26.7.0,
  with minimum/newest ARM64 coverage and compact admission coverage for the
  other supported even-major lines.
- Run full ASAR lifecycles on Electron 28.0.0 and Electron 43.2.0 while
  independently checking their embedded Node and Node-API versions.
- Preserve all existing Linux target, ARM ABI, glibc, kernel, ELF, capability,
  package-integrity, bounded-delivery, and joined-disposal gates.

All checked-in npm, Cargo, and lockfile versions remain
`0.0.0-development`. Semantic-release remains the sole authority that may
materialize a release version from an exact source commit after qualification.
