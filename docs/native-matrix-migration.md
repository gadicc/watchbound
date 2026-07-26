# Native matrix migration

The unpublished `1.2.0` candidate changes generated delivery from one bundled
x64 addon to an architecture-neutral loader plus exact optional target
packages. Source development still uses `pnpm build:node` and loads the one
local host artifact.

Consumers that only call the JavaScript API require no code change. Lockfiles,
artifact allowlists, offline mirrors, ASAR staging, and application packagers
must admit the loader and the appropriate target package.

Capability schema 4 is additive. Existing single-target fields remain under
`support.scope === "legacy-primary-target"`; new integrations must use
`build.packagedTarget`, `support.targets`, and `support.currentRuntime` rather
than reinterpreting the legacy fields.

Loader failures now distinguish a missing exact optional target package from a
source artifact that has not been built. There is no legacy x64 fallback. An
offline installation must include `watchbound`, `@gadicc/watchbound-node`, and
the target package selected for that host.

The new target package names require one-time npm package creation before the
first ordinary OIDC semantic release. That administrative bootstrap is not
performed by this branch and must not create a semantic-release tag or imply
qualification.
