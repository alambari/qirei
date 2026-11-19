#!/usr/bin/env bash
# Tests for scripts/e2e-real.sh: --print, the refusals and the scratch setup. Never starts a
# daemon or the app.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/private/tmp}/qirei-e2e-tests.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }

out="$("$SCRIPTS/e2e-real.sh" --print 2>&1)" || true
for want in QIREI_PROFILE=dev QIREI_CONFIG= QIREI_DATA_DIR= QIREI_TOKEN_FILE= QIREI_E2E_REAL=1; do
  if printf '%s' "$out" | grep -q "$want"; then ok "--print shows $want"; else bad "--print shows $want: $out"; fi
done

for want in "throwaway Postgres" "e2e-run.toml" E2E_READPATH_MARKER; do
  if printf '%s' "$out" | grep -q "$want"; then ok "--print lists $want"; else bad "--print lists $want: $out"; fi
done

for var in QIREI_CONFIG QIREI_DATA_DIR QIREI_TOKEN_FILE; do
  if out="$(env "$var=/x" "$SCRIPTS/e2e-real.sh" --print 2>&1)"; then
    bad "refuses when $var is already set"
  elif printf '%s' "$out" | grep -q "$var"; then
    ok "refuses when $var is already set and names it"
  else
    bad "refuses when $var is already set and names it: $out"
  fi
done

if "$SCRIPTS/e2e-real.sh" bogus >/dev/null 2>&1; then bad "unknown command is refused"; else ok "unknown command is refused"; fi

# Setup without the app: the scratch repository, its local remote and the config copy.
export E2E_ROOT="$SCRATCH/root"
export E2E_CONFIG="$SCRATCH/e2e.toml"
export E2E_DATA_DIR="$SCRATCH/data"
"$SCRIPTS/e2e-real.sh" setup --no-app >/dev/null 2>&1 || bad "setup --no-app runs"
if [ -d "$E2E_ROOT/example-repo/.git" ] && [ -d "$E2E_ROOT/remote.git" ] \
  && [ "$(git -C "$E2E_ROOT/example-repo" rev-list --count HEAD)" = 1 ] \
  && [ "$(git -C "$E2E_ROOT/example-repo" remote get-url origin)" = "https://example.invalid/example.git" ] \
  && [ "$(git -C "$E2E_ROOT/example-repo" rev-parse --abbrev-ref main@{upstream})" = "origin/main" ] \
  && [ "$(git -C "$E2E_ROOT/example-repo" config user.name)" = "e2e" ]; then
  ok "setup makes the scratch repository with one commit, a tracking branch and an unreachable https remote"
else
  bad "setup makes the scratch repository with one commit, a tracking branch and an unreachable https remote"
fi
if [ -f "$E2E_CONFIG" ] && ! grep -q '@[A-Z_]*@' "$E2E_CONFIG" && grep -q "$E2E_ROOT/example-repo" "$E2E_CONFIG"; then
  ok "setup copies the config and fills its placeholders"
else
  bad "setup copies the config and fills its placeholders"
fi
echo "# mine" >>"$E2E_CONFIG"
"$SCRIPTS/e2e-real.sh" setup --no-app >/dev/null 2>&1 || true
if grep -q '# mine' "$E2E_CONFIG"; then ok "setup keeps a config that already exists"; else bad "setup keeps a config that already exists"; fi
if [ "$(git -C "$E2E_ROOT/example-repo" rev-list --count HEAD)" = 1 ]; then
  ok "setup twice does not add commits"
else
  bad "setup twice does not add commits"
fi

# An existing config without a [lark] table gets exactly one; one with it is left untouched.
lark_count() { grep -c '^\[lark\]' "$E2E_CONFIG" || true; }
if [ "$(lark_count)" = 1 ]; then ok "a new config has one [lark] table"; else bad "a new config has one [lark] table"; fi
before="$(cat "$E2E_CONFIG")"
"$SCRIPTS/e2e-real.sh" setup --no-app >/dev/null 2>&1 || true
if [ "$before" = "$(cat "$E2E_CONFIG")" ]; then ok "a config with a [lark] table is left untouched"; else bad "a config with a [lark] table is left untouched"; fi
grep -v '^\[lark\]' "$E2E_CONFIG" >"$SCRATCH/old.toml"
cp "$SCRATCH/old.toml" "$E2E_CONFIG"
lines_before="$(wc -l <"$E2E_CONFIG")"
cp "$E2E_CONFIG" "$SCRATCH/before.toml"
"$SCRIPTS/e2e-real.sh" setup --no-app >/dev/null 2>&1 || true
"$SCRIPTS/e2e-real.sh" setup --no-app >/dev/null 2>&1 || true
if [ "$(lark_count)" = 1 ] && [ "$(tail -n 2 "$E2E_CONFIG")" = "$(printf '[lark]\npoll_seconds = 120')" ] \
  && [ "$(head -n "$lines_before" "$E2E_CONFIG")" = "$(cat "$SCRATCH/before.toml")" ] \
  && [ "$(wc -l <"$E2E_CONFIG")" -eq $((lines_before + 2)) ]; then
  ok "a config without a [lark] table gets exactly two appended lines, once"
else
  bad "a config without a [lark] table gets exactly two appended lines, once"
fi

# run without a credential: names the fix, exit 2.
set +e
out="$("$SCRIPTS/e2e-real.sh" run 2>&1)"
code=$?
set -e
if [ "$code" = 2 ] && printf '%s' "$out" | grep -q 'Claude is not connected: run scripts/e2e-real.sh setup'; then
  ok "run without a credential says what to do and exits 2"
else
  bad "run without a credential says what to do and exits 2 (code $code): $out"
fi

# The throwaway Postgres: sourced from the script's own text, so no daemon or app starts.
PGFUNCS="$SCRATCH/pgfuncs.sh"
sed -n '/^find_pg_bin()/,/^make_scratch_repo()/p' "$SCRIPTS/e2e-real.sh" | sed '$d' >"$PGFUNCS"
printf '[agent]\nsidecar = "x"\n' >"$E2E_CONFIG"
before="$(cat "$E2E_CONFIG")"
run_pg() ( # a subshell: the functions and variables stay out of this test
  export E2E_ROOT E2E_CONFIG
  PG_BIN="" PG_STARTED="" RUN_CONFIG="$E2E_CONFIG"
  RUN_CONFIG_COPY="$(dirname "$E2E_CONFIG")/e2e-run.toml"
  # shellcheck disable=SC1090
  . "$PGFUNCS"
  "$@"
)
set +e
out="$(E2E_PG_BIN=/nonexistent run_pg start_readpath_pg 2>&1)"
code=$?
set -e
if [ "$code" = 1 ] && [ "$out" = "e2e-real.sh: initdb was not found: the read path scenario will skip" ] \
  && [ "$before" = "$(cat "$E2E_CONFIG")" ] && [ ! -e "$(dirname "$E2E_CONFIG")/e2e-run.toml" ]; then
  ok "without initdb the read path scenario skips with a fixed reason and nothing is written"
else
  bad "without initdb the read path scenario skips with a fixed reason (code $code): $out"
fi
if [ -n "$(unset E2E_PG_BIN; run_pg find_pg_bin)" ]; then
  set +e
  pg_cycle() {
    local code=0
    start_readpath_pg || code=$?
    stat -f %Lp "$E2E_ROOT/readpath.env" "$(dirname "$E2E_CONFIG")/e2e-run.toml"
    grep -c '^name = "example"' "$(dirname "$E2E_CONFIG")/e2e-run.toml"
    stop_pg
    echo "code=$code"
  }
  out="$(run_pg pg_cycle 2>&1)"
  set -e
  pid_left="$(pgrep -f "$E2E_ROOT/pg/data" || true)"
  if printf '%s' "$out" | tr '\n' ' ' | grep -q '600 600 1 code=0' && [ -z "$pid_left" ] \
    && [ "$before" = "$(cat "$E2E_CONFIG")" ] && ! grep -q readpath "$E2E_CONFIG"; then
    ok "the throwaway Postgres starts, the files are 0600, the owner's config is untouched and the server stops"
  else
    bad "the throwaway Postgres starts and stops cleanly: $out"
  fi
else
  echo "skip - no initdb here: the throwaway Postgres start is not tested"
fi

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
