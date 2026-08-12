# ARMv7 release evidence — 2026-08-09

This record closes the GNU/Linux ARMv7 hard-float delivery milestone with the
exact immutable `2.1.1` release. It supplements the earlier
[source-qualification record](qualification-evidence-2026-08-07-armv7.md),
which remains scoped to revision `1c9b4e3` and its pre-publication artifact.

## Release identity

| Field | Retained value |
| --- | --- |
| Version and tag | [`2.1.1`](https://github.com/gadicc/watchbound/releases/tag/v2.1.1) / `v2.1.1` |
| Source revision | `096c53174ba6ea6a2e2a065f01423deab09c9de4` |
| Release workflow | [31325826358](https://github.com/gadicc/watchbound/actions/runs/31325826358), conclusion `success` |
| npm wrapper | [`watchbound@2.1.1`](https://www.npmjs.com/package/watchbound/v/2.1.1) |
| JSR wrapper | [`@gadicc/watchbound@2.1.1`](https://jsr.io/@gadicc/watchbound@2.1.1) |
| Native matrix schema | 1 |
| Public capability schema | 9 |
| Raw native capability schema | 5 |
| Binding API / metadata schema | 5 / 1 |
| Node-API floor | 6 |

Release `2.1.0` first published the ARMv7 route. Release `2.1.1` is the current
corrective release and the version consumers should pin. It retains the same
ARMv7 support contract while hardening installed-target discovery and runtime
container evidence.

## Reproducible native artifacts

The release used two isolated Ubuntu 22.04 builders per target. Both ARMv7
[builder A](https://github.com/gadicc/watchbound/actions/runs/31325826358/job/93276013748)
and
[builder B](https://github.com/gadicc/watchbound/actions/runs/31325826358/job/93276013739)
produced the same bytes, and the independent
[comparison job](https://github.com/gadicc/watchbound/actions/runs/31325826358/job/93276150129)
passed. The public
[release metadata](https://github.com/gadicc/watchbound/releases/download/v2.1.1/release-metadata.json)
and
[reproducibility record](https://github.com/gadicc/watchbound/releases/download/v2.1.1/independent-reproducibility.json)
retain the full build identities.

| Target | Rust triple | Native filename | Bytes | Native SHA-256 | Maximum required glibc |
| --- | --- | --- | ---: | --- | --- |
| Linux x64 GNU | `x86_64-unknown-linux-gnu` | `watchbound.linux-x64-gnu.node` | 1,513,224 | `45f40617c86c95e6f023f27891b09805d82e7dc21e295bf886ff5f6a7d541eac` | `GLIBC_2.34` |
| Linux ARM64 GNU | `aarch64-unknown-linux-gnu` | `watchbound.linux-arm64-gnu.node` | 1,292,000 | `9d7208e8fd961af3e26d4cc23403b593b2efdfd686af1ef6a70f462798357fb4` | `GLIBC_2.34` |
| Linux ARMv7 GNU hard-float | `armv7-unknown-linux-gnueabihf` | `watchbound.linux-arm-gnueabihf.node` | 1,293,916 | `ea5a885fa48715e9ebc5bfc82088b307b0bc9ee99b22b60cad6f4b58df558998` | `GLIBC_2.34` |

The ARM binding is ELF32, little-endian, `EM_ARM=40`, EABI5 hard-float. Its
declared Ubuntu 22.04/glibc 2.35 and kernel 5.15 baseline is unchanged.

## Immutable package identities

All five npm packages are lockstep `2.1.1`. The public
[`SHA256SUMS`](https://github.com/gadicc/watchbound/releases/download/v2.1.1/SHA256SUMS)
file is authoritative for release-tarball and native-addon SHA-256 values.

| Package | npm shasum | `dist.integrity` | Release-tarball SHA-256 |
| --- | --- | --- | --- |
| [`watchbound`](https://registry.npmjs.org/watchbound/-/watchbound-2.1.1.tgz) | `4ff71453f1e7ce4cfe3829bf871934b156560d15` | `sha512-kysqjLk7rx8/Im5khevgiOP59adXPaCV2K9dEvWxyE3+u+LrTOakTLZqazD1TZS3fjJEpKLsFqxcydeSuXDzjg==` | `29567421c1efee041658db4b50093f91558604d352178cb2e76dd331e7c5544d` |
| [`@gadicc/watchbound-node`](https://registry.npmjs.org/@gadicc/watchbound-node/-/watchbound-node-2.1.1.tgz) | `409c1275b6d90d5a319c78d0c8efc665a7f7722e` | `sha512-F5W25wl6olKXrhTZgAKBjEmChhBYdyranseL8IWVm3qcK4VfrSLg0AtJ2NTMZIg3IQCx0lvh6QVArQ793VSAJQ==` | `1f8241d08771f8cf00d50ef8953278934493e7712ae77dcb6418487e167f5284` |
| [`@gadicc/watchbound-node-linux-x64-gnu`](https://registry.npmjs.org/@gadicc/watchbound-node-linux-x64-gnu/-/watchbound-node-linux-x64-gnu-2.1.1.tgz) | `a3100b3d908d89ed4825233c4152abad6d24bda8` | `sha512-QqtfUeILJf8iKO9zxF6JxElVhoXnjxMFrtHKwTQgSK5+sSr7R+uOf4K8NO12ytR6+fI1T2J2yFPfzg5ll/gTRg==` | `0903c9eec6ebe127cb3aae7bce92ddb375c21503ef5438a132c28a19517e44c3` |
| [`@gadicc/watchbound-node-linux-arm64-gnu`](https://registry.npmjs.org/@gadicc/watchbound-node-linux-arm64-gnu/-/watchbound-node-linux-arm64-gnu-2.1.1.tgz) | `f7bf85fdbbe7669812a0f946eb23a534a395a827` | `sha512-2iSHBCBMxWe1X2Wg/mTDwDnJIw5HEHCpO8WCde2jPab9L1pMAKqPtevqW/ceEomUmY7GxfJSJhinJXHHEJQ0eA==` | `a2acdc589d34499b979401b471f73173db33f7b82941f429bfdf4ea287f1e5e3` |
| [`@gadicc/watchbound-node-linux-arm-gnueabihf`](https://registry.npmjs.org/@gadicc/watchbound-node-linux-arm-gnueabihf/-/watchbound-node-linux-arm-gnueabihf-2.1.1.tgz) | `f79f4aab8f79ef3aab0fd9cb3357fbe26dcabf0e` | `sha512-SLjawq9r4WCFAMDd2IzcsmE/w6lNltdKZ8HSIQH9WW67fx3ghPSY+HUPTd0y9l/3PFiBje6FvmQ/xb4N7/OePw==` | `b651f72ef6869672368fb25cf88a6edee8564aa94d22a80c8c29de77992042b8` |

## Runtime and registry execution

The exact canonical ARMv7 digest passed the production loader and a real
watch/start/callback/dispose lifecycle in both required execution lanes:

- [QEMU-user Electron lifecycle](https://github.com/gadicc/watchbound/actions/runs/31325826358/job/93276197410):
  Electron 42.3.0 / embedded Node 24.15.0 on the pinned Ubuntu 22.04 armhf
  userspace;
- [system-QEMU kernel-floor lifecycle](https://github.com/gadicc/watchbound/actions/runs/31325826358/job/93276197443):
  the snapshot-pinned `5.15.0-185-generic-lpae` kernel and Ubuntu 22.04 armhf
  guest;
- [npm registry lifecycle](https://github.com/gadicc/watchbound/actions/runs/31325826358/job/93278178783)
  and
  [JSR Node registry lifecycle](https://github.com/gadicc/watchbound/actions/runs/31325826358/job/93278178804):
  exact immutable registry packages selected through the neutral loader and
  completed the same lifecycle; and
- [stable target-matrix gate](https://github.com/gadicc/watchbound/actions/runs/31325826358/job/93278601102):
  every exact npm and JSR target route passed.

The public
[publication ledger](https://github.com/gadicc/watchbound/releases/download/v2.1.1/publication-ledger.json)
records completed and verified publication of every npm package and the JSR
wrapper.

## Support boundary and downstream use

ARMv7 support remains exact GNU/Linux glibc, little-endian ARMv7-A, hard-float
EABI, kernel 5.15 or newer, Node `>=24.15.0 <25`, and Node-API 6 or newer.
Musl, soft-float, unknown ARM ABI, big-endian ARM, other 32-bit ARM variants,
and non-Linux hosts fail closed.

ARMv7 execution evidence is QEMU-backed. It is real package, loader, callback,
and joined-disposal evidence, but it is not native-hardware or performance
evidence. Both ARM execution lanes remain continuing release-support gates.

Consumers should pin tag `v2.1.1`, its exact source revision, all applicable
lockstep package identities above, and the selected native filename and digest.
A later documentation-only source revision does not replace or alter that
immutable release identity.
