export const WATCHBOUND_ADAPTER_LABEL =
  "Watchbound maintained-unpublished source-build package";

export const WATCHBOUND_BUILD_COMMAND = "pnpm build:node";

export const WATCHBOUND_SOURCE_INPUTS = Object.freeze([
  "Cargo.toml",
  "Cargo.lock",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "engine/Cargo.toml",
  "engine/src",
  "node/Cargo.toml",
  "node/build.rs",
  "node/src",
  "node/index.js",
  "node/index.d.ts",
  "node/load-native.cjs",
  "node/package.json",
  "js/automatic-reconciliation.js",
  "js/capabilities.js",
  "js/errors.js",
  "js/observed-state.js",
  "js/index.js",
  "js/index.d.ts",
  "js/package.json",
  "scripts/build-node.mjs",
]);
