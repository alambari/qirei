#!/usr/bin/env bash
# Frees build leftovers: the incremental cache, old example binaries, big old test binaries (only
# below 12 GB free) and worktrees whose branch is merged. Prints the free space before and after. Exit 3 when less than 10 GB is free afterwards;
# the caller then runs `cargo clean` and tells the owner.
#
#   scripts/disk-sweep.sh [--dry-run]
set -euo pipefail

DRY=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *)
    echo "usage: scripts/disk-sweep.sh [--dry-run]" >&2
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
# A wrong CARGO_TARGET_DIR must never make this delete something that is not a build folder.
if [ ! -d "$TARGET" ] || [ "$(basename "$TARGET")" != "target" ] || [ "$TARGET" = "/" ] || [ "$TARGET" = "$HOME" ]; then
  echo "disk-sweep: refusing '$TARGET': not a folder named target" >&2
  exit 1
fi

free_gb() { df -g / | awk 'NR==2 {print $4}'; }
echo "free before: $(free_gb) GB"

remove() {
  if [ "$DRY" -eq 1 ]; then
    echo "would remove $1"
  else
    # -P: a link inside is removed as a link, never followed.
    rm -rf -P -- "$1"
    echo "removed $1"
  fi
}

[ -d "$TARGET/debug/incremental" ] && remove "$TARGET/debug/incremental"

if [ -d "$TARGET/debug/examples" ]; then
  while IFS= read -r file; do
    remove "$file"
  done < <(find "$TARGET/debug/examples" -maxdepth 1 -type f -name '*-????????????????' -mtime +1)
fi

# Test and app binaries of older builds: the build folder keeps one per hash and each one is tens
# of megabytes. Only when free space is already under 12 GB, and only executables of 20 MB or
# more, never a library: the next test run links what it needs again.
if [ "$(free_gb)" -lt 12 ] && [ -d "$TARGET/debug/build" ]; then
  while IFS= read -r file; do
    remove "$file"
  done < <(find "$TARGET/debug/build" -type f -size +20M -perm +111 \
    ! -name '*.rlib' ! -name '*.rmeta' ! -name '*.dylib' ! -name '*.a')
fi

# Old builds of our own crates pile up (one set per feature combination and per edit) and were the
# largest part of target/ (36 GB once). Below 12 GB free, drop every artifact of the workspace
# crates only: GPUI and the other dependencies stay, so the next build is minutes, not an hour.
# Only for the repository's own target folder, never for a folder named by CARGO_TARGET_DIR.
if [ "$(free_gb)" -lt 12 ] && [ "$TARGET" = "$ROOT/target" ] && command -v cargo >/dev/null 2>&1; then
  args=()
  for dir in "$ROOT"/crates/*/; do
    [ -f "$dir/Cargo.toml" ] || continue
    name="$(sed -n 's/^name *= *"\(.*\)"/\1/p' "$dir/Cargo.toml" | head -1)"
    [ -n "$name" ] && args+=(-p "$name")
  done
  if [ "${#args[@]}" -gt 0 ]; then
    if [ "$DRY" -eq 1 ]; then
      echo "would run: cargo clean ${args[*]}"
    else
      (cd "$ROOT" && cargo clean "${args[@]}" 2>&1 | tail -1)
    fi
  fi
fi

# Linked worktrees (crew) whose branch is already merged into the main branch.
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  main="$(git -C "$ROOT" rev-parse --show-toplevel)"
  path=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) path="${line#worktree }" ;;
      "branch refs/heads/"*)
        branch="${line#branch refs/heads/}"
        if [ "$path" != "$main" ] && [ "$branch" != "main" ] \
          && git -C "$ROOT" merge-base --is-ancestor "$branch" main 2>/dev/null; then
          if [ "$DRY" -eq 1 ]; then
            echo "would remove worktree $path"
          else
            git -C "$ROOT" worktree remove --force "$path" && echo "removed worktree $path"
          fi
        fi
        ;;
    esac
  done < <(git -C "$ROOT" worktree list --porcelain)
  [ "$DRY" -eq 1 ] || git -C "$ROOT" worktree prune
fi

after="$(free_gb)"
echo "free after: $after GB"
if [ "$after" -lt 10 ]; then
  echo "disk-sweep: less than 10 GB free; run cargo clean and tell the owner" >&2
  exit 3
fi
