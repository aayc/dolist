#!/usr/bin/env bash
# Smoke-tests a Linux bundle without installing it: unpacks it into a temporary folder, starts the
# sync service and the daemon (mock agent, always-on placement, sync on, a remote host configured)
# on free loopback ports with a temporary home and vault, runs smoke-check.mjs against both
# (including pairing a device), and shuts them down. CI runs it on every bundle; it also runs on
# macOS. Nothing outside the temporary folder is used.
#
#   deploy/linux/smoke-test.sh <ddl-linux-<arch>.tar.gz>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_HOST=vm-name.tailnet-name.ts.net
START_TIMEOUT_S=30

fail() {
  echo "smoke-test: $*" >&2
  exit 1
}

[ $# -eq 1 ] || fail "usage: $0 <ddl-linux-<arch>.tar.gz>"
BUNDLE_FILE="$1"
[ -f "$BUNDLE_FILE" ] || fail "no such file: $BUNDLE_FILE"
command -v node >/dev/null 2>&1 || fail "needs Node.js 24.4+"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ddl-smoke.XXXXXX")"
SYNC_PID=""
DAEMON_PID=""
cleanup() {
  status=$?
  for pid in "$DAEMON_PID" "$SYNC_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null && sleep 0.5; done
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  if [ "$status" -ne 0 ]; then
    for log in sync daemon; do
      if [ -f "$WORK/$log.log" ]; then
        echo "--- $log.log (last 40 lines) ---" >&2
        tail -n 40 "$WORK/$log.log" >&2
      fi
    done
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# Waits for the line announcing the process's URL in its log; prints the URL.
wait_for_url() {
  local pid="$1" log="$2" pattern="$3" url="" deadline=$((SECONDS + START_TIMEOUT_S))
  while [ -z "$url" ]; do
    kill -0 "$pid" 2>/dev/null || fail "$(basename "$log" .log) exited during startup"
    [ "$SECONDS" -lt "$deadline" ] || fail "$(basename "$log" .log) didn't start in ${START_TIMEOUT_S}s"
    sleep 0.2
    url="$(sed -n "s|.*$pattern \(http://127\.0\.0\.1:[0-9]*\).*|\1|p" "$log" | head -n 1)"
  done
  echo "$url"
}

# Sends SIGTERM and expects a clean exit (status 0) within 15 s.
stop() {
  local name="$1" pid="$2" deadline=$((SECONDS + 15)) status=0
  kill -TERM "$pid"
  while kill -0 "$pid" 2>/dev/null; do
    [ "$SECONDS" -lt "$deadline" ] || fail "$name didn't stop within 15s of SIGTERM"
    sleep 0.2
  done
  wait "$pid" || status=$?
  [ "$status" -eq 0 ] || fail "$name exited with status $status after SIGTERM"
  echo "$name stopped cleanly"
}

tar -xzf "$BUNDLE_FILE" -C "$WORK"
BUNDLE="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d -name 'ddl-linux-*' | head -n 1)"
[ -n "$BUNDLE" ] || fail "$BUNDLE_FILE is not a ddl-linux-<arch>.tar.gz bundle"
HELPER="$BUNDLE/deploy/setup-helper.mjs"
HOME_DIR="$WORK/home"
DDL_HOME_DIR="$WORK/ddl-home"
VAULT_DIR="$WORK/vault"
SYNC_DB="$WORK/sync/sync.db"
mkdir -p "$HOME_DIR" "$DDL_HOME_DIR" "$VAULT_DIR" "$WORK/sync"
chmod 0700 "$HOME_DIR" "$DDL_HOME_DIR" "$VAULT_DIR" "$WORK/sync"
echo "Bundle $(node "$HELPER" bundle "$BUNDLE") unpacked"

# The processes get a minimal environment, from the temporary folder: the caller's DDL_* variables,
# API keys, home and working directory (whose .env.local the daemon would read) stay out.
isolated() { cd "$WORK" && exec env -i PATH="$PATH" HOME="$HOME_DIR" "$@"; }

VAULT_ID="$( (isolated node "$BUNDLE/sync/dist/main.js" vault create --name Smoke --db "$SYNC_DB" \
  --json) | (isolated node "$HELPER" save-sync-token --file "$DDL_HOME_DIR/sync-token"))"

(isolated node "$BUNDLE/sync/dist/main.js" serve --db "$SYNC_DB" --port 0) >"$WORK/sync.log" 2>&1 &
SYNC_PID=$!
SYNC_URL="$(wait_for_url "$SYNC_PID" "$WORK/sync.log" "listening on")"
echo "Sync service at $SYNC_URL"

# The same config.json as setup.sh writes: always-on placement, the remote host, the local sync
# service. Only the port comes from the environment (0: a free one).
(isolated node "$HELPER" write-config --file "$DDL_HOME_DIR/config.json" --vault-path "$VAULT_DIR" \
  --placement always_on_host --remote-host "$REMOTE_HOST" \
  --sync-url "$SYNC_URL" --sync-vault "$VAULT_ID")
(isolated DDL_HOME="$DDL_HOME_DIR" DDL_PORT=0 DDL_AGENT_MODE=mock \
  node "$BUNDLE/daemon/dist/main.js") >"$WORK/daemon.log" 2>&1 &
DAEMON_PID=$!
DAEMON_URL="$(wait_for_url "$DAEMON_PID" "$WORK/daemon.log" "running at")"
echo "Daemon at $DAEMON_URL"
# As setup.sh does once the daemon runs: the vault's settings name it the always-on machine.
(isolated node "$HELPER" set-machine --daemon-url "$DAEMON_URL" \
  --token-file "$DDL_HOME_DIR/daemon-token" --host "$REMOTE_HOST") >/dev/null

(isolated node "$SCRIPT_DIR/smoke-check.mjs" --daemon "$DAEMON_URL" \
  --token-file "$DDL_HOME_DIR/daemon-token" --sync "$SYNC_URL" --sync-vault "$VAULT_ID" \
  --sync-token-file "$DDL_HOME_DIR/sync-token" --bundle "$BUNDLE" --remote-host "$REMOTE_HOST" \
  --cli-env DDL_HOME="$DDL_HOME_DIR" --cli-env DDL_PORT="${DAEMON_URL##*:}")

stop daemon "$DAEMON_PID"
DAEMON_PID=""
stop "sync service" "$SYNC_PID"
SYNC_PID=""
echo "Smoke test passed"
