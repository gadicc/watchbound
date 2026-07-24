# Release and registry runbook

Status: the `0.0.1` bootstrap is published to npm and JSR. The prospective
`1.0.0` async-callback candidate commits its exact release version and declares
the narrow target supported, but that declaration becomes effective only after
the candidate's own two-lane CI succeeds. It remains unpublished. Independent
builder, supervised-overflow, and post-publication registry-smoke evidence are
separate gates.

## What CI does

Every pull request and push runs the two supported-source-build lanes in
parallel on GitHub's Ubuntu 24.04 x64 runner:

| Lane | Node | Rust | Purpose |
| --- | --- | --- | --- |
| floor | 24.18.0 | 1.88.0 | Exact minimum supported toolchain |
| moving | latest 24.x | latest stable | Early warning inside the declared ranges |

Both lanes assert Ubuntu 24.04, Linux x86_64, glibc 2.39, the kernel floor,
Node-API, compiler/linker availability, and their selected runtime versions.
They build from source, test, check, run bounded maintenance gates, and run
ordinary strict conformance serially. The floor lane additionally:

1. generates controlled public npm trees from the private workspace manifests;
2. packs `@gadicc/watchbound-node` and `watchbound`;
3. checks the exact files in both tarballs;
4. installs both tarballs offline into an empty project and exercises real
   delivery, Promise callback serialization, callback cancellation/stop, joined
   disposal, and final resource baselines;
5. runs a JSR publish dry run over the generated wrapper tree;
6. inspects the ELF target, stripped-symbol status, dynamic-library allowlist,
   Node-API export, embedded search paths, and size;
7. emits SHA-256 checksums, release metadata, and a CycloneDX 1.6 SBOM.

The JSR check retains JSR's fast public-API/slow-type validation but passes
`--no-check` to the broader Deno checker. That checker cannot load the native
npm dependency's Node declarations in the isolated publish tree; the npm
tarball install smoke and the repository's TypeScript fixtures cover those
Node-specific declarations instead.

`pnpm test:packages` performs the same artifact validation locally after
`pnpm build:node`. Generated files live under ignored `dist/`.

## Main-branch semantic release

`.github/workflows/release.yml` runs only for a push to `main`. It plans the
exact committed version without mutating source, reuses the complete CI
workflow, builds the addon on two isolated clean Ubuntu 24.04 jobs, transfers
both exact binaries, and recomputes their SHA-256 values in a third job before
byte-comparing them. The independent builders retain distinct Cargo, target,
package-manager, and Rustup homes. Rust compiler flags remap each private Cargo
source root to the stable virtual path `/watchbound/cargo-home`, preventing
runner-specific source paths from changing otherwise identical binaries. The
evidence retains both the real isolation paths and the applied remapping, and
the comparison still requires whole-file byte equality.

If those gates pass, semantic-release analyzes Conventional Commits since the
last tag:

- `fix` produces a patch;
- `feat` produces a minor;
- a documented breaking change produces a major; and
- documentation, test, CI, or chore-only changes do not publish by default.

For a release, the custom semantic-release plugin:

1. requires the semantic-release version to equal the committed lockstep
   version and proves version stamping is a no-op;
2. performs two same-runner clean builds as defense in depth and requires both
   to match the independently approved digest;
3. installs the canonical independently compared binary, then packs, audits,
   and offline-smoke-tests the exact npm tarballs;
4. dry-runs the generated JSR tree and writes checksums, release metadata, and
   a CycloneDX 1.6 SBOM;
5. checks each registry and publishes only missing immutable versions, verifying
   any existing npm version against the exact local integrity and dependency
   metadata, always publishing native npm before wrapper npm and JSR last;
6. publishes through npm and JSR GitHub Actions OIDC with provenance.

After preparation succeeds, semantic-release creates its Git tag before calling
the publish plugins. After registry publication, the GitHub plugin creates the
release and attaches the inspected tarballs and reproducibility evidence. The
workflow then, on fresh supported runners, installs the exact npm wrapper and
the JSR Node-compatibility route, exercises the full lifecycle contract, and
verifies the installed native hash. The tag-before-publish failure case is
covered by the incident runbook.

The publish step fails closed on registry lookup errors and refuses the unsafe
partial state where the wrapper exists but its exact native dependency does
not. The planning job has `contents: write` because semantic-release verifies
push access even in dry-run mode; the planner itself does not push. The
GitHub-hosted publish job has the write permissions semantic-release needs for
its tag, release, issues, and pull-request notes, plus `id-token: write` for
registry OIDC. It has no npm or JSR secret.

Feature branches, pull requests, and `dev` pushes run the ordinary CI workflow
but cannot start the Release workflow or publish.

An intentional maintainer merge or push to `main` is the human publication
authorization boundary. There is no protected GitHub environment, temporary
workflow secret, branch-protection requirement, manual-dispatch prerequisite,
or separate release-approval deployment.

## One-time `0.0.1` bootstrap

npm trusted publishers can be configured only after each package exists. The
initial `0.0.1` versions are therefore published locally with the maintainer's
interactive npm authentication and MFA. They use npm's `bootstrap` dist-tag:

```sh
pnpm build:node
pnpm test
pnpm check
pnpm check:reproducible
pnpm test:packages

npm publish dist/tarballs/gadicc-watchbound-node-0.0.1.tgz \
  --access public \
  --provenance=false \
  --tag bootstrap
npm publish dist/tarballs/watchbound-0.0.1.tgz \
  --access public \
  --provenance=false \
  --tag bootstrap
```

The explicit `--provenance=false` overrides the generated package's
OIDC-oriented `publishConfig` for this local exception. The bootstrap remains
attributable through the npm account and immutable package contents, but it
does not claim GitHub Actions build provenance.

On the first and only version of each new npm package, the registry also
retained `latest` and rejected its removal even though publication explicitly
used `--tag bootstrap`. The `bootstrap` tags still identify the release's
intent. The first ordinary semantic release moves `latest` to the OIDC-backed
public version.

Create `@gadicc/watchbound` at <https://jsr.io/new>, link it to
`gadicc/watchbound`, and publish the generated `0.0.1` tree:

```sh
cd dist/jsr
deno publish --no-check
```

JSR may use browser authorization for this one-time local publication. In JSR
package settings, record Node.js as supported and Deno, Bun, Cloudflare
Workers, and browsers as unsupported. The package contains a Linux Node-API
dependency; publication on JSR does not widen the support matrix.

After both npm names exist, configure the exact OIDC publishers:

```sh
npm install --global npm@11.18.0
npm trust github @gadicc/watchbound-node \
  --repo gadicc/watchbound \
  --file release.yml \
  --allow-publish \
  --yes
npm trust github watchbound \
  --repo gadicc/watchbound \
  --file release.yml \
  --allow-publish \
  --yes
```

The equivalent npm website configuration is GitHub owner `gadicc`, repository
`watchbound`, workflow filename `release.yml`, no environment, and allowed
action `npm publish`. Verify both relationships with
`npm trust list <package>`, require 2FA, and disallow token publishing.

npm trusted publishing requires npm 11.5.1+ and Node 22.14.0+. The workflow
pins Node 24.18.0 and npm 11.18.0. Publisher fields are exact and
case-sensitive, and both published manifests identify the public
`https://github.com/gadicc/watchbound` repository.

As with `projectfmt`, do not create a semantic-release Git tag for the
`bootstrap` dist-tag. With no prior semantic-release tag, the first
release-worthy `main` run establishes the normal public line (typically
`1.0.0`) and publishes it with OIDC provenance under npm's `latest` dist-tag.

Official references:

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
- [JSR publishing from GitHub Actions](https://jsr.io/docs/publishing-packages)
- [JSR provenance and trust](https://jsr.io/docs/trust)
- [semantic-release](https://semantic-release.gitbook.io/)

## Remaining release gates

Green automation is necessary, not a production-readiness declaration. Before
publishing, explicitly close or accept the currently documented blockers,
qualify the exact release commit on both support lanes, and review
[`native-delivery.md`](native-delivery.md).

The automated pieces cover package file allowlists, offline install/import, JSR
dry-run validation, exact target naming, version/delivery lockstep, binary
inspection, checksums, a CycloneDX SBOM, same-runner byte reproducibility, and
OIDC provenance after bootstrap. The incident path is in
[`release-incident-response.md`](release-incident-response.md).

Still requiring an explicit human decision or external evidence before the
same qualified SHA is pushed to `main`:

- accept the deliberately narrow Ubuntu 24.04 x64/glibc 2.39 public artifact,
  with unsupported targets failing closed;
- resolve or explicitly accept every production blocker and decide whether the
  release remains experimental;
- obtain fresh supervised forced-overflow evidence for the exact release
  candidate on a confirmed quiet, prepared host;
- review known limitations; and
- accept that exact stable registry smoke necessarily follows immutable
  publication and use the incident path if either route fails.

## Release checklist

1. Use a Conventional Commit whose type matches the intended release impact.
2. Commit the intended release version in package, Cargo, and lock metadata.
3. Run `pnpm build:node`, `pnpm test`, `pnpm check`,
   `pnpm check:reproducible`, and `pnpm test:packages`.
4. On a confirmed quiet supported host, run the separately approved manual and
   automatic forced-overflow trials against that SHA and native digest.
5. For the completed one-time bootstrap only, `0.0.1` was published locally in
   native, wrapper, then JSR order, and the registry OIDC relationships were
   configured.
6. For subsequent releases, intentionally merge or push the exact approved
   Conventional Commit to `main`; semantic-release validates and publishes its
   committed version after the two CI lanes and independent-builder comparison
   pass in that same workflow run.
7. Treat the release as published-but-verification-pending until both exact npm
   and JSR Node-route registry smokes pass.
8. Verify provenance, npm dist-tags, JSR version state, GitHub evidence, and the
   retained smoke results.

Do not merge a release-worthy commit to `main` merely to exercise publishing.
Every `main` push crosses the publication-authorization boundary; use an
ordinary branch push or pull request for non-publishing CI.
