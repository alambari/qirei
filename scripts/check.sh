#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Cheapest rule first: no system path literal outside the platform module.
scripts/platform-boundary.sh
if ! command -v cargo >/dev/null 2>&1; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
# Incremental caches are large and a check runs once: keep them out unless the caller asks.
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace
