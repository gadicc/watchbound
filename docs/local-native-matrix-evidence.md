# Local native-matrix evidence

Date: 2026-07-26. This is development evidence from an uncommitted worktree
based on `df61736cf325b522f24320f8ecc2064dc9ff8781`; it is not clean-commit,
reproducibility, ARM64, distro, Nix, overflow, or release qualification.

## x64 artifact inspection

- Artifact: `watchbound.linux-x64-gnu.node`
- Development SHA-256:
  `4bf80a363d3918c74c004cb0a9e9efaa2365fd1ba33fcdb85db24f8bea03fc3f`
- ELF: 64-bit LSB x86-64 shared object, stripped
- Needed libraries: `ld-linux-x86-64.so.2`, `libc.so.6`, `libgcc_s.so.1`
- Highest required symbol: `GLIBC_2.34`
- Node-API export: `napi_register_module_v1`
- Undefined linked Node-API symbols: none; napi-rs runtime lookup policy
- `.symtab`/debug sections: absent

The hash is a local development identity only. It must not be copied into a
consumer manifest or described as an official artifact.

## Package and runtime checks

Using Node 24.16.0 for repository tooling, the local x64 artifact passed:

- Node loader, lifecycle, and environment-teardown suites;
- JavaScript API and capability suites;
- TypeScript and `deno doc --lint` checks;
- generated npm offline installation;
- JSR dry run and both JSR Node compatibility smokes;
- real delivery, initial/dynamic exclusions, explicit reconciliation, root
  replacement/recovery, cancellation, callback serialization, stop, joined
  disposal, and `/proc` resource return; and
- local release ELF/checksum/SBOM generation (independent reproducibility was
  correctly recorded as `not-checked`).

The Nix package-tree generator also produced the x64 source-closure layout in a
temporary directory and passed the same installed-package smoke under local
Node. This validates generation logic only; it is not a Nix derivation result.

The sibling Codex x64 Electron binary then passed the generated ASAR fixture:

- Electron 42.3.0;
- embedded Node 24.15.0;
- Node-API 10;
- wrapper and loader inside `app.asar`;
- target ELF materialized in `app.asar.unpacked`;
- production target/hash/capability handshake; and
- real callback, initial exclusion, reconciliation, and joined teardown.

The temporary ASAR hash is intentionally not retained because it is not a
release artifact.
