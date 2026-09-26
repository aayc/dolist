# @ddl/daemon

The local Daily Do List server. It owns the markdown vault (through a `StorageProvider`), serves
the web UI, exposes the REST + WebSocket API every client uses and runs the agent runtime. Agents
can run shell commands and drive a browser and the desktop, so the daemon is locked down (see
[Security model](#security-model)). The protocol, with every route, status and event, is
[docs/PROTOCOL.md](../../docs/PROTOCOL.md) (generated from `@ddl/contract`).

## Running

```sh
pnpm dev          # daemon (tsx watch) + Vite dev server → http://localhost:5173
pnpm dev:mock     # the demo: the mock agent on a throwaway demo vault (DDL_DEMO=1), web on :5174
pnpm build        # bundles the daemon to apps/daemon/dist/main.js and builds apps/web/dist
pnpm start        # production: the daemon serves the built UI → http://127.0.0.1:7331
```

The banner prints the URL, never the token. `SIGINT`/`SIGTERM`/`SIGHUP` shut down gracefully (the
agent runtime flushes threads and records first); a second signal exits immediately.

### Restarting to apply a change (exit code 75)

Switching to another vault (`PUT /api/device/vault`) needs a new start: the daemon answers, shuts
down gracefully and exits with **75** (`RESTART_EXIT_CODE`, `EX_TEMPFAIL`); `vaultPath` in
`config.json` already names the new vault. Under the Mac app (`DDL_SUPERVISED=1`) the supervisor
starts it again at once (clients see `restart: "supervisor"`); started by hand, it prints which
vault it opens from now on and you run the same command again (`restart: "manual"`). A process
manager can treat 75 as "restart now".

## Configuration

Precedence: environment variable → `$DDL_HOME/config.json` → default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DDL_HOME` | `~/.daily-do-list` | Machine-local state (created with mode `0700`). |
| `DDL_VAULT` | `~/DailyDoList` | Vault folder; an existing Obsidian vault works. Set, it fixes the vault: `PUT /api/device/vault` answers 409 `locked_by_env`. |
| `DDL_PORT` | `7331` | Port on `127.0.0.1`. `0` picks a free port. |
| `DDL_AGENT_MODE` | `live` | `live`, `mock` (scripted agent, no model calls) or `off`. |
| `DDL_MODEL` | `deepseek/deepseek-v4.1-flash` | Default OpenRouter model (until the vault's settings pick one). |
| `DDL_WEB_DIST` | `apps/web/dist` | Built web UI to serve. |
| `DDL_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `DDL_COMPUTER_HELPER` | found automatically | The `ddl-computer` helper for app control (macOS), or `off`. Otherwise `<entry script dir>/../bin/ddl-computer` (the app bundle's copy), then a dev build in `apps/macos/Packages/DailyDoListComputer/.build/{release,debug}/`. Without one, computer use stays screen-level. |
| `DDL_DRAWING_RENDERER` | found automatically | The page agents render drawings with, or `off`. Otherwise `<entry script dir>/drawing-renderer`, then `apps/daemon/dist/drawing-renderer` (`build` and `dev` build it). Without it or a browser, agents get drawings as text only (the startup summary's `drawingRenderer` says which). |
| `OPENROUTER_API_KEY` | — | Required for `live` agents on Pi. Without it the agent reports a problem; notes keep working. |
| `DDL_SYNC_URL`, `DDL_SYNC_VAULT`, `DDL_SYNC_TOKEN` | — | The sync service (URL and vault together; they override `sync` in `config.json`; the token else comes from `$DDL_HOME/sync-token`, never logged). |
| `DDL_AGENT_PLACEMENT` | `this_device` | Where this device's agent runs (overrides `agent.placement`). |
| `DDL_REMOTE_HOSTS` | — | Comma-separated remote hosts (overrides `remote.hosts`). |
| `DDL_SUPERVISED` | — | `1`: a supervisor restarts the daemon after exit code 75 (the Mac app sets it). |
| `DDL_DEMO` | — | `1`: the demo (`pnpm dev:mock`, the Mac app's `--demo`): seeds `DDL_VAULT` with the demo vault (`src/demo-vault.ts`) and turns computer use off in `DDL_HOME`'s `config.json`. Needs both as absolute paths; an existing vault or `config.json` stays as it is. |

A device setting set by an environment variable (placement, remote hosts, or the sync setup
through any sync variable) is listed in `lockedByEnv` by `GET /api/device`, and the API refuses to
change it (409 `locked_by_env`). Env files fill in variables that aren't set, in this order:
`$DDL_HOME/.env` (preferred: outside the repo), then `.env.local` in the working directory, then
`.env.local` at the root of this repository. Values are never logged.

Every file in `$DDL_HOME` is listed in [docs/DATA_FORMATS.md](../../docs/DATA_FORMATS.md#app-home-ddl_home-default-daily-do-list-machine-local-never-synced).
Beyond that list: delete `daemon-token` to rotate it; an unreadable `devices.json` is moved aside
to `devices.json.invalid` and every device pairs again; `machine-token` is used only while its
`url` is the vault's always-on machine; `cache/vault-versions.json` keeps the vault's file versions
by path, mtime and size across restarts (safe to delete).

`config.json` (all keys optional; relative paths resolve against `$DDL_HOME`, `~` is expanded;
unknown keys are rejected so typos surface):

```json
{
  "vaultPath": "~/DailyDoList",
  "port": 7331,
  "agentMode": "live",
  "model": "deepseek/deepseek-v4.1-flash",
  "sync": { "kind": "none" },
  "agent": { "placement": "this_device" },
  "remote": { "hosts": ["vm-name.tailnet-name.ts.net"] },
  "execution": {
    "kind": "local",
    "browser": { "headless": true, "channel": "chrome" },
    "computer": { "enabled": true }
  },
  "allowedOrigins": ["http://localhost:5174"],
  "webDist": "~/daily-do-list-web",
  "logLevel": "info"
}
```

- `sync`: `{ "kind": "none" }`, `{ "kind": "local", "root": "~/Library/Mobile Documents/…" }`, or
  `{ "kind": "remote", "url": "https://sync.example.com", "vault": "<vault id>" }` for the sync
  service (`https` unless it is this machine; the token goes in `sync-token`, never here). With
  `remote` sync the agent runs only while this device holds the vault's agent lease
  (`src/agent-supervisor.ts`, `src/agent-lease.ts`); how that and `agent.placement` work:
  [docs/SYNC.md](../../docs/SYNC.md#the-agent-lease).
- `remote.hosts`: the DNS names this daemon answers to besides loopback (`host[:port]`, at most 8;
  no IPs, schemes or paths; `:443` is the same as no port). See
  [Remote access and pairing](#remote-access-and-pairing).
- `execution`: `local` (browser headless by default; computer use on by default on macOS only, with
  app control when the helper is found).
- `allowedOrigins`: extra exact origins (`scheme://host[:port]`) for other clients, such as a Vite
  dev server on another port. HTTP(S) origins also allow their host in the `Host` allowlist; a host
  that isn't loopback is served like a remote host (never the token in the page).

`PATCH /api/device` (name, placement, remote hosts) and `PUT`/`DELETE /api/device/sync` apply
live, without a restart, and rewrite `config.json` atomically (mode `0600`), keeping every key they
don't own.

### App settings

User-facing settings (`AppSettings`: theme, editor, daily/weekly notes, agent) live in the vault at
`.daily-do-list/settings.json`, so they travel with the vault. The file holds only explicit
overrides, merged over the defaults (with `DDL_MODEL` as the default model). On first run the
daemon imports what it can from an existing Obsidian vault: `.obsidian/daily-notes.json` (folder,
format, template), `.obsidian/app.json` (vim mode, live preview, readable line length, line
numbers, spellcheck) and `.obsidian/appearance.json` (theme). With nothing to import it writes no
file, so a new device joining a synced vault takes the vault's settings instead of resetting them.

`agent.harness` picks what runs the agent: `pi` on the OpenRouter model `agent.model`, or `cursor`
(the Cursor CLI) on `agent.cursorModel`; the safety judge's `agent.judgeModel` is an OpenRouter
model with either. `agent.approvalPolicy` reaches the runtime's safety gate from the next tool call
(see `packages/agent/src/safety/README.md`).

## Security model

- **Loopback only.** The HTTP server listens on `127.0.0.1`; there is no option to bind elsewhere.
  Other devices come in through a private-network proxy on this machine, under a remote host.
- **Bearer token** on every `/api/*` request: the master token (`daemon-token`) or a paired app's or
  daemon's token, compared in constant time; on a remote Host, a paired browser's cookie instead.
  The WebSocket takes the same header, and `?token=` on loopback Hosts only (the Vite dev proxy
  injects the header).
- **Host allowlist** on every request, including static files, which defeats DNS rebinding:
  `127.0.0.1:<port>`, `localhost:<port>`, `localhost:5173`, `127.0.0.1:5173` (the Vite proxy forwards
  the browser's Host unless `changeOrigin` rewrites it), hosts of `allowedOrigins`, and the remote
  hosts (read live). A loopback Host that arrives with proxy forwarding headers (`Forwarded`,
  `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`) is refused: the proxy must keep the original
  Host. A request whose Host and absolute-form target differ is served as the stricter of the two.
- **Origin allowlist** on the API and WebSocket: the daemon and Vite origins, `allowedOrigins`, and
  `https://<remote host>`. A missing Origin (curl, native clients) is fine with a valid token; an
  unknown Origin, including `null` (sandboxed iframes), is always rejected. No CORS headers.
- **Token hand-off to the browser.** In production `index.html` is rendered per request with
  `Cache-Control: no-store`: on a loopback Host with `<meta name="ddl-token" content="…">`; on a
  remote Host with `<meta name="ddl-auth" content="cookie|pairing">` and never a token.
- **Headers.** All responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Resource-Policy: same-origin`; API responses `Cache-Control: no-store`. HTML adds a
  CSP (`default-src 'self'`, inline scripts only by hash, `frame-ancestors 'none'`),
  `X-Frame-Options: DENY` and `Cross-Origin-Opener-Policy: same-origin`.
- **Input validation.** JSON bodies are validated with the contract's zod schemas (unknown keys
  rejected), capped at 5 MB. Note paths are decoded per segment, normalized, and must stay inside
  the vault, contain no control characters, not be hidden, and be a text format (`.md`, `.txt`,
  `.canvas`, `.json`, …).
- **Artifacts are untrusted.** They are served with `Content-Security-Policy: sandbox;
  default-src 'none'`; HTML, SVG, XML, JavaScript and PDF are always downloads.
- **Limitation:** any local process that can reach `127.0.0.1` with the right Host header can load
  `index.html`, and so the token. On a shared multi-user machine other OS users could obtain it.

## Remote access and pairing

Off by default. To use the daemon from other devices (the always-on machine, a phone, a second
laptop), put it behind a private-network proxy on the same machine and name it:

1. `tailscale serve --bg --https=443 http://127.0.0.1:7331` (the daemon keeps binding loopback; the
   proxy terminates TLS and keeps the original `Host`). Never `tailscale funnel`: that publishes it
   on the internet.
2. Add the name to `remote.hosts` in `config.json` (or `DDL_REMOTE_HOSTS`), e.g.
   `"remote": { "hosts": ["vm-name.tailnet-name.ts.net"] }`. Without it every request through the
   proxy gets `forbidden_host`. `PATCH /api/device` changes the live list (`src/remote-hosts.ts`).
3. Pair each device with a code from an authenticated client: Settings → Devices, or `pair` on the
   machine (see [Command line](#command-line)).

| Client | Credential | How |
| --- | --- | --- |
| This machine (local page, Mac app, CLI) | master token | page meta tag, `Authorization`, or `?token=` on the WebSocket (loopback only) |
| Paired app or daemon | device token (from `POST /api/pair`, shown once) | `Authorization: Bearer <token>` on REST and on the WebSocket upgrade |
| Paired browser on a remote host | `__Host-ddl-device` cookie (from `POST /api/pair` with `kind: "browser"`) | sent by the browser; accepted only with the page's own `Origin` (or `Sec-Fetch-Site: same-origin` on Origin-less GETs), never on loopback |

- **Pairing codes:** `POST /api/pairing-codes` returns 8 characters of an unambiguous alphabet
  (shown as `XXXX-XXXX`), single use, valid 5 minutes, at most 3 outstanding (and 50 devices), plus
  `https://<first remote host>` for a QR code.
- **`POST /api/pair`** needs no credential: the code is one. Host and Origin are checked, bodies
  are at most 1 KB, 5 attempts a minute are allowed across all clients (all remote traffic comes
  through the one local proxy), and 10 wrong codes invalidate every outstanding code. A wrong,
  expired or used code answers 401 `pairing_rejected`. The name given when the code was issued wins.
  `kind: "browser"` works only from the daemon's own `https://` page on a remote host.
- **Device tokens** are 256-bit random, stored only as SHA-256 hashes in `devices.json`, compared
  with every stored hash in constant time; last use is written at most once a minute.
- **Revoking** (`DELETE /api/devices/:id`, Settings, or `revoke`) stops the credential at once and
  closes that device's WebSockets with 1008 `Device revoked`; a browser revoking itself also gets
  its cookie cleared.
- **Pages on a remote host** say `ddl-auth` `cookie` when the browser holds a working cookie, else
  `pairing`. A link followed from another site arrives without the cookie (`SameSite=Strict`), so
  the page's first same-origin request, which carries it, is the real answer.
- Codes, tokens and cookies are never logged; the log names device ids and kinds.

## Command line

The entry point doubles as a small CLI for headless machines. Run it as the daemon's user, since
it reads `daemon-token` and calls the running daemon on its configured port; without a command it
starts the daemon.

```sh
sudo -u ddl -H node /opt/ddl/current/daemon/dist/main.js pair --name "Phone"
# Pairing code: ABCD-EFGH
# Valid once, until 11:42 (5 minutes).
# On the new device, open https://vm-name.tailnet-name.ts.net (…) and type the code.

node dist/main.js devices             # NAME  KIND  PAIRED  LAST SEEN  ID
node dist/main.js revoke pd_abc123    # revokes a device; its connections close at once
node dist/main.js help
```

Exit codes: 0 done, 1 the daemon refused or couldn't be reached (the message says why), 2 bad
arguments. The token is never printed.

## API behavior

Routes, bodies, status codes and events are in [docs/PROTOCOL.md](../../docs/PROTOCOL.md). What
the reference doesn't say:

- Writes: omitting `baseVersion` overwrites. `daily` creates a missing note from the configured
  template (with `{{title}}`, `{{date}}`, `{{time}}`) or `- [ ] `; if another writer creates it
  first, theirs is returned with `created: false`.
- Thread actions that take longer than 3 s answer `202 { pending: true }` and finish in the
  background.
- `thr_orchestrator` is the orchestrator's chat: listed without `notePath` (a `?notePath=` filter
  leaves it out); a message is a direct message, cancel stops the turn in progress, retry answers
  503. While the agent can't run it stays idle and a message gets a note saying why.
- Routines are files, so listing, creating, pausing and resuming work whatever the agent's state
  (off, failed to load, or running on another device: the null runtime reads the files and follows
  the synced scheduler state). `run` needs the agent: 503 with the reason when it can't run here,
  409 when the routine can't start now. `routines.changed` is also sent when the agent lease moves
  to or from this device.
- `agent/status` reports `placement` (see [docs/SYNC.md](../../docs/SYNC.md#priorities-and-takeover)),
  this daemon's `readiness` (booleans and counts only) and `execution.computerAccess`: both
  permissions, app control, and the app macOS attributes the daemon's permissions to (found by
  walking the parent process chain). `computer/permissions/open` only opens fixed System Settings
  deep links; nothing from the request reaches the command.
- `machine/*`: outbound calls to the machine are https only (plain http only to loopback), time out
  after 5 s, don't follow redirects and send the token only in `Authorization`. `pair` calls the
  machine's `POST /api/pair` as kind `daemon` and sets `remote.alwaysOnMachine` in the synced app
  settings. `GET /api/machine` checks again in the background when the last check is older than
  30 s; nothing polls while nobody asks.
- The WebSocket server pings every 30 s and drops clients that don't answer. Past 1 MB buffered for
  a client, `surface.frame` and `thread.delta` are skipped (the final `thread.message` carries the
  full text); past 16 MB it is disconnected and must resync. `vault.changed` is coalesced over
  ~30 ms, one change per path, with `origin` `client` (and its `clientId`), `agent`, `sync` or
  `external`.
- Everything outside `/api/*` and `/ws` serves the built UI with SPA fallback; hashed files under
  `/assets/` are cached immutably. Without a build, a short page explains how to create one.

## Importing from Obsidian

The user copies their Obsidian vault; Daily Do List makes a **new vault** from it and carries the
current vault over. The Obsidian vault is only ever read, and the current vault is never written:
it stays as the backup ([the spec](../../docs/specs/obsidian-migration.md) has the decisions).

1. **Preview** (`POST /api/import/obsidian/preview`): notes, folders, attachments by type and size,
   the settings found, the templates folder, enabled community plugins and how each fares here
   (`src/import/plugins.ts`, a table to extend), canvases, drawings, links that aren't followed, and
   the carry-over plan with the same counts the import will produce. Lists hold at most 200 entries
   with a full `count`. It reads no note except the few in the agent's watch window and the ones
   that will be merged, so a 10 000-note vault previews in a fraction of a second.
2. **Import** (`POST /api/import/obsidian`): a job, one at a time. It copies the Obsidian vault
   byte for byte (`.obsidian/` and attachments included, times kept, never executable) into a hidden
   staging folder next to the destination, then carries the current vault over:
   - daily notes move to Obsidian's daily-note folder and format (or keep this vault's when Obsidian
     keeps none, or uses a format this app can't read back); for a date both have, the Obsidian note
     is kept and this vault's note appended under `## From Daily Do List` (a code block left open
     is closed first);
   - every other file (routines, drawings, attachments, `.trash/`) keeps its path; one that
     collides with an Obsidian file, compared case- and normalization-insensitively, becomes
     `Name (Daily Do List).md`, and files that don't collide keep their names first;
   - the agent sidecar: tracker state of moved or merged daily notes is rebuilt at the new path so
     every task keeps its id (Obsidian's tasks in a merged note count as existing tasks, acted on
     only with `actOnExistingTasks`), records get the new path and line, threads arrive as journals
     (`src/import/sidecar.ts`: snapshots an older app wrote migrated in with the thread store's
     planner, thread events remapped to the new note path and routine id), and a thread whose task
     isn't in its note any more is kept with a system note saying it's detached. Approvals,
     artifacts and anything unknown are copied byte for byte; the sync engine's snapshots and an
     earlier import's manifest stay behind;
   - `settings.json`: this vault's, with the new daily-note settings and Obsidian's editor settings;
   - the manifest, `.daily-do-list/import/obsidian.json` (see `docs/DATA_FORMATS.md`), which also
     records the previous vault, so `GET /api/import/obsidian` can say where the backup is.
   The finished staging folder is renamed to the destination. Cancelling, a failure or a daemon
   shutdown removes the staging folder: the destination never holds half an import.
3. **Switch** (`PUT /api/device/vault`), which restarts the daemon on the new vault. Refused while
   the vault syncs: turn sync off first, or the old notes would sync into the new one.
4. **Update from Obsidian** (`POST /api/import/obsidian/update`): copies what changed there since
   the manifest. Changed there and not here: replaced. Changed on both sides (a merged daily note
   always counts as changed here): kept, and the Obsidian version saved as `Name (Obsidian).md`.
   New there: copied (as a conflict copy if this vault has another file at that path). Deleted here
   and changed there: written back. It never deletes, and its writes are atomic and synced.

Rules that hold throughout:

- The source must be an existing, readable folder that is not, holds nor sits inside `$DDL_HOME` or
  the current vault; the destination must be new or empty (Finder's `.DS_Store` aside), in a
  writable folder, and not inside the source, `$DDL_HOME` or the current vault. Both are compared
  by real path.
- Links are followed only to files inside the vault being read; other links and special files are
  skipped and reported. Files are opened without following links and without blocking. Nothing
  from the source is ever executed.
- Only this machine may call these routes (a paired device gets 403 `forbidden_device`). They aren't
  agent tools, and the safety rules deny agents any call to the daemon's API
  (`network.app-self-access`) and any write under `.daily-do-list/`.

## The agent relay

When this device's effective placement is `always_on_machine` and it holds a credential for the
machine, the daemon forwards the agent to the always-on machine's daemon, so this device's clients
show and act on the machine's agent with the same API ([docs/ALWAYS_ON.md](../../docs/ALWAYS_ON.md#the-agent-relay)).
The code is in `src/relay/`; it reads the effective placement from the agent supervisor (and
reports the relay state back to it) and the credential from the machine link, through the
interfaces in `src/agent-location.ts`, and follows their changes live. A relaying device never
asks for the agent lease.

**Forwarded:** only the routes in `RELAY_RULES` (`src/relay/routes.ts`, derived from the contract):
threads (the orchestrator's chat included) with messages, cancel and retry; approvals and deciding
them; artifacts; task records; routines (list, create, run, pause, resume); and the agent status
(the machine's agent, with this device's `placement` and `readiness`). Everything else stays local:
notes, search, settings (`agent/enabled` included: it's a synced setting), sync, connectors,
computer permissions and device routes. It is not an open proxy:

- requests go only to the configured machine URL (`https`, or `http` to loopback in tests), with
  the target rebuilt from the contract's path, validated ids and the query parameters the
  operation declares;
- nothing from the client's request is passed on (its `Authorization`, cookies, `Host`, `Origin`
  and other headers); the relay sends `Authorization: Bearer <machine token>` and, for bodies,
  `Content-Type: application/json`;
- bodies are validated with the contract's schemas and held to the same 5 MB limit; redirects
  aren't followed; each call times out after 5 s; answers are capped at 32 MB and must be the
  daemon's JSON (or artifact bytes, served with the local artifact headers);
- the token and bodies are never logged.

**Events.** The relay holds one WebSocket to the machine's `/ws` (token in the `Authorization`
header, never the URL). The machine's agent events (`thread.*`, `approval.upsert`, `task.record(s)`,
`routines.changed`, `routine.notification`, `orchestrator.activity`, `surface.frame`,
`agent.status`) reach this device's clients in place of the local runtime's; `surface.subscribe`,
`thread.read` and `editor.activity` go to the machine. The link pings every 15 s, reconnects with
backoff (0.5 s up to 30 s), subscribes to watched surfaces again, and after every (re)connection
pushes the machine's status, routines, approvals, thread summaries and current orchestrator
activity to local clients.

**Relay state** (`placement.relay`): `off`, `connecting` (requests are already forwarded),
`connected`, `unreachable` (retrying) or `not_paired` (no credential, or the machine refused it).
While `unreachable` or `not_paired`, and on any device that doesn't hold the agent, the daemon
serves the agent read-only from the synced sidecar (`src/sidecar-view.ts`: threads folded from
their journals, approvals, task records and artifacts, never written); routine files stay editable.
Agent actions answer 503 `agent_unavailable` with one of: "The always-on machine can't be
reached.", "This device isn't paired with the always-on machine.", "The always-on machine no longer
accepts this device. Pair it again.", "The agent is running on <device>." A request forwarded
while the machine stops answering falls back the same way. When the relay state changes, clients
should fetch threads, approvals and task records again.

## Code map

| Module | Role |
| --- | --- |
| `src/main.ts`, `cli.ts` | Entry: start, banner, signal handling; the `pair`/`devices`/`revoke` subcommands. |
| `src/server.ts`, `wiring.ts` | Composition root and ordered shutdown; creates storage, connectors, execution, LLM client, runtime and sync. |
| `src/config.ts`, `env-file.ts`, `token.ts` | Configuration, env files, bearer token. |
| `src/app.ts`, `security.ts`, `errors.ts` | Hono app, Host/Origin/credential guard, error mapping. |
| `src/remote-hosts.ts`, `paired-devices.ts`, `pairing.ts`, `routes/pairing.ts` | Remote hosts, device tokens (`devices.json`), pairing codes and their limits. |
| `src/routes/*` | REST routes and the static web app. |
| `src/ws.ts`, `vault-events.ts`, `write-tracker.ts` | WebSocket hub and change attribution. |
| `src/settings-store.ts`, `settings-schema.ts`, `obsidian-import.ts` | Vault-backed settings. |
| `src/null-runtime.ts`, `null-execution.ts` | Fallbacks when agents are unavailable (routine files stay editable through `@ddl/agent/routines`). |
| `src/sync-setup.ts`, `sync-controller.ts` | The sync target (device identity, token) and the engine, replaceable while running. |
| `src/agent-supervisor.ts`, `agent-lease.ts`, `leased-runtime.ts` | Whether and how this daemon runs the agent: standalone, under the lease (priorities, takeover, yielding), or watching the always-on machine run it. |
| `src/agent-location.ts`, `device-settings.ts`, `home-files.ts` | Read-only views for the relay, device-local settings, atomic writes in `$DDL_HOME`. |
| `src/machine-link.ts`, `readiness.ts` | Pairing with and checking the always-on machine; this daemon's readiness. |
| `src/import/*`, `routes/import.ts` | Importing an Obsidian vault (`importer.ts`, `places.ts`, `walk.ts`, `files.ts`, `carry-over.ts`, `sidecar.ts`, `update.ts`, `manifest.ts`; `test-vaults.ts` builds the synthetic vaults the tests use). |
| `src/vault-switch.ts` | Which vault this daemon opens, and restarting on another. |
| `src/sidecar-view.ts`, `src/relay/*` | The read-only view of the synced sidecar, and the relay. |
| `src/computer-helper.ts`, `drawing-renderer.ts` | Finding the `ddl-computer` helper and the drawing render page. |
| `build.mjs` | esbuild bundle (workspace packages inlined, third-party dependencies external), then the drawing render page in `dist/drawing-renderer` (so the daemon has no runtime dependency on Excalidraw). |

Tests are colocated (`*.test.ts`). They use in-memory vaults and temp directories and never touch the
real home directory or the network.
