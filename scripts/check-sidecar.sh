#!/usr/bin/env bash
# Builds and tests the Claude sidecar, the code that turns the daemon's permission answers into SDK
# decisions, and checks that its copy of the protocol bindings matches the generated ones.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! diff -r crates/runtimes/bindings sidecars/claude/src/generated; then
  echo "error: sidecars/claude/src/generated differs from crates/runtimes/bindings." >&2
  echo "Run 'npm run bindings' in sidecars/claude and commit the result." >&2
  exit 1
fi

cd sidecars/claude
# --ignore-scripts: no dependency may run code during install.
npm ci --ignore-scripts
npm run build
npm test
