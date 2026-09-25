#!/usr/bin/env bash
# Installs or upgrades Daily Do List on an always-on Linux machine (Ubuntu LTS with systemd): the
# service user and its folders, the bundle, config.json with the always-on placement, a sync vault
# on the local sync service, Chromium for the agent's browser, and the systemd units. Running it
# again keeps the config, tokens, vault and sync database, and swaps in the given bundle.
# See deploy/linux/README.md.
#
#   sudo ./setup.sh [--bundle FILE] [--host NAME]... [--vault-name NAME] [--port N]
#                   [--sync-port N] [--skip-browser] [--no-start]
#
#   --bundle FILE    the ddl-linux-<arch>.tar.gz to install (default: the unpacked bundle that
#                    contains this script)
#   --host NAME      a name the daemon answers to besides loopback, such as its tailnet name
#                    vm-name.tailnet-name.ts.net (repeatable; default: the tailnet name from
#                    `tailscale status`, when Tailscale is up)
#   --vault-name N   name of the sync vault when it's created (default: Personal)
#   --port N         the daemon's loopback port (default: the configured one, else 7331)
#   --sync-port N    the sync service's loopback port (default: the configured one, else 7332)
#   --skip-browser   don't install Chromium and the system libraries it needs
#   --no-start       enable the services without (re)starting them
set -euo pipefail

SERVICE_USER=ddl
PREFIX=/opt/ddl
STATE=/var/lib/ddl
DDL_HOME_DIR="$STATE/.daily-do-list"
VAULT_DIR="$STATE/DailyDoList"
SYNC_DIR="$STATE/sync"
SYNC_DB="$SYNC_DIR/sync.db"
ENV_FILE=/etc/ddl/ddl.env
# The sync service's port, read by ddl-sync.service (not secret).
SYNC_ENV_FILE=/etc/ddl/sync.env
UNIT_DIR=/etc/systemd/system
DEFAULT_PORT=7331
DEFAULT_SYNC_PORT=7332
KEEP_RELEASES=3

# Physical paths: run as /opt/ddl/current/deploy/setup.sh, the bundle is the release it points to.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
BUNDLE_FILE=""
HOSTS=()
VAULT_NAME=Personal
PORT_ARG=""
SYNC_PORT_ARG=""
SKIP_BROWSER=0
NO_START=0

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; }
step() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() {
  echo "setup: $*" >&2
  exit 1
}
is_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

while [ $# -gt 0 ]; do
  case "$1" in
    --bundle)
      [ $# -ge 2 ] || fail "--bundle needs a ddl-linux-<arch>.tar.gz"
      BUNDLE_FILE="$2"
      shift
      ;;
    --host)
      [ $# -ge 2 ] || fail "--host needs a name such as vm-name.tailnet-name.ts.net"
      HOSTS+=("$2")
      shift
      ;;
    --vault-name)
      [ $# -ge 2 ] || fail "--vault-name needs a name"
      VAULT_NAME="$2"
      shift
      ;;
    --port | --sync-port)
      if [ $# -lt 2 ] || ! is_port "$2"; then fail "$1 needs a port number (1-65535)"; fi
      if [ "$1" = --port ]; then PORT_ARG="$2"; else SYNC_PORT_ARG="$2"; fi
      shift
      ;;
    --skip-browser) SKIP_BROWSER=1 ;;
    --no-start) NO_START=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown option: $1"
      ;;
  esac
  shift
done

[ "$(uname -s)" = Linux ] || fail "this sets up a Linux machine"
[ "$(id -u)" -eq 0 ] || fail "run it as root: sudo $0"
command -v systemctl >/dev/null 2>&1 || fail "needs systemd"
command -v runuser >/dev/null 2>&1 || fail "needs runuser (util-linux)"

# 1. Node.js, where the services find it (systemd's default PATH, not a home folder) ------------
step "Checking Node.js"
NODE=""
for dir in /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
  if [ -x "$dir/node" ]; then
    NODE="$dir/node"
    break
  fi
done
if [ -z "$NODE" ] || ! "$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number);
process.exit(a > 24 || (a === 24 && b >= 4) ? 0 : 1)'; then
  cat >&2 <<'EOF'
setup: Daily Do List needs Node.js 24.4 or newer, installed system-wide (the services don't see a
Node.js in a home folder, such as one from nvm). On Ubuntu, from NodeSource:

  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
  sudo bash /tmp/nodesource_setup.sh
  sudo apt-get install -y nodejs

Then run this script again.
EOF
  exit 1
fi
note "$NODE $("$NODE" --version)"

case "$(uname -m)" in
  x86_64 | amd64) MACHINE_ARCH=x64 ;;
  aarch64 | arm64) MACHINE_ARCH=arm64 ;;
  *) fail "unsupported CPU $(uname -m)" ;;
esac

# Runs a command as the service user, from its home, with its HOME: files it writes belong to it,
# and a symlink it could plant in its folders can't redirect a write made as root.
as_user() { (cd "$STATE" && runuser -u "$SERVICE_USER" -- env HOME="$STATE" "$@"); }

# 2. Service user and folders ------------------------------------------------------------------
step "Service user and folders"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$STATE" --shell /usr/sbin/nologin \
    --comment "Daily Do List" "$SERVICE_USER"
  note "created the system user $SERVICE_USER"
fi
for dir in "$STATE" "$DDL_HOME_DIR" "$VAULT_DIR" "$SYNC_DIR"; do
  [ -L "$dir" ] && fail "$dir is a symlink"
  mkdir -p "$dir"
  chown "$SERVICE_USER:$SERVICE_USER" "$dir"
  chmod 0700 "$dir"
done
mkdir -p "$(dirname "$ENV_FILE")" "$PREFIX/releases"
chmod 0755 "$(dirname "$ENV_FILE")" "$PREFIX" "$PREFIX/releases"
if [ ! -e "$ENV_FILE" ]; then
  (
    umask 077
    cat >"$ENV_FILE" <<'EOF'
# Environment of ddl-daemon.service: secrets such as model API keys. Keep it owned by ddl with mode
# 0600, and never copy it into the vault or a repository. After editing:
#   sudo systemctl restart ddl-daemon
#
# The Pi harness's model credential (not needed with the Cursor CLI signed in):
# OPENROUTER_API_KEY=
EOF
  )
  note "created $ENV_FILE"
fi
chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
chmod 0600 "$ENV_FILE"
note "$STATE (0700), $ENV_FILE (0600)"

# 3. The bundle: /opt/ddl/releases/<release>, /opt/ddl/current points at it --------------------
step "Installing the bundle"
INCOMING="$(mktemp -d "$PREFIX/releases/.incoming.XXXXXX")"
trap 'rm -rf "$INCOMING"' EXIT
if [ -n "$BUNDLE_FILE" ]; then
  [ -f "$BUNDLE_FILE" ] || fail "no such file: $BUNDLE_FILE"
  tar -xzf "$BUNDLE_FILE" -C "$INCOMING" --no-same-owner
  SOURCE="$(find "$INCOMING" -mindepth 1 -maxdepth 1 -type d -name 'ddl-linux-*' | head -n 1)"
  [ -n "$SOURCE" ] || fail "$BUNDLE_FILE is not a ddl-linux-<arch>.tar.gz bundle"
else
  SOURCE="$(cd "$SCRIPT_DIR/.." && pwd -P)"
  [ -f "$SOURCE/bundle.json" ] ||
    fail "pass --bundle ddl-linux-<arch>.tar.gz, or run the setup.sh inside an unpacked bundle"
fi
for file in bundle.json daemon/dist/main.js web/dist/index.html sync/dist/main.js \
  deploy/setup-helper.mjs deploy/ddl-daemon.service deploy/ddl-sync.service; do
  [ -f "$SOURCE/$file" ] || fail "the bundle has no $file"
done
info="$("$NODE" "$SOURCE/deploy/setup-helper.mjs" bundle "$SOURCE")"
RELEASE="${info% *}"
BUNDLE_ARCH="${info#* }"
[ "$BUNDLE_ARCH" = "$MACHINE_ARCH" ] ||
  fail "this is a linux-$BUNDLE_ARCH bundle; this machine needs linux-$MACHINE_ARCH"
TARGET="$(cd "$PREFIX/releases" && pwd -P)/$RELEASE"
if [ "$SOURCE" != "$TARGET" ]; then
  if [ -z "$BUNDLE_FILE" ]; then
    cp -a "$SOURCE" "$INCOMING/copy"
    SOURCE="$INCOMING/copy"
  fi
  chown -R root:root "$SOURCE"
  chmod -R u=rwX,go=rX "$SOURCE"
  rm -rf "$TARGET.previous"
  if [ -e "$TARGET" ]; then mv "$TARGET" "$TARGET.previous"; fi
  mv "$SOURCE" "$TARGET"
  rm -rf "$TARGET.previous"
fi
ln -sfn "releases/$RELEASE" "$PREFIX/current.new"
mv -T "$PREFIX/current.new" "$PREFIX/current"
CURRENT="$PREFIX/current"
HELPER="$CURRENT/deploy/setup-helper.mjs"
# Keep the newest releases for a rollback (repoint /opt/ddl/current, restart the services).
older=()
while IFS= read -r old; do older+=("$old"); done < <(
  find "$PREFIX/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' ! -name "$RELEASE" \
    -printf '%T@ %f\n' | sort -rn | cut -d' ' -f2-
)
for old in "${older[@]:$((KEEP_RELEASES - 1))}"; do rm -rf "${PREFIX:?}/releases/$old"; done
note "$TARGET"

# 4. Remote host: the tailnet name, unless given ------------------------------------------------
if [ ${#HOSTS[@]} -eq 0 ] && command -v tailscale >/dev/null 2>&1; then
  name="$(tailscale status --json 2>/dev/null | "$NODE" "$HELPER" tailnet-name || true)"
  if [ -n "$name" ]; then HOSTS+=("$name"); fi
fi

# 5. Sync vault and config.json -----------------------------------------------------------------
step "Sync vault and config"
CONFIG="$DDL_HOME_DIR/config.json"
SYNC_TOKEN="$DDL_HOME_DIR/sync-token"
SYNC_CLI="$CURRENT/sync/dist/main.js"
configured_port="$(as_user "$NODE" "$HELPER" read-config --file "$CONFIG" --key port)"
PORT="${PORT_ARG:-${configured_port:-$DEFAULT_PORT}}"
configured_url="$(as_user "$NODE" "$HELPER" read-config --file "$CONFIG" --key sync.url)"
configured_sync_port=""
if [[ "$configured_url" =~ ^http://127\.0\.0\.1:([0-9]+)$ ]]; then
  configured_sync_port="${BASH_REMATCH[1]}"
fi
SYNC_PORT="${SYNC_PORT_ARG:-${configured_sync_port:-$DEFAULT_SYNC_PORT}}"
SYNC_URL="http://127.0.0.1:$SYNC_PORT"
cat >"$SYNC_ENV_FILE" <<EOF
# The sync service's loopback port, for ddl-sync.service (setup.sh --sync-port).
DDL_SYNC_PORT=$SYNC_PORT
EOF
chmod 0644 "$SYNC_ENV_FILE"
sync_args=()
if [ -n "$configured_url" ] && [ -z "$configured_sync_port" ]; then
  note "config.json syncs with $configured_url; leaving sync as it is"
else
  vault_id="$(as_user "$NODE" "$HELPER" read-config --file "$CONFIG" --key sync.vault)"
  if [ -n "$vault_id" ] &&
    as_user "$NODE" "$SYNC_CLI" vault list --db "$SYNC_DB" --json |
    as_user "$NODE" "$HELPER" has-vault --id "$vault_id"; then
    if [ -s "$SYNC_TOKEN" ]; then
      note "vault $vault_id and its token are in place"
    else
      as_user "$NODE" "$SYNC_CLI" vault rotate-token --vault "$vault_id" --db "$SYNC_DB" --json |
        as_user "$NODE" "$HELPER" save-sync-token --file "$SYNC_TOKEN" >/dev/null
      note "vault $vault_id had no token here: rotated it (other devices need the new one)"
    fi
  else
    vault_id="$(as_user "$NODE" "$SYNC_CLI" vault create --name "$VAULT_NAME" --db "$SYNC_DB" --json |
      as_user "$NODE" "$HELPER" save-sync-token --file "$SYNC_TOKEN")"
    note "created the sync vault \"$VAULT_NAME\" ($vault_id); its token is in $SYNC_TOKEN (0600)"
  fi
  sync_args=(--sync-url "$SYNC_URL" --sync-vault "$vault_id")
fi
host_args=()
for host in "${HOSTS[@]}"; do host_args+=(--remote-host "$host"); done
as_user "$NODE" "$HELPER" write-config --file "$CONFIG" --vault-path "$VAULT_DIR" \
  --port "$PORT" --placement always_on_host "${sync_args[@]}" "${host_args[@]}"
remote_host="$(as_user "$NODE" "$HELPER" read-config --file "$CONFIG" --key remote.hosts.0)"
note "$CONFIG: port $PORT, placement always_on_host, remote host ${remote_host:-none}"
note "$SYNC_ENV_FILE: sync service port $SYNC_PORT"

# 6. Chromium for the agent's browser: Playwright's build, matching the bundled Playwright ------
if [ "$SKIP_BROWSER" = 0 ]; then
  step "Chromium for the agent's browser"
  PLAYWRIGHT="$CURRENT/daemon/node_modules/playwright-core/cli.js"
  browser_hint="run this again, or pass --skip-browser to finish without the agent's browser"
  "$NODE" "$PLAYWRIGHT" install-deps chromium ||
    fail "couldn't install Chromium's system libraries (above): $browser_hint"
  as_user "$NODE" "$PLAYWRIGHT" install --no-shell chromium ||
    fail "couldn't download Chromium (above; see Troubleshooting in the README): $browser_hint"
fi

# 7. systemd units ------------------------------------------------------------------------------
step "Services"
install -m 0644 -o root -g root "$CURRENT/deploy/ddl-sync.service" \
  "$CURRENT/deploy/ddl-daemon.service" "$UNIT_DIR/"
systemctl daemon-reload
systemctl enable --quiet ddl-sync.service ddl-daemon.service
if [ "$NO_START" = 0 ]; then
  systemctl restart ddl-sync.service ddl-daemon.service
  as_user "$NODE" "$HELPER" wait-healthy --url "$SYNC_URL/v1/health" ||
    fail "the sync service didn't start: journalctl -u ddl-sync -n 50"
  as_user "$NODE" "$HELPER" wait-healthy --url "http://127.0.0.1:$PORT/api/health" \
    --token-file "$DDL_HOME_DIR/daemon-token" ||
    fail "the daemon didn't start: journalctl -u ddl-daemon -n 50"
  note "ddl-sync and ddl-daemon are running"
  # always_on_host applies once the vault's (synced) settings name the always-on machine.
  if [ -n "$remote_host" ]; then
    machine="$(as_user "$NODE" "$HELPER" set-machine --daemon-url "http://127.0.0.1:$PORT" \
      --token-file "$DDL_HOME_DIR/daemon-token" --host "$remote_host")"
    case "$machine" in
      set) note "the vault's settings now name this machine the always-on machine" ;;
      kept) note "the vault's settings already name this machine the always-on machine" ;;
      *) note "the vault's settings name another always-on machine (${machine#other }): to hand" \
        "the agent to this one, change it in Settings -> Always-on machine" ;;
    esac
  fi
else
  note "enabled ddl-sync and ddl-daemon (not started: --no-start)"
fi

# 8. Next steps (no secrets) --------------------------------------------------------------------
host="${remote_host:-vm-name.tailnet-name.ts.net}"
cat <<EOF

Daily Do List $RELEASE is installed.
  Daemon:  http://127.0.0.1:$PORT (ddl-daemon)   Sync: $SYNC_URL (ddl-sync)
  Vault:   $VAULT_DIR   Home: $DDL_HOME_DIR
  Logs:    journalctl -u ddl-daemon -u ddl-sync -f

Next steps:

1. Serve both on the tailnet over HTTPS (enable HTTPS certificates for the tailnet first):
     sudo tailscale serve --bg --https=443 http://127.0.0.1:$PORT
     sudo tailscale serve --bg --https=8443 $SYNC_URL
EOF
if [ -z "$remote_host" ]; then
  cat <<'EOF'
   No remote host is configured yet, so the daemon answers on loopback only, and the vault
   doesn't know this machine as its always-on machine. Run this script again with
   --host vm-name.tailnet-name.ts.net (its name on the tailnet).
EOF
fi
cat <<EOF

2. Give the agent a model, either or both:
   - the Cursor CLI, installed and signed in as $SERVICE_USER, then the Cursor harness in Settings:
       sudo -u $SERVICE_USER -H bash -c 'curl https://cursor.com/install -fsS | bash'
       sudo -u $SERVICE_USER -H env NO_OPEN_BROWSER=1 $STATE/.local/bin/agent login
   - an OpenRouter key for the Pi harness: add OPENROUTER_API_KEY=... with
       sudoedit $ENV_FILE
       sudo systemctl restart ddl-daemon

3. Connectors: copy your mcp.json to this machine (not into the vault), then
     sudo install -o $SERVICE_USER -g $SERVICE_USER -m 0600 mcp.json $DDL_HOME_DIR/mcp.json
     sudo systemctl restart ddl-daemon

4. Pair a laptop:
     sudo -u $SERVICE_USER -H $NODE $CURRENT/daemon/dist/main.js pair
   prints a pairing code. On the laptop, Settings -> Always-on machine: https://$host and the code.
   To sync the laptop's vault, Settings -> Sync: https://$host:8443, vault ${vault_id:-<vault id>},
   and the vault token, which this prints on the machine:  sudo cat $SYNC_TOKEN
EOF
