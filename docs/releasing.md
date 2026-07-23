# Release and registry runbook

Status: release automation is prepared but no package is published. Production
readiness, support qualification, native-distribution review, and explicit
maintainer approval remain separate gates.

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
4. installs both tarballs offline into an empty project and imports the wrapper;
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

`.github/workflows/release.yml` runs after a push to `main`. It first reuses the
complete CI workflow. If CI passes, semantic-release analyzes Conventional
Commits since the last semantic-release tag:

- `fix` produces a patch;
- `feat` produces a minor;
- a documented breaking change produces a major; and
- documentation, test, CI, or chore-only changes do not publish by default.

For a release, the custom semantic-release plugin:

1. stamps the selected version into the private workspace manifests, Cargo
   workspace, Cargo lockfile, generated npm packages, and JSR metadata;
2. performs two clean native builds with the floor toolchain and requires
   byte-identical output;
3. packs, audits, and offline-smoke-tests the exact npm tarballs;
4. dry-runs the generated JSR tree and writes checksums, release metadata, and
   a CycloneDX 1.6 SBOM;
5. checks each registry and publishes only missing immutable versions, always
   publishing the native npm package before its wrapper and JSR last;
6. publishes through npm and JSR GitHub Actions OIDC with provenance; and
7. creates the semantic-release Git tag, notes, and GitHub Release with the
   inspected tarballs and evidence attached.

The publish step fails closed on registry lookup errors and refuses the unsafe
partial state where the wrapper exists but its exact native dependency does
not. The GitHub-hosted publish job has the write permissions semantic-release
needs for its tag, release, issues, and pull-request notes, plus
`id-token: write` for registry OIDC. It has no npm or JSR secret.

A manual workflow dispatch runs the complete reusable CI workflow but cannot
enter semantic-release. Feature branches, pull requests, and `dev` pushes
cannot publish.

This lighter policy treats merge or push access to `main` as the human release
boundary. There is no protected GitHub environment, temporary workflow secret,
or separate release approval deployment. Protect `main`, require CI, restrict
merge access, and use Conventional Commit types deliberately.

## One-time `0.0.1` bootstrap

npm trusted publishers can be configured only after each package exists. The
initial `0.0.1` versions are therefore published locally with the maintainer's
interactive npm authentication and MFA. They use npm's non-default `bootstrap`
dist-tag:

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

Still requiring an explicit human decision or external evidence:

- accept the deliberately narrow Ubuntu 24.04 x64/glibc 2.39 public artifact,
  with unsupported targets failing closed;
- resolve or explicitly accept every production blocker and decide whether the
  release remains experimental;
- before treating a release as stable, obtain byte-comparison evidence from
  two independent clean builders; same-runner repetition is useful but weaker;
- review known limitations; and
- after publication, install exact registry versions into a clean supported
  host and record the smoke result.

## Release checklist

1. Use a Conventional Commit whose type matches the intended release impact.
2. Run `pnpm build:node`, `pnpm test`, `pnpm check`,
   `pnpm check:reproducible`, and `pnpm test:packages`.
3. Push the reviewed commit and wait for both CI support lanes.
4. For the one-time bootstrap only, stage `0.0.1`, publish locally in native,
   wrapper, then JSR order, and configure the registry OIDC relationships.
5. For subsequent releases, merge the approved Conventional Commit to `main`;
   semantic-release determines and publishes the version.
6. Verify provenance, npm dist-tags, JSR version state, GitHub evidence, and
   clean registry installation on a supported host.

Do not merge a release-worthy commit to `main` merely to exercise publishing.
Use `workflow_dispatch` for a non-publishing full-CI rehearsal.
