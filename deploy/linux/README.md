# Always-on machine: the Linux setup kit

This kit installs Daily Do List on an always-on Linux machine: the daemon (with the agent and the
web app) and the sync service, as systemd services under their own user. Both keep binding
`127.0.0.1`; `tailscale serve` makes them reachable from your devices over HTTPS, with no public
ports ([docs/ALWAYS_ON.md](../../docs/ALWAYS_ON.md) has the design). For a VM on Azure, start with
[deploy/azure/README.md](../azure/README.md), which ends by running this kit.

| File | Purpose |
| --- | --- |
| `build-bundle.sh` | Builds `ddl-linux-<arch>.tar.gz` on a dev machine or in CI (Linux or macOS). |
| `setup.sh` | Installs or upgrades a bundle on the machine. Idempotent. |
| `setup-helper.mjs` | JSON config edits, the sync token and health checks for `setup.sh`. |
| `ddl-daemon.service`, `ddl-sync.service` | The systemd units. |
| `bundle-readme.md` | The README inside the tarball. |
| `smoke-test.sh`, `smoke-check.mjs` | Start an unpacked bundle on free ports and check it (Linux or macOS). |
| `setup-test.sh` | Install a bundle with `setup.sh` and check the services (CI runners only). |

## Requirements

- Ubuntu LTS (22.04 or 24.04) or another glibc Linux with systemd, x64 or arm64. 2 vCPUs and 8 GB
  of memory are comfortable for Node, Chromium and the agent.
- Node.js 24.4 or newer, installed system-wide (the services don't see a Node.js in a home folder,
  such as nvm's). On Ubuntu, from NodeSource:

  ```sh
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
  sudo bash /tmp/nodesource_setup.sh && sudo apt-get install -y nodejs
  ```

- Tailscale, joined to your tailnet with MagicDNS and HTTPS certificates enabled, to reach the
  machine from your devices.

## Build the bundle

On a checkout with `pnpm install` done:

```sh
deploy/linux/build-bundle.sh --arch x64      # or arm64; default: this machine's CPU
# → deploy/linux/build/ddl-linux-x64.tar.gz and .sha256 (the build folder is gitignored)
```

It builds the daemon, the web app and the sync service, deploys the daemon's production
dependencies like the Mac app does (`pnpm deploy --prod --legacy`) with the native packages of the
target platform, and lays them out as the daemon expects: it serves `web/dist` from next to
`daemon/`, so no `webDist` setting is needed.

Check a bundle without installing it: `deploy/linux/smoke-test.sh
deploy/linux/build/ddl-linux-x64.tar.gz` unpacks it into a temporary folder, starts the sync
service and the daemon (mock agent) on free loopback ports with a temporary home, checks health,
the web app, a note syncing through the sync service and the agent lease, and stops both. CI runs
it and then installs the bundle with `setup.sh` on a fresh runner (`setup-test.sh`); see
[docs/CI.md](../../docs/CI.md).

## Install

Copy the tarball to the machine (for example `scp` over Tailscale SSH), then:

```sh
sha256sum -c ddl-linux-x64.tar.gz.sha256          # if you copied the .sha256 too
tar -xzf ddl-linux-x64.tar.gz
sudo ./ddl-linux-x64/deploy/setup.sh --host vm-name.tailnet-name.ts.net
```

`--host` is the name the daemon answers to besides loopback: the machine's name on the tailnet.
Without it, `setup.sh` takes the name from `tailscale status` when Tailscale is up. Other options:
`--bundle FILE` installs a tarball without unpacking it first, `--vault-name NAME` names the sync
vault (default `Personal`), `--port N` and `--sync-port N` change the loopback ports of the daemon
and the sync service (default 7331 and 7332; later runs keep them), `--skip-browser` skips
Chromium, and `--no-start` enables the services without starting them.

What `setup.sh` does, and does again safely on every run:

1. Checks Node.js 24.4+ where systemd finds it, and prints how to install it if it's missing.
2. Creates the system user `ddl` (no login shell) and its folders, all `0700`, and
   `/etc/ddl/ddl.env` (`0600`, owned by `ddl`) for API keys. An existing env file is never
   overwritten, and nothing secret is ever in the bundle.
3. Unpacks the bundle into `/opt/ddl/releases/<version>-<commit>` (owned by root, so the agent
   can't change its own code) and points `/opt/ddl/current` at it. It keeps the last three
   releases for a rollback.
4. Creates a vault on the local sync service and writes its token to
   `~ddl/.daily-do-list/sync-token` (`0600`). On later runs it keeps the vault and token (and
   rotates the token only if the file went missing).
5. Writes `~ddl/.daily-do-list/config.json`, keeping keys you added: the vault folder, port 7331,
   `sync` pointing at the local sync service (`http://127.0.0.1:7332`, which the daemon accepts
   because it's loopback), `agent.placement: "always_on_host"` and `remote.hosts: ["<host>"]`.
6. Installs Playwright's Chromium for the agent's browser, the build matching the bundled
   Playwright, into `~ddl/.cache/ms-playwright`, plus the system libraries it needs (apt).
7. Installs and enables `ddl-sync.service` and `ddl-daemon.service`, restarts them and waits until
   both answer their health checks.
8. Names this machine the vault's always-on machine (`remote.alwaysOnMachine` in the synced
   settings: the host's first label and `https://<host>`) when the vault names none yet. The
   daemon applies `always_on_host` only then (pairing a laptop with the machine sets it too);
   before, it competes for the agent like any laptop. A vault that already names another machine
   is left alone.
9. Prints the next steps (below). It never prints a token.

`remote.hosts` is a JSON list in `config.json`, one name per `--host`. (The daemon's
`DDL_REMOTE_HOSTS` override takes names separated by commas; the kit doesn't use it, and setting it
makes the names read-only in Settings.)

### Next steps

`setup.sh` prints these with the right names filled in:

1. **Serve both on the tailnet** over HTTPS. The configuration survives reboots:

   ```sh
   sudo tailscale serve --bg --https=443 http://127.0.0.1:7331     # the daemon and web app
   sudo tailscale serve --bg --https=8443 http://127.0.0.1:7332    # the sync service
   tailscale serve status
   ```

   `tailscale serve` passes the browser's `Host` through, which is why the daemon must list the
   tailnet name in `remote.hosts`; anything else keeps getting `forbidden_host`.
2. **Give the agent a model**, either or both:
   - the Cursor CLI, installed and signed in as `ddl` (`agent login` prints a link to open on any
     device), then pick the Cursor harness in Settings:

     ```sh
     sudo -u ddl -H bash -c 'curl https://cursor.com/install -fsS | bash'
     sudo -u ddl -H env NO_OPEN_BROWSER=1 /var/lib/ddl/.local/bin/agent login
     ```

   - an OpenRouter key for the Pi harness: `sudoedit /etc/ddl/ddl.env`, add
     `OPENROUTER_API_KEY=…`, then `sudo systemctl restart ddl-daemon`.
3. **Connectors:** copy your `mcp.json` to the machine (never into the vault), then install it
   for the service user and restart:

   ```sh
   sudo install -o ddl -g ddl -m 0600 mcp.json /var/lib/ddl/.daily-do-list/mcp.json
   sudo systemctl restart ddl-daemon
   ```

   Connectors that run a command (stdio servers) need that command installed system-wide.
4. **Pair a laptop.** On the machine, `sudo -u ddl -H node /opt/ddl/current/daemon/dist/main.js
   pair` prints a pairing code. On the laptop, Settings → Always-on machine takes
   `https://vm-name.tailnet-name.ts.net` and the code. To sync the laptop's notes with the machine,
   Settings → Sync takes `https://vm-name.tailnet-name.ts.net:8443`, the vault id `setup.sh`
   printed, and the vault token (`sudo cat /var/lib/ddl/.daily-do-list/sync-token` shows it on
   the machine). Set the laptop's agent location to the always-on machine or to itself.

## Where things are

| Path | What |
| --- | --- |
| `/opt/ddl/current` | The installed bundle (a symlink into `/opt/ddl/releases/`), owned by root. |
| `/var/lib/ddl` | Home of the `ddl` user (`0700`): everything the services write. |
| `/var/lib/ddl/DailyDoList` | The vault: plain markdown notes and the agent's sidecar. |
| `/var/lib/ddl/.daily-do-list` | `DDL_HOME`: `config.json`, `daemon-token`, `sync-token`, `mcp.json`, `device.json`, the agent's workspaces and browser profile. |
| `/var/lib/ddl/sync/sync.db` | The sync service's database (with `-wal` and `-shm` files next to it). |
| `/var/lib/ddl/.cache/ms-playwright` | Chromium for the agent's browser. |
| `/etc/ddl/ddl.env` | Environment of `ddl-daemon.service`: API keys, `DDL_*` overrides (`0600`). |
| `/etc/ddl/sync.env` | The sync service's port (`DDL_SYNC_PORT`), written by `setup.sh`. |
| `/etc/systemd/system/ddl-*.service` | The units. |

The units run as `ddl` with `Restart=on-failure` and systemd's hardening: no new privileges, a
read-only system (`ProtectSystem=strict`) except `/var/lib/ddl` (the sync service gets only its
database folder), no access to `/home` and `/root`, a private `/tmp`, and no capabilities.

## Upgrade

Build or download the new tarball, copy it over, and run the `setup.sh` inside it. It swaps
`/opt/ddl/current`, installs the matching Chromium, and restarts both services; config, tokens,
the vault and the sync database stay:

```sh
tar -xzf ddl-linux-x64.tar.gz
sudo ./ddl-linux-x64/deploy/setup.sh          # or: sudo ./setup.sh --bundle ddl-linux-x64.tar.gz
```

To roll back, point `current` at a kept release and restart:

```sh
ls /opt/ddl/releases
sudo ln -sfn releases/<version>-<commit> /opt/ddl/current
sudo systemctl restart ddl-sync ddl-daemon
```

## Logs and status

```sh
systemctl status ddl-daemon ddl-sync
journalctl -u ddl-daemon -f                  # follow the daemon
journalctl -u ddl-daemon -u ddl-sync --since "1 hour ago"
sudo systemctl restart ddl-daemon            # after editing config.json, ddl.env or mcp.json
```

The services log to the journal, which journald rotates (`SystemMaxUse=` in
`/etc/systemd/journald.conf` caps it). Neither service logs tokens or note contents. For more
detail, add `DDL_LOG_LEVEL=debug` to `/etc/ddl/ddl.env` and restart.

## Troubleshooting

- **`setup.sh` can't download Chromium** (`Request to https://cdn.playwright.dev/… timed out`).
  Check the machine's outbound access. If it has an IPv6 route that doesn't actually work (some
  networks advertise one), Playwright's downloader times out instead of falling back to IPv4:
  fix or disable IPv6 (`sysctl net.ipv6.conf.all.disable_ipv6=1`), then run `setup.sh` again. In
  the meantime, `--skip-browser` finishes the rest; the agent's browser stays unavailable.
- **A service doesn't start.** `journalctl -u ddl-daemon -n 50` (or `-u ddl-sync`); configuration
  errors name the file and the key.
- **The browser shows `forbidden_host`.** The name you used isn't in `remote.hosts`: run `setup.sh`
  again with `--host`.

## Backup

Your devices keep their own copies of the notes, but back up the machine too:

| What | Path | Notes |
| --- | --- | --- |
| The vault | `/var/lib/ddl/DailyDoList` | Plain files: copy them any time. |
| The sync database | `/var/lib/ddl/sync/sync.db` | Stop `ddl-sync` and copy the folder, or use `sqlite3 sync.db ".backup /path/backup.db"` while it runs. |
| Machine settings | `/var/lib/ddl/.daily-do-list` | Holds secrets (tokens, `mcp.json`): keep the backup encrypted. Never restore `device.json` onto a second machine. |
| API keys | `/etc/ddl/ddl.env` | Secret: same care. |

```sh
sudo systemctl stop ddl-sync
# Readable by root only: the archive holds the tokens and API keys.
sudo sh -c 'umask 077 && tar -czf "/root/ddl-backup-$(date +%F).tar.gz" \
  -C /var/lib/ddl DailyDoList sync .daily-do-list -C /etc ddl'
sudo systemctl start ddl-sync
```

On Azure, a disk snapshot also works (see the Azure guide).

## Test the kit on a throwaway machine

`setup-test.sh` installs a bundle with `setup.sh` on a disposable machine with systemd and checks
what CI checks: two runs (the second changes nothing), modes and owners, `config.json`, the units,
both services running inside their sandbox, and no token in the output or the journal. Since it
installs system services, it runs only with `CI=true` or `DDL_SETUP_TEST_DISPOSABLE=1`.

On a Mac, an [OrbStack](https://orbstack.dev) Linux machine works with two adjustments. OrbStack
forwards the machine's loopback ports to the Mac's, where Daily Do List may already use 7331, so
the test runs on other ports. And its machines are LXC containers that switch systemd's sandboxing
off with a `zzz-lxc-service.conf` drop-in (for every service, or per unit), which the test would
catch, so mask it in the throwaway machine. Use the Mac's own architecture (`arm64` on Apple
silicon): under Rosetta, systemd can't track the services' processes, and the stop checks fail.

```sh
deploy/linux/build-bundle.sh --arch arm64          # the machine's CPU
orb create ubuntu:noble ddl-kit-test
orb -m ddl-kit-test -u root -w /tmp bash -c '
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh && apt-get install -y nodejs
  for dir in service.d ddl-daemon.service.d ddl-sync.service.d; do
    mkdir -p "/etc/systemd/system/$dir" && : >"/etc/systemd/system/$dir/zzz-lxc-service.conf"
  done
  systemctl daemon-reload'
orb -m ddl-kit-test -u root -w /tmp env DDL_SETUP_TEST_DISPOSABLE=1 SETUP_TEST_PORT=17331 \
  SETUP_TEST_SYNC_PORT=17332 "$PWD/deploy/linux/setup-test.sh" \
  "$PWD/deploy/linux/build/ddl-linux-arm64.tar.gz"
orb delete ddl-kit-test
```

## Uninstall

```sh
sudo tailscale serve reset
sudo systemctl disable --now ddl-daemon ddl-sync
sudo rm -rf /etc/systemd/system/ddl-daemon.service* /etc/systemd/system/ddl-sync.service*
sudo systemctl daemon-reload
sudo rm -rf /opt/ddl
# The data too (back it up first): notes, sync database, tokens, browser profile, API keys.
sudo rm -rf /var/lib/ddl /etc/ddl && sudo userdel ddl
```

Then revoke the machine on your devices (Settings → Always-on machine → Forget) and remove it from
the tailnet.
