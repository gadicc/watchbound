# Node and Electron runtime compatibility

This document separates three facts that had previously been collapsed into a
single Node patch range:

- `nodeMinimum` is the JavaScript runtime floor for the wrapper and loader;
- `nodeApiMinimum` is the ABI level required by the compiled addon; and
- `testedRuntimes` records CI evidence, not a runtime allowlist.

`config/native-matrix.json` is authoritative for all three. Generated package
manifests derive `engines.node` and their Watchbound metadata from it. The
checked-in source manifests repeat the generated engine range because package
managers need it before generation; package-contract tests require exact
agreement with the matrix. `buildNode` is a separate reproducible
build/qualification tool pin and is not a support boundary.

## JavaScript minimum: Node 18.15.0

The wrapper and loader syntax is supported before Node 18.15.0. Their relevant
runtime APIs are also older, including ECMAScript modules, dynamic `import()`,
`AbortController`/`AbortSignal`, `WeakRef`, `Promise.allSettled`, error causes,
`TextDecoder`, and the CommonJS `node:` built-ins. The newest required public
API is [`fs.statfsSync()`](https://nodejs.org/download/release/v18.18.0/docs/api/fs.html#fsstatfssyncpath-options),
used by `qualifyRoot()`, which was added in Node 18.15.0. The ARM admission
fallback's [`os.machine()`](https://nodejs.org/download/release/v18.9.0/docs/api/os.html#osmachine)
was added in Node 18.9.0.
No filesystem-watcher operation depends on a Node 24-only JavaScript API.

The supported JavaScript range is therefore `>=18.15.0`, with no Node upper
bound. A newer, unenumerated Node major is not rejected solely because it lacks
a manually maintained allowlist entry.

## Native ABI minimum: Node-API 6

The Rust binding enables napi-rs `napi6`. [Node documents Node-API as
ABI-stable across Node versions](https://nodejs.org/api/n-api.html#node-api).
Its `bindingMetadata()` contract
reports `nodeApiVersion: 6`, and the loader requires the running process to
expose an integer `process.versions.napi >= 6`. It then requires the loaded
binding to report exactly the matrix ABI level, metadata schema 1, binding API
5, raw capability schema 5, the expected release profile and target triple,
and package/native/engine version lockstep. The JavaScript wrapper performs the
remaining detailed capability checks and requires public capability schema 9.

### Published-addon inspection

On 2026-08-14, the published `2.1.1` npm packages were downloaded and inspected
without using their contents as source truth. The x64 addon was loaded directly
under Node 25.2.1 and reported metadata schema 1, binding API 5, Node-API 6,
native/engine version 2.1.1, the x86_64 GNU target, and a release build.

| Published target package | Native SHA-256 |
| --- | --- |
| `@gadicc/watchbound-node-linux-x64-gnu` | `45f40617c86c95e6f023f27891b09805d82e7dc21e295bf886ff5f6a7d541eac` |
| `@gadicc/watchbound-node-linux-arm64-gnu` | `9d7208e8fd961af3e26d4cc23403b593b2efdfd686af1ef6a70f462798357fb4` |
| `@gadicc/watchbound-node-linux-arm-gnueabihf` | `ea5a885fa48715e9ebc5bfc82088b307b0bc9ee99b22b60cad6f4b58df558998` |

`file`, `readelf`, and dynamic-symbol inspection found the expected ELF
identity and only the declared libc, loader, and `libgcc_s` dependencies. Each
addon exports `napi_register_module_v1`; none has an undefined or directly
linked `napi_*`, V8, Node C++, or libuv symbol. napi-rs resolves the host
Node-API table dynamically. The Node host boundary is therefore exclusively
ABI-stable Node-API. This does not mean the whole addon is platform-neutral:
the Rust engine intentionally calls Linux libc/inotify directly, so the
existing architecture, ARM ABI, glibc, kernel, ELF, and package-integrity gates
remain mandatory.

## Loader admission order

The source loader does not call `process.report.getReport()`. It opens the
running executable through `/proc/self/exe`, reads the ELF header, bounded
program-header table, and exact `PT_INTERP` segment, and requires the ELF
class, endianness, and machine to match the selected target. A musl
interpreter is rejected directly. For a recognized glibc interpreter, the
loader executes that exact absolute interpreter with `--version`, a sanitized
environment, no shell or `PATH` lookup, bounded output, and a one-second
timeout. Only a successful glibc-specific stable-release banner supplies the
version used for the 2.35 floor. Missing, malformed, mismatched, timed-out, or
unrecognized evidence remains unknown and fails before the addon loads.

The admitted platform, architecture, ARM ABI, kernel, libc, Node, and Node-API
facts are frozen once by the loader. The wrapper builds public capabilities
from that same snapshot instead of probing the host again. This prevents a
loader/capability disagreement and avoids fatal diagnostic-report APIs in
embedded runtimes.

The production loader fails closed in this order:

1. validate the matrix, platform, architecture, and ARM ABI;
2. prove glibc 2.35 or newer and Linux kernel 5.15 or newer;
3. resolve the one exact native target package, then verify package metadata,
   regular-file bounds, SHA-256, and ELF identity;
4. require Node 18.15.0 or newer;
5. require process Node-API 6 or newer;
6. load the exact native file;
7. verify binding metadata, versions, target, build profile, and capability
   schema before exposing the binding.

Failures are `WatchboundLoaderError` instances with a stable bounded `code`, a
bounded message, a frozen `details` object containing observed and required
facts where applicable, and a sanitized bounded cause for host errors. The
loader never falls back to a nearby addon.

## Tested runtime evidence

The broad x64 Node matrix is compact but covers every supported even-major
line: the exact floor, latest retained patches for Node 18, 20, 22, and 24,
the Node 24.14.0 regression, and the newest Node 26 line. Full installed
lifecycle tests run on Node 18.15.0, 24.14.0, and 26.7.0. Admission tests run on
18.20.8, 20.20.2, 22.23.2, and 24.19.0. ARM64 repeats the full minimum and
newest lanes. Every lane downloads the one addon produced by its architecture's
source-build job; no Node lane rebuilds it.

The full lifecycle covers package import, exact native selection and digest,
engine creation, initial observation, create/change/delete delivery,
exclusions, reconciliation, cancellation, joined disposal, resource return,
and clean process exit. Distro, glibc, and kernel qualification stay on
separate axes rather than forming a Cartesian product with Node versions.

Electron CI similarly reuses the retained x64 addon without rebuilding it:

| Evidence role | Electron | Embedded Node | Exact Node-API |
| --- | ---: | ---: | ---: |
| Oldest supported | [28.0.0](https://releases.electronjs.org/release/v28.0.0) | 18.18.2 | 9 |
| Current representative | [43.2.0](https://releases.electronjs.org/release/v43.2.0) | 24.18.0 | 10 |

Electron 25.0.0 embeds the JavaScript-floor Node 18.15.0 but is not an ASAR
support floor: the real production fixture fails because that release's ESM
resolver treats the nested package path under `app.asar` as a non-directory.
Electron 28.0.0 is the first stable Electron release with Electron ESM support
and its ASAR fixes, and the Watchbound lifecycle passes there. The fixture
queries and asserts Electron, Node, and Node-API independently; it
does not derive one from another. The legacy official Electron 42.3.0 lanes
remain ARMv7 and existing Codex-upstream qualification evidence, not a claim
about OpenAI's signed executable. Codex Desktop owns the consumer-specific
test for that executable. The 2026-08-14 x64 acceptance run observed Owl
reporting Electron 151.0.7922.137, Node 24.14.0, and Node-API 10; Electron
42.3.0 was an application dependency rather than `process.versions.electron`.
It passed three cold lifecycles for candidate `1305e2a` with the existing
Owl-safe `process.report` shim. See the
[consumer acceptance record](codex-signed-runtime-acceptance-2026-08-14.md).
