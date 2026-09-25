# Daily Do List for Linux (always-on machine)

This bundle runs Daily Do List on an always-on Linux machine: the daemon (which also serves the web
app) and the sync service. It needs Node.js 24.4 or newer on a glibc Linux such as Ubuntu LTS,
installed system-wide (for example from NodeSource), and has no other runtime dependencies.

| Path | What it is |
| --- | --- |
| `daemon/` | The daemon: `dist/main.js` and its production `node_modules/`. |
| `web/dist/` | The built web app. The daemon finds it next to `daemon/`, no configuration needed. |
| `sync/` | The sync service: `dist/main.js`, one file with its dependencies bundled. |
| `bundle.json` | Version, commit, target platform and build time. |

The setup kit (a `setup.sh` that installs this bundle with systemd units, and its guide) lives in
the repository under `deploy/linux/`, with a guide for an Azure VM reachable only over Tailscale in
`deploy/azure/`.

Try it without installing anything (temporary folders, other ports than your usual ones):

```sh
node sync/dist/main.js vault create --name Personal --db /tmp/ddl-try/sync.db
node sync/dist/main.js serve --db /tmp/ddl-try/sync.db --port 17332 &
DDL_HOME=/tmp/ddl-try/home DDL_VAULT=/tmp/ddl-try/vault DDL_PORT=17331 DDL_AGENT_MODE=mock \
  node daemon/dist/main.js
```

Both bind `127.0.0.1` only. Reach them from other devices through a private network that
terminates TLS on this machine, such as `tailscale serve`, never by opening ports.
