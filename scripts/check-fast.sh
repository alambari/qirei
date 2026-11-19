#!/usr/bin/env bash
# The check without the GPUI crates (ui-kit, app): enough for core, store, engine, runtimes, api,
# client, daemon and local work, and much smaller to build. Run scripts/check.sh before a merge.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/platform-boundary.sh
if ! command -v cargo >/dev/null 2>&1; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
export CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}"
cargo fmt --check
cargo clippy --workspace --exclude qirei-ui-kit --exclude qirei-app --all-targets -- -D warnings
cargo test --workspace --exclude qirei-ui-kit --exclude qirei-app
