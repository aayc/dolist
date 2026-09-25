#!/usr/bin/env bash
# Installs a Linux bundle with setup.sh on a disposable Ubuntu machine with systemd (a CI runner,
# or a throwaway VM such as an OrbStack machine) and checks the result: the service user, folder
# and secret modes, config.json, the release layout, the units (systemd-analyze verify), a second
# run changing nothing, both services running under their hardened units, and no token in
# setup.sh's output or the journal. It changes the machine (a system user, /opt/ddl, /var/lib/ddl,
# units), so it runs only with CI=true or DDL_SETUP_TEST_DISPOSABLE=1.
#
#   sudo --preserve-env=CI deploy/linux/setup-test.sh <ddl-linux-<arch>.tar.gz>
#
# SETUP_TEST_PORT and SETUP_TEST_SYNC_PORT run the services on other ports than 7331 and 7332
# (through setup.sh --port and --sync-port), e.g. in an OrbStack machine, whose loopback ports
# OrbStack forwards to the Mac's.
set -euo pipefail

REMOTE_HOST=vm-name.tailnet-name.ts.net
STATE=/var/lib/ddl
DDL_HOME_DIR="$STATE/.daily-do-list"
CONFIG="$DDL_HOME_DIR/config.json"
PORT="${SETUP_TEST_PORT:-7331}"
SYNC_PORT="${SETUP_TEST_SYNC_PORT:-7332}"

fail() {
  echo "setup-test: $*" >&2
  exit 1
}
pass() { echo "ok    $*"; }

if [ "${CI:-}" != true ] && [ "${DDL_SETUP_TEST_DISPOSABLE:-}" != 1 ]; then
  fail "only on a disposable machine (CI=true or DDL_SETUP_TEST_DISPOSABLE=1): it installs services"
fi
[ "$(id -u)" -eq 0 ] || fail "run it as root"
if [ $# -ne 1 ] || [ ! -f "$1" ]; then fail "usage: $0 <ddl-linux-<arch>.tar.gz>"; fi
BUNDLE_FILE="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

WORK="$(mktemp -d)"
on_exit() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- journal ---" >&2
    journalctl -u ddl-daemon -u ddl-sync --no-pager -n 80 >&2 || true
    systemctl stop ddl-daemon ddl-sync 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap on_exit EXIT

as_ddl() { (cd "$STATE" && runuser -u ddl -- env HOME="$STATE" "$@"); }
helper() { as_ddl node /opt/ddl/current/deploy/setup-helper.mjs "$@"; }
expect_mode() {
  local path="$1" want="$2" got
  got="$(stat -c '%a %U:%G' "$path")"
  [ "$got" = "$want" ] || fail "$path is $got, expected $want"
}
expect_config() {
  local got
  got="$(helper read-config --file "$CONFIG" --key "$1")"
  [ "$got" = "$2" ] || fail "config.json $1 is '$got', expected '$2'"
}
settings_fingerprint() {
  sha256sum "$CONFIG" "$DDL_HOME_DIR/sync-token" /etc/ddl/ddl.env /etc/ddl/sync.env
}
fingerprint() {
  settings_fingerprint
  readlink /opt/ddl/current
}

tar -xzf "$BUNDLE_FILE" -C "$WORK"
SETUP="$(find "$WORK" -mindepth 3 -maxdepth 3 -path '*/deploy/setup.sh' | head -n 1)"
[ -n "$SETUP" ] || fail "no deploy/setup.sh in the bundle"
SETUP_ARGS=(--host "$REMOTE_HOST" --vault-name CI --skip-browser --no-start)
if [ "$PORT" != 7331 ]; then SETUP_ARGS+=(--port "$PORT"); fi
if [ "$SYNC_PORT" != 7332 ]; then SETUP_ARGS+=(--sync-port "$SYNC_PORT"); fi

# 1. First run ------------------------------------------------------------------------------------
"$SETUP" "${SETUP_ARGS[@]}" | tee "$WORK/setup-1.log"
pass "setup.sh ran"

[ "$(getent passwd ddl | cut -d: -f6,7)" = "$STATE:/usr/sbin/nologin" ] ||
  fail "ddl should be a system user with home $STATE and no login shell"
for dir in "$STATE" "$DDL_HOME_DIR" "$STATE/DailyDoList" "$STATE/sync"; do
  expect_mode "$dir" "700 ddl:ddl"
done
expect_mode /etc/ddl/ddl.env "600 ddl:ddl"
expect_mode "$DDL_HOME_DIR/sync-token" "600 ddl:ddl"
expect_mode "$CONFIG" "600 ddl:ddl"
expect_mode /etc/ddl/sync.env "644 root:root"
pass "service user, folders 0700, secrets 0600"

expect_config agent.placement always_on_host
expect_config remote.hosts.0 "$REMOTE_HOST"
expect_config sync.kind remote
expect_config sync.url "http://127.0.0.1:$SYNC_PORT"
expect_config port "$PORT"
grep -qx "DDL_SYNC_PORT=$SYNC_PORT" /etc/ddl/sync.env || fail "sync.env doesn't set $SYNC_PORT"
expect_config vaultPath "$STATE/DailyDoList"
[ -n "$(helper read-config --file "$CONFIG" --key sync.vault)" ] || fail "config.json has no sync.vault"
pass "config.json"

release="$(readlink /opt/ddl/current)"
case "$release" in releases/*) ;; *) fail "/opt/ddl/current points at $release" ;; esac
[ "$(stat -c '%U:%G' /opt/ddl/current/daemon/dist/main.js)" = root:root ] ||
  fail "the bundle isn't owned by root"
writable="$(find "/opt/ddl/$release" ! -type l -perm /022 | head -n 3)"
[ -z "$writable" ] || fail "writable by group or others: $writable"
if as_ddl test -w /opt/ddl/current/daemon/dist/main.js; then fail "ddl can modify the bundle"; fi
pass "bundle in /opt/ddl/$release, read-only for ddl"

# Without --recursive-errors, verify exits 0 whatever it finds; "no" fails on our units' warnings.
systemd-analyze verify --recursive-errors=no /etc/systemd/system/ddl-sync.service \
  /etc/systemd/system/ddl-daemon.service
[ "$(systemctl is-enabled ddl-sync ddl-daemon | sort -u)" = enabled ] || fail "units not enabled"
pass "units verified and enabled"

# 2. A second run changes nothing -----------------------------------------------------------------
fingerprint >"$WORK/before"
"$SETUP" "${SETUP_ARGS[@]}" >"$WORK/setup-2.log"
fingerprint >"$WORK/after"
diff "$WORK/before" "$WORK/after" || fail "the second run changed the config, a token or the release"
vaults="$(as_ddl node /opt/ddl/current/sync/dist/main.js vault list --db "$STATE/sync/sync.db" --json |
  node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(0, "utf8")).length))')"
[ "$vaults" = 1 ] || fail "expected one sync vault, found $vaults"
pass "second run: idempotent"

# The installed copy reconfigures in place, without a bundle.
/opt/ddl/current/deploy/setup.sh "${SETUP_ARGS[@]}" >"$WORK/setup-3.log"
fingerprint >"$WORK/after-installed"
diff "$WORK/before" "$WORK/after-installed" || fail "the installed setup.sh changed something"
pass "installed setup.sh: runs in place, changes nothing"

# An upgrade through --bundle: this bundle again, under another release id.
mkdir -p "$WORK/next"
tar -xzf "$BUNDLE_FILE" -C "$WORK/next"
next_dir="$(find "$WORK/next" -mindepth 1 -maxdepth 1 -type d -name 'ddl-linux-*')"
node -e '
const fs = require("node:fs");
const info = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
fs.writeFileSync(process.argv[1], JSON.stringify({ ...info, release: info.release + "-next" }));
' "$next_dir/bundle.json"
tar -czf "$WORK/next.tar.gz" -C "$WORK/next" "$(basename "$next_dir")"
previous="$(readlink /opt/ddl/current)"
/opt/ddl/current/deploy/setup.sh --bundle "$WORK/next.tar.gz" "${SETUP_ARGS[@]}" >"$WORK/setup-4.log"
[ "$(readlink /opt/ddl/current)" = "$previous-next" ] || fail "--bundle didn't switch releases"
[ -d "/opt/ddl/$previous" ] || fail "the previous release wasn't kept for a rollback"
settings_fingerprint | diff <(head -n 4 "$WORK/before") - ||
  fail "the upgrade changed the config or a token"
pass "upgrade through --bundle: new release current, previous kept, settings unchanged"

# 3. The services, under their hardened units ------------------------------------------------------
systemctl start ddl-sync
helper wait-healthy --url "http://127.0.0.1:$SYNC_PORT/v1/health"
pass "ddl-sync running on port $SYNC_PORT"

# FOLLOW-UP for the lead: once the daemon accepts agent.placement and remote.hosts (the placement
# and remote-access streams), delete this override so that the unit runs on the config.json
# setup.sh wrote. Until then the daemon rejects those keys, so it runs on a copy without them.
ci_home="$STATE/ci-home"
install -d -m 0700 -o ddl -g ddl "$ci_home"
as_ddl node -e '
const fs = require("node:fs");
const { agent, remote, ...config } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
fs.writeFileSync(process.argv[2], JSON.stringify(config), { mode: 0o600 });
' "$CONFIG" "$ci_home/config.json"
install -m 0600 -o ddl -g ddl "$DDL_HOME_DIR/sync-token" "$ci_home/sync-token"
mkdir -p /etc/systemd/system/ddl-daemon.service.d
printf '[Service]\nEnvironment=DDL_HOME=%s\n' "$ci_home" >/etc/systemd/system/ddl-daemon.service.d/ci.conf
systemctl daemon-reload
daemon_home="$ci_home"

systemctl start ddl-daemon
helper wait-healthy --url "http://127.0.0.1:$PORT/api/health" \
  --token-file "$daemon_home/daemon-token"
index="$(curl -fsS "http://127.0.0.1:$PORT/")"
grep -q '<meta name="ddl-token"' <<<"$index" || fail "the daemon doesn't serve the web app"
pass "ddl-daemon running on port $PORT and serving the web app"

# The sandbox is in effect, seen from inside each service's mount namespace as its user.
# Containers can switch it off for every service (OrbStack's LXC machines do, with a drop-in).
protect="$(systemctl show -p ProtectSystem --value ddl-daemon)"
[ "$protect" = strict ] ||
  fail "systemd's sandboxing is overridden here (ProtectSystem=$protect); see deploy/linux/README.md"
daemon_pid="$(systemctl show -p MainPID --value ddl-daemon)"
sync_pid="$(systemctl show -p MainPID --value ddl-sync)"
in_service() {
  local pid="$1"
  shift
  nsenter -t "$pid" -m setpriv --reuid=ddl --regid=ddl --clear-groups "$@"
}
for pid in "$daemon_pid" "$sync_pid"; do
  grep -q '^NoNewPrivs:[[:space:]]*1$' "/proc/$pid/status" || fail "pid $pid can gain privileges"
  [[ "$(nsenter -t "$pid" -m findmnt -no OPTIONS -T /usr)" == ro* ]] || fail "/usr is writable"
  if in_service "$pid" ls /home >/dev/null 2>&1; then fail "pid $pid can read /home"; fi
done
in_service "$daemon_pid" touch "$daemon_home/sandbox-probe" || fail "the daemon can't write its home"
rm -f "$daemon_home/sandbox-probe"
in_service "$daemon_pid" touch /tmp/ddl-sandbox-probe
[ ! -e /tmp/ddl-sandbox-probe ] || fail "the daemon's /tmp isn't private"
if in_service "$sync_pid" touch "$DDL_HOME_DIR/sandbox-probe" 2>/dev/null; then
  fail "the sync service can write the daemon's home"
fi
in_service "$sync_pid" touch "$STATE/sync/sandbox-probe" || fail "the sync service can't write its folder"
rm -f "$STATE/sync/sandbox-probe"
pass "sandbox: no new privileges, read-only system, no /home, private /tmp, only their own folders"
for unit in ddl-daemon ddl-sync; do
  systemd-analyze security --no-pager "$unit.service" | grep -i 'overall exposure' || true
done

systemctl stop ddl-daemon ddl-sync
for unit in ddl-daemon ddl-sync; do
  if systemctl is-failed --quiet "$unit"; then fail "$unit failed when stopped"; fi
done
pass "both stop cleanly"

# 4. No token in setup.sh's output or the journal --------------------------------------------------
for token in "$DDL_HOME_DIR/sync-token" "$daemon_home/daemon-token"; do
  if grep -qF -f "$token" "$WORK"/setup-*.log; then
    fail "setup.sh printed the token in $(basename "$token")"
  fi
  if journalctl -u ddl-daemon -u ddl-sync --no-pager | grep -qF -f "$token"; then
    fail "the journal contains the token in $(basename "$token")"
  fi
done
pass "no token in setup.sh's output or the journal"
echo "Setup test passed"
