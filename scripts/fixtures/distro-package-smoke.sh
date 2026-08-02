#!/bin/bash
set -Eeuo pipefail

phase() {
  printf 'WATCHBOUND_PACKAGE_SMOKE_PHASE=%s elapsed_seconds=%s\n' "$1" "$SECONDS"
}

phase runtime-validation-start
test -n "${WATCHBOUND_TARGET_ID:-}"
test -n "${WATCHBOUND_TARGET_PACKAGE:-}"
test -n "${WATCHBOUND_VERSION:-}"
test -n "${WATCHBOUND_NATIVE_SHA256:-}"
test -n "${WATCHBOUND_EVIDENCE:-}"

node=/watchbound-node/bin/node
npm=/watchbound-node/lib/node_modules/npm/bin/npm-cli.js
test "$($node --version)" = v24.15.0
test "$($node -p 'process.arch')" = "$WATCHBOUND_NODE_ARCH"
phase runtime-validation-complete

project="$(mktemp -d)"
cleanup() {
  phase cleanup-start
  rm -rf "$project"
  phase cleanup-complete
}
trap cleanup EXIT
wait_timeout_args=()
if [[ -n "${WATCHBOUND_WAIT_TIMEOUT_MS:-}" ]]; then
  wait_timeout_args=(--wait-timeout-ms "$WATCHBOUND_WAIT_TIMEOUT_MS")
fi
cd "$project"
printf '{"private":true,"type":"module"}\n' > package.json
phase package-install-start
"$node" "$npm" install \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  --offline \
  --save-exact \
  "/packages/$WATCHBOUND_TARGET_TARBALL" \
  "/packages/$WATCHBOUND_LOADER_TARBALL" \
  "/packages/$WATCHBOUND_WRAPPER_TARBALL"
phase package-install-complete

phase installed-smoke-start
"$node" /work/scripts/check-installed-package.mjs \
  --project "$project" \
  --wrapper watchbound \
  --version "$WATCHBOUND_VERSION" \
  --native-target "$WATCHBOUND_TARGET_ID" \
  --native-sha256 "$WATCHBOUND_NATIVE_SHA256" \
  --route "distro:$WATCHBOUND_LANE" \
  --evidence "$WATCHBOUND_EVIDENCE" \
  "${wait_timeout_args[@]}"
phase installed-smoke-complete
