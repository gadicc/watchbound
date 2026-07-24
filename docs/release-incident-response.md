# Release incident response

This runbook covers a bad, compromised, or incomplete Watchbound npm/JSR
release. The maintainer named in `maintenance-policy.md` owns the response.
Preserve registry provenance, GitHub Actions logs, checksums, SBOMs, and the
exact source commit before changing public state.

## Immediate containment

1. Stop or cancel any remaining release workflow jobs.
2. Disable the affected npm trusted-publisher relationship if OIDC trust may be
   compromised.
3. If the local bootstrap login may be compromised, revoke active npm sessions
   or tokens and log the publishing host out.
4. Do not reuse or move the affected tag, and do not attempt to overwrite a
   registry version.
5. Record the package names, versions, dist-tags, JSR status, workflow run,
   commit, provenance links, checksums, and known impact.

## Registry actions

For npm, prefer a prompt fixed patch release. Move a dist-tag away from a bad
version when needed and deprecate the affected version with an actionable
message. Use unpublish only when npm policy permits it and the consequences
have been reviewed; an unpublished package name/version may remain restricted,
and a published version cannot be overwritten.

For JSR, yank the affected version in package settings and publish a fixed
version. JSR versions are immutable. Yanking prevents ordinary new resolution
while preserving existing lockfile resolution and the historical record.

For a partially completed release, never rerun publication blindly. Check each
registry independently, verify the immutable artifact digest and provenance
where a version exists, then either complete only the missing operation from a
reviewed exact commit or publish a new patch/prerelease version.

Semantic-release creates and pushes its Git tag before invoking publish
plugins. A failed tagged run may therefore produce no release on an ordinary
rerun. Use the reviewed recovery command from the exact tagged source only
after its local tarballs match every existing registry integrity and the
independent native digest. Never delete or move the tag to make semantic-release
repeat the publish phase.

The one-time `v1.0.0` recovery at commit `e5bdf4c` was pinned to the original
tag, source SHA, workflow run, attempt, independent native digest, and both npm
tarball digests. It verified the existing npm registry artifacts and published
only the missing JSR version. Recovery run `30105778464` then exposed a failed
JSR Node-route smoke caused by JSR npm-manifest normalization. The workflow is
retired; yank the affected immutable JSR `1.0.0` and use the corrected lockstep
patch release rather than attempting recovery again.

## Registry-smoke failure

The release remains published-but-unverified until both fresh-runner npm and
JSR Node-route smokes pass.

- If an exact version is temporarily invisible, retain the first result and
  rerun only the read-only smoke after the bounded propagation window.
- If integrity, dependency resolution, import, delivery, callback lifecycle,
  disposal, or resource restoration fails, do not retry publication. Deprecate
  both affected npm packages, yank the JSR version, annotate the GitHub Release,
  and prepare a corrected lockstep patch.
- Move `latest` back only to a verified contract-compatible stable release. The
  earlier-callback `0.0.1` bootstrap is not a silent v1 rollback target.
- Preserve the installed lock metadata, expected and observed native hashes,
  registry integrity/provenance, host facts, resource samples, and smoke log.

## GitHub and communication

- Mark any GitHub release notes with the affected status and remediation.
- Open a tracking issue unless disclosure would expose an active security
  vulnerability; use a private GitHub security advisory in that case.
- State the affected versions, supported target, symptoms, recommended action,
  fixed version, and whether credentials or source integrity were involved.
- Preserve the original workflow evidence. Add corrective evidence under a
  new version instead of replacing the affected version's record.

## Recovery

Before restoring publishing:

1. resolve the cause and add a regression or release-gate check;
2. rotate affected credentials and re-establish the two exact npm trusted
   publisher records when required;
3. run the full CI and release rehearsal from the corrected commit;
4. review the generated tarballs, `SHA256SUMS`, release metadata, CycloneDX
   SBOM, and provenance;
5. publish a new immutable version through the reviewed `main`
   semantic-release OIDC workflow;
6. perform registry-install smoke tests and update the incident record.

Registry policy references:

- [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)
- [JSR package version yanking](https://jsr.io/docs/packages)
