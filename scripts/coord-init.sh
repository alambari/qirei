#!/usr/bin/env bash
# Creates the coordination board and the four lane worktrees. Run once, from the main checkout, after the first commit.
#
#   scripts/coord-init.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The board is read by every session by absolute path, so it must live in the main checkout and be created only once.
if [ -n "$(git status --porcelain)" ]; then
  echo "coord-init: the working tree has uncommitted changes; commit or stash them first" >&2
  exit 1
fi

# Sibling folders of the checkout: worktrees share one repository, so the lead sees lane commits without a push.
LANES=("s2:agent-runtime" "s3:integrations" "s4:terminal-data" "s5:ui")
for entry in "${LANES[@]}"; do
  path="$ROOT/../qirei-${entry%%:*}"
  if [ -e "$path" ]; then
    echo "coord-init: $path already exists" >&2
    exit 1
  fi
done
if [ -e coord ]; then
  echo "coord-init: coord/ already exists" >&2
  exit 1
fi

mkdir -p coord/handoff

# Board line: PRD id | lane | owner session | state | note. The PRD set table in docs/PRD/README.md is the single source.
{
  echo "# Board"
  echo
  echo "<!-- id | lane | session | state (todo, doing, ready, merged, sent-back) | note -->"
  awk -F'|' '
    $2 ~ /^ *[A-Z][0-9][0-9] *$/ {
      id = $2; file = $3; session = $4
      gsub(/[ `]/, "", id); gsub(/[ `]/, "", file); gsub(/ /, "", session)
      split(file, parts, "/")
      printf "%s | %s | %s | todo |\n", id, parts[1], session
    }' docs/PRD/README.md
} > coord/board.md

if ! grep -q ' | todo |$' coord/board.md; then
  echo "coord-init: no PRD rows found in docs/PRD/README.md" >&2
  rm -rf coord
  exit 1
fi

{
  echo "# Requests"
  echo
  echo "Contract change requests and questions for the owner. One block per request: date, lane, what, why."
} > coord/requests.md

for entry in "${LANES[@]}"; do
  path="$ROOT/../qirei-${entry%%:*}"
  git worktree add -b "lane/${entry#*:}" "$path" main
done

echo
echo "Worktrees:"
for entry in "${LANES[@]}"; do
  (cd "$ROOT/../qirei-${entry%%:*}" && pwd)
done
