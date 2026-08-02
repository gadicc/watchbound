#!/bin/bash
set -Eeuo pipefail

evidence=/tmp/watchbound-kernel-baseline-smoke.json

phase() {
  printf 'WATCHBOUND_KERNEL_BASELINE_GUEST_PHASE=%s elapsed_seconds=%s\n' \
    "$1" "$SECONDS"
}

finish() {
  local status="$1"
  trap - ERR
  phase "finish-$status"
  if [[ -f "$evidence" ]]; then
    printf 'WATCHBOUND_KERNEL_BASELINE_EVIDENCE='
    base64 -w0 "$evidence"
    printf '\n'
  fi
  printf 'WATCHBOUND_KERNEL_BASELINE_STATUS=%s\n' "$status"
  phase sync-start
  sync
  phase reboot
  echo b > /proc/sysrq-trigger
  while true; do sleep 3600; done
}

on_error() {
  local status="$?"
  printf 'Watchbound kernel-baseline guest failed with status %s at line %s\n' \
    "$status" "${BASH_LINENO[0]:-unknown}" >&2
  finish failed
}

trap on_error ERR

phase init-start
mountpoint -q /dev || mount -t devtmpfs devtmpfs /dev
mountpoint -q /proc || mount -t proc proc /proc
mountpoint -q /sys || mount -t sysfs sysfs /sys
mkdir -p /run /tmp
chmod 1777 /tmp
phase filesystems-ready

source /etc/watchbound-kernel-baseline.env
test "$(uname -s)" = Linux
test "$(uname -m)" = "$WATCHBOUND_UNAME_ARCHITECTURE"
test "$(uname -r)" = "$WATCHBOUND_KERNEL_RELEASE"
test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.35"
phase environment-validated

phase package-smoke-start
bash /work/scripts/fixtures/distro-package-smoke.sh
phase package-smoke-complete
finish passed
