/** @type {import("semantic-release").GlobalConfig} */
export default {
  branches: ["main"],
  repositoryUrl: "https://github.com/gadicc/watchbound",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      { preset: "conventionalcommits" },
    ],
    [
      "@semantic-release/release-notes-generator",
      { preset: "conventionalcommits" },
    ],
    "./scripts/semantic-release-watchbound.mjs",
    [
      "@semantic-release/github",
      {
        assets: [
          {
            path: "dist/tarballs/*.tgz",
            label: "Inspected npm package",
          },
          {
            path: "dist/evidence/SHA256SUMS",
            label: "SHA-256 package checksums",
          },
          {
            path: "dist/evidence/release-metadata.json",
            label: "Release build metadata",
          },
          {
            path: "dist/evidence/*.cdx.json",
            label: "CycloneDX 1.6 SBOM",
          },
        ],
      },
    ],
  ],
};
