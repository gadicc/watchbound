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
2. packs `@gadicc/watchbound-node` and `@gadicc/watchbound`;
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

## Release trigger and safety boundary

`.github/workflows/release.yml` publishes only for a GitHub Release whose tag
is `v<workspace-version>`. A manual workflow dispatch reruns all release tests,
builds and inspects the release bundle, and retains it as a 14-day workflow
artifact, but cannot enter the publish job.

A GitHub prerelease publishes both npm packages under the `next` dist-tag;
a non-prerelease uses `latest`. JSR has no equivalent dist-tag, so use a SemVer
prerelease version when JSR consumers must see an explicitly prerelease
version.

The release path:

- runs only after the reusable CI workflow passes;
- uses a GitHub-hosted Ubuntu 24.04 runner;
- builds the bundle before entering the `release` GitHub environment;
- uploads that inspected bundle so a manual dispatch exercises the same
  non-publishing path;
- enters the `release` environment only in the publish job;
- grants `id-token: write` for registry OIDC and `contents: write` only so the
  checked artifacts and evidence can be attached to the existing release;
- checks that the tag matches all lockstep package and Rust versions;
- performs two clean same-runner native builds with the floor toolchain and
  requires byte-identical output;
- downloads the same-run workflow artifact, verifies its tarball checksums,
  and publishes the exact npm tarballs already inspected and smoke-tested;
- publishes the generated JSR tree after both npm packages, because the JSR
  wrapper depends on `npm:@gadicc/watchbound-node` through its package
  dependency;
- requests provenance for both registries;
- attaches both tarballs, their checksum manifest, release metadata, and SBOM
  to the immutable-version GitHub Release.

The publish job never runs from a `dev` push, another normal branch push, a
pull request, or a manual dispatch. A manual dispatch may rehearse the full
test/package/evidence side from `dev`. Protect the GitHub `release` environment
with required reviewers before the first real release.

The environment is both a human approval boundary and part of the npm OIDC
identity. Configure the npm trusted publishers with the exact environment name
`release`; otherwise the workflow's OIDC subject will not match.

Recommended GitHub environment settings:

- required reviewer: the maintainer (or a second release owner when available);
- prevent self-review: off while the maintainer is the only release owner,
  otherwise no release could pass the gate;
- deployment branches and tags: selected tags matching `v*`;
- environment secret: `NPM_BOOTSTRAP_TOKEN` only for the first npm publication,
  deleted immediately after trusted publishers are configured.

## One-time registry bootstrap

JSR can use OIDC for the first version:

1. create `@gadicc/watchbound` at <https://jsr.io/new>;
2. link it to `gadicc/watchbound` in the package settings;
3. leave the release workflow's JSR step tokenless.

In JSR package settings, record the runtime matrix rather than relying on the
presence of a JSR package to imply portability: mark Node.js supported and
Deno, Bun, Cloudflare Workers, and browsers unsupported for now. The package
contains a Linux Node-API dependency even though JSR itself supports all of
those ecosystems.

The JSR artifact exposes the same ESM wrapper and exact npm native dependency.
Publishing it does not qualify Deno, browsers, other operating systems, or any
runtime outside the support matrix.

npm trusted publishers are configured on existing packages, so the two npm
names need one bootstrap publication. To retain provenance for that bootstrap,
create a one-day granular npm token with bypass-2FA enabled and read/write
package access limited to the `@gadicc` scope. The package names do not yet
exist to select individually; do not grant organization-management access.
Store the token temporarily as the `NPM_BOOTSTRAP_TOKEN` secret on the
protected `release` environment. The npm CLI prefers OIDC when a trusted
relationship exists and otherwise falls back to this token. The explicit
`--provenance` flags still generate provenance from the GitHub-hosted release
workflow.

Publish the bootstrap GitHub Release only after all release gates are approved.
If it is not intended as the npm default, mark the GitHub Release as a
prerelease so npm uses the `next` dist-tag. Prefer a SemVer prerelease version
as well because the same JSR version is published without a dist-tag.
After both npm packages exist, configure their trusted publishers:

```sh
npm install --global npm@11.18.0
npm trust github @gadicc/watchbound-node \
  --repo gadicc/watchbound \
  --file release.yml \
  --env release \
  --allow-publish \
  --yes
npm trust github @gadicc/watchbound \
  --repo gadicc/watchbound \
  --file release.yml \
  --env release \
  --allow-publish \
  --yes
```

The equivalent npm website configuration is GitHub owner `gadicc`, repository
`watchbound`, workflow filename `release.yml`, environment `release`, and
allowed action `npm publish`.

Then:

1. verify both relationships with `npm trust list <package>`;
2. delete `NPM_BOOTSTRAP_TOKEN`;
3. revoke the bootstrap token;
4. set both npm packages to require 2FA and disallow token publishing;
5. verify npm and JSR show provenance for the bootstrap version.

npm trusted publishing requires npm 11.5.1+ and Node 22.14.0+. The workflow
pins Node 24.18.0 and npm 11.18.0. npm trusted-publisher configuration is exact
and case-sensitive; each package must name the public
`https://github.com/gadicc/watchbound` repository in its published manifest.

Official references:

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
- [JSR publishing from GitHub Actions](https://jsr.io/docs/publishing-packages)
- [JSR provenance and trust](https://jsr.io/docs/trust)

## Remaining release gates

Green automation is necessary, not a production-readiness declaration. Before
publishing, explicitly close or accept the currently documented blockers,
qualify the exact release commit on both support lanes, and review
[`native-delivery.md`](native-delivery.md).

The automated pieces now cover package file allowlists, offline install/import,
JSR dry-run validation, exact target naming, version/delivery lockstep,
binary inspection, checksums, a CycloneDX SBOM, same-runner byte
reproducibility, and npm/JSR provenance. The incident path is in
[`release-incident-response.md`](release-incident-response.md).

Still requiring an explicit human decision or external evidence:

- accept the deliberately narrow Ubuntu 24.04 x64/glibc 2.39 public artifact,
  with unsupported targets failing closed;
- resolve or explicitly accept every production blocker and decide whether the
  release remains experimental;
- for a stable release, obtain the required byte-comparison evidence from two
  independent clean builders; same-runner repetition is useful but weaker;
- review release notes and known limitations;
- after publication, install exact registry versions into a clean supported
  host and record the smoke result.

## Release checklist

1. Select a SemVer version. Use a prerelease such as `0.2.0-beta.1` for the
   bootstrap while production blockers remain.
2. Update every lockstep JavaScript/Rust version and run
   `pnpm check:release-tag v<version>`.
3. Run `pnpm build:node`, `pnpm test`, `pnpm check`, and
   `pnpm test:packages`; use `pnpm check:reproducible` on the release host.
4. Push the reviewed commit and wait for both CI support lanes.
5. Rehearse with manual dispatch and review its retained package/evidence
   bundle. This cannot publish.
6. Create a matching GitHub prerelease or release only after the `release`
   environment and registry identities are ready.
7. Approve the protected environment deployment and watch both registries.
8. Verify provenance, GitHub evidence assets, npm dist-tags, and JSR version
   state.
9. Install from both registries on a clean supported host.
10. After the bootstrap, replace the temporary npm token with trusted
    publishers exactly as described above and revoke the token.

Do not create a tag or GitHub Release merely to exercise the workflow. Use
`workflow_dispatch` for a non-publishing release rehearsal.
