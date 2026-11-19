#!/usr/bin/env bash
# The end-to-end profile with real services: a development daemon with its own data folder, port
# and token, real Claude on a small model with a spending limit, and a read-only GitLab token.
# It never touches production data, the owner's ~/.claude or any work repository: agent runs work
# in a scratch repository whose remote is an address nothing answers (the local bare folder only
# serves the first tracking branch).
#
#   scripts/e2e-real.sh setup [--no-app]   scratch repository, config, then the app for the one-time
#                                          credentials (--no-app stops before the app)
#   scripts/e2e-real.sh run                start the daemon, run the real scenarios, stop it; with
#                                          Postgres installed (initdb) it also starts a throwaway
#                                          one for the read path scenario and stops it again
#   scripts/e2e-real.sh stop               stop the e2e daemon
#   scripts/e2e-real.sh --print            show the environment and the commands, then exit
#
# Guide: docs/superpowers/spikes/e2e-real.md
set -euo pipefail

usage() {
  echo "usage: scripts/e2e-real.sh setup [--no-app] | run | stop | --print" >&2
}

COMMAND="${1:-}"
case "$COMMAND" in
  setup | run | stop | --print) ;;
  *)
    usage
    exit 2
    ;;
esac
if [ "$COMMAND" = setup ] && [ -n "${2:-}" ] && [ "${2:-}" != "--no-app" ]; then
  usage
  exit 2
fi

# The same rule as scripts/dev.sh: an inherited override could point this profile at other state.
for var in QIREI_DATA_DIR QIREI_CONFIG QIREI_TOKEN_FILE; do
  if [ -n "${!var+x}" ]; then
    echo "e2e-real.sh: $var is set in the environment; unset it first, so the e2e profile" >&2
    echo "cannot open another profile's files." >&2
    exit 1
  fi
done
if [ -z "${HOME:-}" ]; then
  echo "e2e-real.sh: HOME is not set" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E_ROOT="${E2E_ROOT:-$HOME/.cache/qirei-e2e}"
E2E_CONFIG="${E2E_CONFIG:-$HOME/.config/qirei/e2e.toml}"
# The daemon treats the folder of its config file as secret: the run copy must not sit in
# E2E_ROOT (the parent of the scratch repository), so it lives beside the owner's e2e config.
RUN_CONFIG_COPY="$(dirname "$E2E_CONFIG")/e2e-run.toml"
# Not under the cache folder: the credential lives here and a cache cleaner must not take it.
DATA_DIR="${E2E_DATA_DIR:-$HOME/Library/Application Support/Qirei-E2E}"
TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
REPO="$E2E_ROOT/example-repo"
SOCKET="$DATA_DIR/qireid.sock"

if [ "$COMMAND" = "--print" ]; then
  echo "QIREI_PROFILE=dev"
  echo "QIREI_CONFIG=$E2E_CONFIG"
  echo "QIREI_DATA_DIR=$DATA_DIR"
  echo "QIREI_TOKEN_FILE=$DATA_DIR/api-token"
  echo "QIREI_E2E_REAL=1 (run only)"
  echo "scratch repository: $REPO (remote: $E2E_ROOT/remote.git)"
  echo "throwaway Postgres: $E2E_ROOT/pg (initdb and pg_ctl from PATH or Homebrew; the read path scenario skips without them)"
  echo "read path config (run only): $RUN_CONFIG_COPY, a copy of the config plus a [readpath] table"
  echo "E2E_READPATH_MARKER=<generated at run time> (run only)"
  echo "daemon: nice -n 10 $TARGET/debug/qireid"
  echo "tests: cargo test -p qirei-app --test e2e -- --ignored --test-threads=1"
  exit 0
fi

export QIREI_PROFILE=dev
export QIREI_CONFIG="$E2E_CONFIG"
export QIREI_DATA_DIR="$DATA_DIR"
export QIREI_TOKEN_FILE="$DATA_DIR/api-token"
export E2E_ROOT
if ! command -v cargo >/dev/null 2>&1; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"

# The process that holds the daemon's lock file is the daemon.
daemon_pids() {
  if [ -e "$DATA_DIR/qireid.lock" ]; then
    lsof -t "$DATA_DIR/qireid.lock" 2>/dev/null || true
  fi
}

stop_daemon() {
  local pids pid i
  pids="$(daemon_pids)"
  [ -n "$pids" ] || return 0
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
  for i in $(seq 1 50); do
    [ -z "$(daemon_pids)" ] && return 0
    sleep 0.1
  done
  for pid in $(daemon_pids); do kill -KILL "$pid" 2>/dev/null || true; done
}

# The folder with initdb, pg_ctl and psql: on PATH, or a Homebrew install. Empty when none.
find_pg_bin() {
  local dir
  # E2E_PG_BIN names the only folder to look in (the script's test uses it).
  for dir in ${E2E_PG_BIN:-$(printf '%s' "$PATH" | tr ':' ' ') /opt/homebrew/opt/postgresql*/bin}; do
    if [ -x "$dir/initdb" ] && [ -x "$dir/pg_ctl" ] && [ -x "$dir/psql" ]; then
      echo "$dir"
      return 0
    fi
  done
  return 0
}

PG_BIN=""
PG_STARTED=""
RUN_CONFIG="$E2E_CONFIG"

# Stops only the throwaway server this script started, found by its own data folder.
stop_pg() {
  if [ -n "$PG_STARTED" ] && [ -n "$PG_BIN" ]; then
    "$PG_BIN/pg_ctl" -D "$E2E_ROOT/pg/data" -m fast -w stop >/dev/null 2>&1 || true
    PG_STARTED=""
  fi
}

cleanup() {
  stop_daemon
  stop_pg
  # The run's copy of the config names the throwaway credential file: it does not outlive the run.
  rm -f "$RUN_CONFIG_COPY"
}

# A throwaway Postgres in $E2E_ROOT/pg on a random loopback port, a read-only role with a password
# made now, a table of three rows, a 0600 credential file and a COPY of the config with a
# [readpath] table. The owner's config is never changed. Returns 1 with a fixed printed reason
# when the scenario cannot run; the run then goes on without it.
start_readpath_pg() {
  PG_BIN="$(find_pg_bin)"
  if [ -z "$PG_BIN" ]; then
    echo "e2e-real.sh: initdb was not found: the read path scenario will skip"
    return 1
  fi
  if grep -q '^\[readpath' "$E2E_CONFIG"; then
    echo "e2e-real.sh: the config has its own [readpath] table: the read path scenario will skip"
    return 1
  fi
  local pg="$E2E_ROOT/pg" port pass marker
  if [ -f "$pg/data/postmaster.pid" ]; then
    "$PG_BIN/pg_ctl" -D "$pg/data" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$pg"
  mkdir -p "$pg/sock" || return 1
  chmod 700 "$pg"
  port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')" || return 1
  pass="$(openssl rand -hex 12)" || return 1
  marker="e2e-marker-$(openssl rand -hex 8)" || return 1
  LC_ALL=C "$PG_BIN/initdb" -D "$pg/data" -U postgres --auth-local=trust --auth-host=scram-sha-256 \
    >/dev/null 2>&1 || { echo "e2e-real.sh: initdb failed: the read path scenario will skip"; return 1; }
  PG_STARTED=1
  "$PG_BIN/pg_ctl" -D "$pg/data" -w -l "$pg/server.log" \
    -o "-c listen_addresses=127.0.0.1 -c port=$port -c unix_socket_directories=$pg/sock" start \
    >/dev/null 2>&1 || { echo "e2e-real.sh: Postgres did not start: the read path scenario will skip"; return 1; }
  # The password is sent on standard input, never as an argument.
  "$PG_BIN/psql" -q -h "$pg/sock" -p "$port" -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<SQL || { echo "e2e-real.sh: seeding failed: the read path scenario will skip"; return 1; }
create database example;
\connect example
create role example_reader login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '$pass';
create table example_items (id int primary key, label text, secret_token text);
insert into example_items values (1, 'alpha', '$marker'), (2, 'beta', '$marker'), (3, 'gamma', '$marker');
grant connect on database example to example_reader;
grant usage on schema public to example_reader;
grant select on all tables in schema public to example_reader;
SQL
  (
    umask 077
    {
      echo "EXAMPLE_PG_HOST=127.0.0.1"
      echo "EXAMPLE_PG_PORT=$port"
      echo "EXAMPLE_PG_DATABASE=example"
      echo "EXAMPLE_PG_USER=example_reader"
      echo "EXAMPLE_PG_PASSWORD=$pass"
    } >"$E2E_ROOT/readpath.env"
    cp "$E2E_CONFIG" "$RUN_CONFIG_COPY"
  ) || return 1
  chmod 600 "$E2E_ROOT/readpath.env" "$RUN_CONFIG_COPY"
  {
    echo
    echo "[readpath]"
    echo "env_file = \"$E2E_ROOT/readpath.env\""
    echo
    echo "[[readpath.sources]]"
    echo 'name = "example"'
    echo 'engine = "postgres"'
    echo 'environment = "staging"'
    echo 'host_key = "EXAMPLE_PG_HOST"'
    echo 'port_key = "EXAMPLE_PG_PORT"'
    echo 'database_key = "EXAMPLE_PG_DATABASE"'
    echo 'user_key = "EXAMPLE_PG_USER"'
    echo 'password_key = "EXAMPLE_PG_PASSWORD"'
    echo 'tls = "disable"'
  } >>"$RUN_CONFIG_COPY"
  RUN_CONFIG="$RUN_CONFIG_COPY"
  export E2E_READPATH_MARKER="$marker"
  echo "e2e-real.sh: a throwaway Postgres is running for the read path scenario"
}

make_scratch_repo() {
  mkdir -p "$E2E_ROOT"
  if [ ! -d "$REPO/.git" ]; then
    mkdir -p "$REPO"
    git -C "$REPO" init -q -b main
    printf '# Example repository\n\nA scratch repository for the end-to-end runs.\n' >"$REPO/README.md"
    git -C "$REPO" add README.md
    git -C "$REPO" -c user.name=e2e -c user.email=e2e@example.invalid commit -q -m "Initial commit"
  fi
  if [ ! -d "$E2E_ROOT/remote.git" ]; then
    git init -q --bare -b main "$E2E_ROOT/remote.git"
  fi
  if ! git -C "$REPO" remote get-url origin >/dev/null 2>&1; then
    git -C "$REPO" remote add origin "$E2E_ROOT/remote.git"
  fi
  git -C "$REPO" push -q -u origin main 2>/dev/null || true
  # A run's home is its own, so git there needs an identity in the repository itself.
  git -C "$REPO" config user.name e2e
  git -C "$REPO" config user.email e2e@example.invalid
  # The push gate refuses a local or file remote on purpose. After the tracking branch exists, the
  # address becomes an https one that nothing answers, so the gate shows its card and a push
  # could never leave the machine.
  git -C "$REPO" remote set-url origin https://example.invalid/example.git
}

# An existing config that lacks a [lark] table gets exactly two lines appended; nothing else in it
# is read or changed, and a config that has the table is left alone.
add_lark_table() {
  if grep -q '^\[lark\]' "$E2E_CONFIG"; then
    return
  fi
  if [ -n "$(tail -c1 "$E2E_CONFIG")" ]; then
    echo >>"$E2E_CONFIG"
  fi
  printf '[lark]\npoll_seconds = 120\n' >>"$E2E_CONFIG"
  echo "e2e-real.sh: added a [lark] table to the config"
}

copy_config() {
  if [ -e "$E2E_CONFIG" ]; then
    echo "e2e-real.sh: keeping the config that exists: $E2E_CONFIG"
    add_lark_table
    return
  fi
  mkdir -p "$(dirname "$E2E_CONFIG")"
  sed -e "s|@REPO@|$ROOT|g" -e "s|@E2E_ROOT@|$E2E_ROOT|g" -e "s|@DATA_DIR@|$DATA_DIR|g" \
    "$ROOT/docs/superpowers/spikes/e2e-config.example.toml" >"$E2E_CONFIG"
  chmod 600 "$E2E_CONFIG"
  echo "e2e-real.sh: wrote $E2E_CONFIG; replace the GitLab placeholders in it by hand"
}

case "$COMMAND" in
  stop)
    stop_daemon
    ;;
  setup)
    mkdir -p "$DATA_DIR"
    chmod 700 "$DATA_DIR"
    make_scratch_repo
    copy_config
    echo "e2e-real.sh: scratch repository: $REPO"
    if [ "${2:-}" = "--no-app" ]; then
      exit 0
    fi
    if [ ! -f "$ROOT/sidecars/claude/dist/src/main.js" ]; then
      echo "e2e-real.sh: the sidecar is not built; run scripts/check-sidecar.sh first" >&2
      exit 1
    fi
    echo "e2e-real.sh: opening the app. In Settings > Connection save your Claude credential; in the"
    echo "Inbox save your GitLab read-only token. Then close the window."
    cd "$ROOT"
    nice -n 10 cargo build -p qirei-daemon --bin qireid
    trap stop_daemon EXIT
    nice -n 10 cargo run -p qirei-app --bin qirei
    ;;
  run)
    if [ ! -f "$E2E_CONFIG" ]; then
      echo "e2e-real.sh: no config at $E2E_CONFIG: run scripts/e2e-real.sh setup" >&2
      exit 2
    fi
    if [ ! -s "$DATA_DIR/credential" ]; then
      echo "Claude is not connected: run scripts/e2e-real.sh setup" >&2
      exit 2
    fi
    if [ ! -s "$DATA_DIR/gitlab-token" ]; then
      echo "e2e-real.sh: no GitLab token saved; the real GitLab scenario will skip" >&2
    fi
    cd "$ROOT"
    stop_daemon
    nice -n 10 cargo build -p qirei-daemon --bin qireid
    trap cleanup EXIT
    start_readpath_pg || true
    QIREI_CONFIG="$RUN_CONFIG" nice -n 10 "$TARGET/debug/qireid" >"$DATA_DIR/daemon.log" 2>&1 &
    for _ in $(seq 1 300); do
      [ -S "$SOCKET" ] && break
      sleep 0.1
    done
    if [ ! -S "$SOCKET" ]; then
      echo "e2e-real.sh: the daemon did not start; see $DATA_DIR/daemon.log" >&2
      exit 1
    fi
    QIREI_E2E_REAL=1 nice -n 10 cargo test -p qirei-app --test e2e -- --ignored --test-threads=1
    ;;
esac
