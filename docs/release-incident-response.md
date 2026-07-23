# Release incident response

This runbook covers a bad, compromised, or incomplete Watchbound npm/JSR
release. The maintainer named in `maintenance-policy.md` owns the response.
Preserve registry provenance, GitHub Actions logs, checksums, SBOMs, and the
exact source commit before changing public state.

## Immediate containment

1. Stop or cancel any remaining release workflow jobs.
2. Disable the affected npm trusted-publisher relationship if OIDC trust may be
   compromised.
3. Delete the `NPM_BOOTSTRAP_TOKEN` GitHub environment secret and revoke the
   underlying granular npm token if it still exists.
4. Do not reuse or move the affected tag, and do not attempt to overwrite a
   registry version.
5. Record the package names, versions, dist-tags, JSR status, GitHub Release,
   workflow run, commit, provenance links, checksums, and known impact.

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

## GitHub and communication

- Mark the GitHub Release and notes with the affected status and remediation.
- Open a tracking issue unless disclosure would expose an active security
  vulnerability; use a private GitHub security advisory in that case.
- State the affected versions, supported target, symptoms, recommended action,
  fixed version, and whether credentials or source integrity were involved.
- Preserve the original release assets. Add corrective evidence under a new
  version instead of replacing evidence attached to the affected release.

## Recovery

Before restoring publishing:

1. resolve the cause and add a regression or release-gate check;
2. rotate affected credentials and re-establish the two exact npm trusted
   publisher records when required;
3. run the full CI and release rehearsal from the corrected commit;
4. review the generated tarballs, `SHA256SUMS`, release metadata, CycloneDX
   SBOM, and provenance;
5. publish a new immutable version through the protected `release`
   environment;
6. perform registry-install smoke tests and update the incident record.

Registry policy references:

- [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/)
- [JSR package version yanking](https://jsr.io/docs/packages)
