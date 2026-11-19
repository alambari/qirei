#!/usr/bin/env bash
# Tests for scripts/disk-sweep.sh. Each case uses a throwaway target folder.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/private/tmp}/qirei-sweep-tests.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }

new_target() {
  TARGET="$SCRATCH/t.$((PASS + FAIL))/target"
  mkdir -p "$TARGET/debug/incremental/crate-abc"
  echo x >"$TARGET/debug/incremental/crate-abc/file"
  mkdir -p "$TARGET/debug/deps"
  echo keep >"$TARGET/debug/deps/libkeep.rlib"
}

new_target
out="$(CARGO_TARGET_DIR="$TARGET" "$SCRIPTS/disk-sweep.sh" 2>&1)" || true
if [ ! -e "$TARGET/debug/incremental" ] && [ -e "$TARGET/debug/deps/libkeep.rlib" ]; then
  ok "removes the incremental cache and keeps the build products"
else
  bad "removes the incremental cache and keeps the build products: $out"
fi

new_target
out="$(CARGO_TARGET_DIR="$TARGET" "$SCRIPTS/disk-sweep.sh" --dry-run 2>&1)" || true
if [ -e "$TARGET/debug/incremental/crate-abc/file" ] && printf '%s' "$out" | grep -q 'incremental'; then
  ok "--dry-run keeps the files and names what it would remove"
else
  bad "--dry-run keeps the files and names what it would remove: $out"
fi

for bad_dir in / "$HOME" "$SCRATCH"; do
  if CARGO_TARGET_DIR="$bad_dir" "$SCRIPTS/disk-sweep.sh" --dry-run >/dev/null 2>&1; then
    bad "refuses the target folder $bad_dir"
  else
    ok "refuses the target folder $bad_dir"
  fi
done

new_target
mkdir -p "$SCRATCH/outside"
echo y >"$SCRATCH/outside/file"
ln -s "$SCRATCH/outside" "$TARGET/debug/incremental/link"
CARGO_TARGET_DIR="$TARGET" "$SCRIPTS/disk-sweep.sh" >/dev/null 2>&1 || true
if [ -e "$SCRATCH/outside/file" ]; then
  ok "never follows a link out of the target folder"
else
  bad "never follows a link out of the target folder"
fi

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
