# @ddl/daemon

The local Daily Do List server. It owns the markdown vault (through a `StorageProvider`), serves
the web UI, exposes the REST + WebSocket API used by every client (the web and macOS apps today,
an iPhone app later) and runs the always-on agent runtime. Agents can run shell commands and drive
a browser and the desktop, so the daemon is locked down: it binds `127.0.0.1` only, every API call
needs a bearer token, and foreign `Host`/`Origin` headers are rejected. Other devices reach it only
through a private-network proxy under a configured remote host, with device credentials (see
[Remote access and pairing](#remote-access-and-pairing)).

## Running

```sh
pnpm dev          # daemon (tsx watch) + Vite dev server → http://localhost:5173
pnpm dev:mock     # the demo: the mock agent on a throwaway demo vault (DDL_DEMO=1), web on :5174
pnpm build        # bundles the daemon to apps/daemon/dist/main.js and builds apps/web/dist
pnpm start        # production: the daemon serves the built UI → http://127.0.0.1:7331
```

From this package: `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm test`, `pnpm typecheck`.

The banner prints the URL, never the token. `SIGINT`/`SIGTERM`/`SIGHUP` shut down gracefully (the
agent runtime flushes threads and records first); a second signal exits immediately.

### Restarting to apply a change (exit code 75)

Some changes need the daemon to start again: switching to another vault (`PUT /api/device/vault`).
The daemon answers the request, shuts down gracefully and exits with **75** (`RESTART_EXIT_CODE`,
`EX_TEMPFAIL` from sysexits(3)); `vaultPath` in `config.json` already names the new vault.

- **Under the Mac app** (it sets `DDL_SUPERVISED=1`): the app's supervisor starts the daemon again
  at once, and a restart request never counts as a crash. Clients see `restart: "supervisor"`.
- **Started by hand** (`pnpm start`, `node dist/main.js`, `pnpm dev`): nothing starts it again. It
  prints which vault it opens from now on; run the same command again. Clients see
  `restart: "manual"`. A process manager can treat exit code 75 as "restart now".

## Configuration

Precedence: environment variable → `$DDL_HOME/config.json` → default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DDL_HOME` | `~/.daily-do-list` | Machine-local state (created with mode `0700`). |
| `DDL_VAULT` | `~/DailyDoList` | Vault folder. Point it at an existing Obsidian vault to reuse it. Set, it fixes the vault: `PUT /api/device/vault` answers 409 `locked_by_env`. |
| `DDL_PORT` | `7331` | Port on `127.0.0.1`. `0` picks a free port. |
| `DDL_AGENT_MODE` | `live` | `live`, `mock` (scripted agent, no model calls) or `off`. |
| `DDL_MODEL` | `deepseek/deepseek-v4.1-flash` | Default OpenRouter model (used until the vault's settings pick one). |
| `DDL_WEB_DIST` | `apps/web/dist` | Built web UI to serve. |
| `DDL_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `DDL_COMPUTER_HELPER` | found automatically | The `ddl-computer` helper for app control (macOS), or `off`. Otherwise: `<entry script dir>/../bin/ddl-computer` (the app bundle's copy), then a dev build in `apps/macos/Packages/DailyDoListComputer/.build/{release,debug}/`. Without one, computer use stays screen-level. |
| `DDL_DRAWING_RENDERER` | found automatically | The page agents render drawings with (for `read_drawing`'s images), or `off`. Otherwise: `<entry script dir>/drawing-renderer`, then `apps/daemon/dist/drawing-renderer`; `build` and `dev` build it. Without it, or without a browser, agents get drawings as text descriptions only (the startup summary's `drawingRenderer` says which). |
| `OPENROUTER_API_KEY` | — | Required for `live` agents. Without it the agent reports a problem; notes keep working. |
| `DDL_SYNC_URL`, `DDL_SYNC_VAULT` | — | Sync with the sync service (both, or neither; they override `sync` in `config.json`). |
| `DDL_SYNC_TOKEN` | — | The sync service's vault token (else `$DDL_HOME/sync-token`). Never logged. |
| `DDL_AGENT_PLACEMENT` | `this_device` | Where this device's agent runs: `this_device`, `always_on_machine` or `always_on_host` (overrides `agent.placement`). |
| `DDL_REMOTE_HOSTS` | — | Comma-separated remote hosts (overrides `remote.hosts` in `config.json`; clients show them read-only). |
| `DDL_SUPERVISED` | — | `1`: a supervisor starts the daemon again after it exits with 75 (the Mac app sets it). |
| `DDL_DEMO` | — | `1`: the demo (`pnpm dev:mock`, the Mac app's `--demo`). Before starting, seeds `DDL_VAULT` with the demo vault (`src/demo-vault.ts`) and turns computer use off in `DDL_HOME`'s `config.json`. Needs both as absolute paths; an existing vault folder opens as it is and an existing `config.json` stays. |

A device setting set by an environment variable (the placement, the remote hosts, or the sync setup
through any of the three sync variables) is listed in `lockedByEnv` by `GET /api/device`, and the API
refuses to change it (409 `locked_by_env`).

Env files fill in variables that are not already set, in this order: `$DDL_HOME/.env` (preferred:
it lives outside the repo), then `.env.local` in the working directory, then `.env.local` at the root
of this repository. Values are never logged.

`$DDL_HOME` contains:

| File | Purpose |
| --- | --- |
| `daemon-token` | Bearer token: 32 random bytes, hex, mode `0600`, created on first start. Delete it to rotate. |
| `config.json` | Optional daemon config (below). Unknown keys are rejected so typos surface. |
| `mcp.json` | MCP connectors in the `mcpServers` format (see `packages/connectors`). |
| `.env` | Secrets such as `OPENROUTER_API_KEY`. |
| `sync-token` | The sync service's vault token (one line; tightened to `0600` when looser). Written by `PUT /api/device/sync`, never returned. |
| `device.json` | `{ "id", "name" }` of this device, created on first use (the name comes from the host name; rename it with `PATCH /api/device` or by hand, never copy the file to another machine). |
| `devices.json` | Devices paired with this daemon: name, kind, pairing time, last use and the SHA-256 of each token (never the token). Mode `0600`, created on the first pairing. An unreadable file is moved aside to `devices.json.invalid` and every device pairs again. |
| `machine-token` | This device's credential for the always-on machine, `{ "url", "deviceId", "token" }`, mode `0600`, written by `POST /api/machine/pair`. Used only while `url` is the vault's always-on machine. |
| `workspaces/`, browser profile | Agent scratch space, managed by the execution provider. |
| `cache/vault-versions.json` | The vault's file versions by path, mtime and size, saved at shutdown so a restart doesn't re-read every note. Safe to delete. |
| `cache/drawings/` | Drawings rendered for agents (PNG by content hash, at most 64 MB, least recently used removed first). Safe to delete. |

`config.json` (all keys optional; relative paths resolve against `$DDL_HOME`, `~` is expanded):

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

- `sync`: `{ "kind": "none" }`, `{ "kind": "local", "root": "~/Library/Mobile Documents/…" }`,
  `{ "kind": "remote", "url": "https://sync.example.com", "vault": "<vault id>" }` for the sync
  service ([docs/SYNC.md](../../docs/SYNC.md)); `url` must be `https` unless it is this machine.
  The token goes in `sync-token`, never here. With `remote` sync and an agent mode other than `off`,
  the agent runs only while this device holds the vault's agent lease (`src/agent-supervisor.ts`,
  `src/agent-lease.ts`); otherwise its status says which device runs it, and its threads,
  approvals and task records show read-only from the synced sidecar (`src/sidecar-view.ts`), or
  go through the relay (`src/relay/`) while it relays to the always-on machine. `PUT`/`DELETE
  /api/device/sync` edit this key and apply without a restart.
- `agent.placement`: where this device's agent runs (docs/ALWAYS_ON.md): `this_device` (default;
  asks for the agent lease with priority `interactive`), `always_on_host` (this is the always-on
  machine; priority `host`) or `always_on_machine` (never asks). It only matters with the sync
  service, and applies once the vault has an always-on machine (`remote.alwaysOnMachine` in the
  app settings); until then the agent is held on this device. `PATCH /api/device` edits it live.
- `remote.hosts`: the DNS names this daemon answers to besides loopback, e.g. its tailnet name
  behind `tailscale serve` (`host[:port]`, at most 8; no IPs, schemes or paths; `:443` is the same
  as no port). Empty or absent: loopback only. `PATCH /api/device` edits it live. See
  [Remote access and pairing](#remote-access-and-pairing).
- `execution`: `local` (browser headless by default; computer use defaults to on for macOS only,
  with app control when the helper is found, see `DDL_COMPUTER_HELPER`).
- `allowedOrigins`: extra exact origins (`scheme://host[:port]`) for other clients, for example a
  Vite dev server on another port or a native shell (`tauri://localhost`). HTTP(S) origins also allow
  their host in the `Host` allowlist; a host that isn't loopback is served like a remote host (never
  the token in the page).

`PATCH /api/device` and `PUT`/`DELETE /api/device/sync` rewrite `config.json` in place (atomically,
mode `0600`), keeping every key they don't own.

### App settings

User-facing settings (`AppSettings`: theme, editor, daily/weekly notes, agent) live in the vault at
`.daily-do-list/settings.json`, so they travel with the vault. The file holds only explicit
overrides, merged over the defaults (with `DDL_MODEL` as the default model). On first run the
daemon imports what it can from an existing Obsidian vault: `.obsidian/daily-notes.json` (folder,
format, template; Obsidian's own defaults fill missing keys), `.obsidian/app.json` (vim mode, live
preview, readable line length, line numbers, spellcheck) and `.obsidian/appearance.json` (theme).
With nothing to import it writes no file, so a new device joining a synced vault takes the vault's
settings instead of resetting them with its own empty file.

`agent.harness` picks what runs the agent: `pi` on the OpenRouter model `agent.model`, or `cursor`
(the Cursor CLI, signed in with your Cursor account) on `agent.cursorModel`. The safety judge's
`agent.judgeModel` is an OpenRouter model with either harness.

`agent.approvalPolicy` (`ask_every_action` | `ask_risky` | `ask_high_risk` | `run_everything`,
default `ask_risky`) decides when agents ask before acting. A settings update hands it to the
runtime, whose safety gate applies it from the next tool call; a looser policy approves what is
waiting that it wouldn't ask about. The daemon's API and the settings file are out of agents' reach
(the safety rules hard-deny both).

## Security model

- **Loopback only.** The HTTP server listens on `127.0.0.1`; there is no option to bind elsewhere.
  Other devices come in through a private-network proxy on this machine, under a remote host.
- **Bearer token** on every `/api/*` request (`Authorization: Bearer <token>`): the master token
  (`daemon-token`) or a paired app's or daemon's token, compared in constant time. On a remote Host,
  a paired browser's cookie instead (see below). The WebSocket takes the same header, and `?token=`
  on loopback Hosts only (the Vite dev proxy injects the header).
- **Host allowlist** on every request, including static files, which defeats DNS rebinding:
  `127.0.0.1:<port>`, `localhost:<port>`, `localhost:5173`, `127.0.0.1:5173` (the Vite proxy forwards
  the browser's Host unless `changeOrigin` rewrites it to the daemon's), hosts of `allowedOrigins`,
  and the remote hosts (read live). A loopback Host that arrives with proxy forwarding headers
  (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`) is refused: the proxy must keep
  the original Host. A request whose Host and absolute-form target differ is served as the stricter
  of the two (remote if either is).
- **Origin allowlist** on the API and WebSocket: the daemon and Vite origins, `allowedOrigins`, and
  `https://<remote host>` for each remote host. A missing Origin (curl, native clients, Node) is
  fine with a valid token; an unknown Origin, including `null` (sandboxed iframes), is always
  rejected. No CORS headers are ever sent.
- **Token hand-off to the browser.** In production `index.html` is rendered per request with
  `Cache-Control: no-store`: on a loopback Host with `<meta name="ddl-token" content="…">`, readable
  only through the allowlisted Host, never from another origin; on a remote Host with
  `<meta name="ddl-auth" content="cookie|pairing">` and never a token. In development the Vite proxy
  adds the header.
- **Headers.** All responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Resource-Policy: same-origin`; API responses `Cache-Control: no-store`. HTML adds a
  CSP (`default-src 'self'`, inline scripts only by hash, `frame-ancestors 'none'`),
  `X-Frame-Options: DENY` and `Cross-Origin-Opener-Policy: same-origin`.
- **Input validation.** JSON bodies are validated with zod (unknown keys rejected); bodies are
  capped at 5 MB. Note paths are decoded per segment, normalized, and must stay inside the vault,
  contain no control characters, not be hidden (dot-files, `.obsidian`, the `.daily-do-list`
  sidecar) and be a text format (`.md`, `.txt`, `.canvas`, `.json`, …).
- **Artifacts are untrusted.** They are served with `Content-Security-Policy: sandbox;
  default-src 'none'` and `nosniff`; HTML, SVG, XML, JavaScript and PDF are always downloads.
- **Limitation:** any local process that can reach `127.0.0.1` with the right Host header can load
  `index.html`, and so the token. On a shared multi-user machine other OS users could obtain it.

## Remote access and pairing

Off by default. To use the daemon from other devices (the always-on machine, a phone, a second
laptop), put it behind a private-network proxy on the same machine and name it:

1. `tailscale serve --bg --https=443 http://127.0.0.1:7331` (the daemon keeps binding loopback; the
   proxy terminates TLS and keeps the original `Host`).
2. Add the name to `remote.hosts` in `config.json` (or `DDL_REMOTE_HOSTS`) and restart, e.g.
   `"remote": { "hosts": ["vm-name.tailnet-name.ts.net"] }`. The live list is on the app context
   (`remoteHosts`, `src/remote-hosts.ts`), so `PATCH /api/device` changes it without a restart.
3. Pair each device with a code from an authenticated client: Settings → Devices, or `pair` on the
   machine (see [Command line](#command-line)).

Credentials by client:

| Client | Credential | How |
| --- | --- | --- |
| This machine (local page, Mac app, CLI) | master token | page meta tag, `Authorization`, or `?token=` on the WebSocket (loopback only) |
| Paired app or daemon | device token (from `POST /api/pair`, shown once) | `Authorization: Bearer <token>` on REST and on the WebSocket upgrade |
| Paired browser on a remote host | `__Host-ddl-device` cookie (from `POST /api/pair` with `kind: "browser"`) | sent by the browser; accepted only with the page's own `Origin` (or `Sec-Fetch-Site: same-origin` on Origin-less GETs), never on loopback |

- **Pairing codes:** `POST /api/pairing-codes` (any authenticated client) returns 8 characters of
  an unambiguous alphabet (show them as `XXXX-XXXX`), single use, valid 5 minutes, at most 3
  outstanding (else 429 `rate_limited`), plus `https://<first remote host>` for a QR code.
- **`POST /api/pair`** needs no credential: the code is one. Host and Origin are checked, bodies are
  at most 1 KB, 5 attempts a minute are allowed across all clients (429 `rate_limited` with
  `Retry-After`), and 10 wrong codes invalidate every outstanding code. A wrong, expired or used
  code answers 401 `pairing_rejected` (not `unauthorized`). The name given when the code was issued
  wins over the one in the request. `kind: "browser"` works only from the daemon's own `https://`
  page on a remote host (the response carries `Set-Cookie`, no token); on this machine the page
  needs no pairing.
- **Revoking** (`DELETE /api/devices/:id`, Settings, or `revoke`) stops the credential at once and
  closes that device's WebSockets with 1008 `Device revoked`; a browser revoking itself also gets
  its cookie cleared. `GET /api/devices` marks the caller with `current: true`.
- **Pages on a remote host** say `ddl-auth` `cookie` when the browser holds a working cookie, else
  `pairing`. A link followed from another site arrives without the cookie (`SameSite=Strict`), so
  the page's first same-origin request, which carries it, is the real answer.
- Codes, tokens and cookies are never logged; the log names device ids and kinds.

## Command line

The entry point doubles as a small CLI for headless machines. Run it as the daemon's user, since
it reads `daemon-token` and calls the running daemon on its configured port (`DDL_PORT` or
`config.json`); without a command it starts the daemon.

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

## REST API

All paths come from `API_PATHS` in `@ddl/core` (`packages/core/src/protocol.ts`). Errors are
`{ "error": "<code>", "message": "…" }` (`ApiErrorBody`). Common codes: `invalid_request` and
`invalid_json` (400), `invalid_path` (400), `unauthorized` (401), `pairing_rejected` (401, a bad
pairing code), `forbidden_host` and `forbidden_origin` (403), `forbidden_device` (403, a paired
device calling a route only this machine may call), `not_found` (404), `conflict` (409),
`payload_too_large` (413), `rate_limited` (429), `agent_unavailable` (503), `agent_error` (500).

| Method | Path | Body → Response |
| --- | --- | --- |
| GET | `/api/health` | → `HealthResponse` |
| GET | `/api/vault/tree` | → `VaultTreeResponse` (visible files and folders) |
| GET | `/api/notes/<path>` | → `NoteResponse` (404 when missing) |
| PUT | `/api/notes/<path>` | `WriteNoteRequest` → `WriteNoteResponse` (201 created, 200 updated, 409 `ConflictResponse`) |
| DELETE | `/api/notes/<path>` | → `TrashResponse` (`{ ok: true, trashedTo }`: moved into `.trash/`; 404 when missing) |
| POST | `/api/notes-rename` | `RenameRequest` → `RenameResponse` (a note answers like a write, a folder with `{ path, moved }`; 404 no source, 409 the target exists, with `ConflictResponse` for a note) |
| POST | `/api/folders` | `CreateFolderRequest` → 201 `{ path }` |
| DELETE | `/api/folders?path=<path>` | → `TrashResponse` (the folder and everything in it moved into `.trash/`; 404 when missing) |
| GET | `/api/daily/<YYYY-MM-DD\|today>?create=1` | → `DailyNoteResponse` (404 without `create=1`) |
| GET | `/api/search?q=<query>&limit=<n>` | → `SearchResponse` |
| GET | `/api/settings` | → `SettingsResponse` |
| PUT (or PATCH) | `/api/settings` | `UpdateSettingsRequest` (deep partial) → `SettingsResponse` |
| GET | `/api/agent/status` | → `AgentStatusResponse` |
| PUT (or POST) | `/api/agent/enabled` | `SetAgentEnabledRequest` → `AgentStatusResponse` (persisted as `agent.enabled`) |
| GET | `/api/tasks?notePath=<path>` | → `TaskRecordsResponse` |
| GET | `/api/threads[?notePath=&taskId=&routineId=]` | → `ThreadListResponse` (`routineId`: that routine's runs) |
| GET | `/api/threads/<id>` | → `ThreadResponse` |
| POST | `/api/threads/<id>/messages` | `PostMessageRequest` → `{ ok: true }` |
| POST | `/api/threads/<id>/cancel` | → `{ ok: true }` |
| POST | `/api/threads/<id>/retry` | → `{ ok: true }` |
| GET | `/api/approvals[?status=pending]` | → `ApprovalListResponse` |
| GET | `/api/approvals/<id>` | → `{ approval }` |
| POST | `/api/approvals/<id>` | `ApprovalDecisionRequest` → `{ approval }` (404 unknown, 409 already decided with `approval`) |
| GET | `/api/artifacts/<threadId>/<artifactId>[?download=1]` | → artifact bytes |
| GET | `/api/routines` | → `RoutineListResponse` (every routine, sorted by name, and the starter `templates`) |
| POST | `/api/routines` | `CreateRoutineRequest` → 201 `RoutineResponse` (writes `Routines/<name>.md`; 400 bad name, schedule or instructions; 409 the routine exists) |
| GET | `/api/routines/<id>` | → `RoutineResponse` (404 unknown) |
| POST | `/api/routines/<id>/run` | → `RoutineRunResponse` (`{ routine, threadId }`; 404 unknown, 409 can't start now, 503 no agent here) |
| POST | `/api/routines/<id>/pause` | → `RoutineResponse` (sets `paused: true` in the file; 404 unknown, 409 the file kept changing) |
| POST | `/api/routines/<id>/resume` | → `RoutineResponse` (sets `paused: false`; same codes as pause) |
| GET | `/api/connectors` | → `{ connectors: ConnectorStatus[] }` |
| GET | `/api/sync/status` | → `SyncStatusResponse` (state, target, last sync, pending, conflicts; with the sync service also `remoteHost`, `deviceName`) |
| GET | `/api/device` | → `DeviceSettingsResponse` (this device's id and name, placement, remote hosts, sync setup with `hasToken`, `lockedByEnv`) |
| PATCH | `/api/device` | `DeviceSettingsPatch` (`name`, `placement`, `remoteHosts`) → `DeviceSettingsResponse` (400 invalid, 409 `locked_by_env`) |
| PUT | `/api/device/sync` | `DeviceSyncSetupRequest` (`url`, `vault`, optional `token`) → `DeviceSettingsResponse` (400 invalid or no token saved yet, 409 `locked_by_env`) |
| DELETE | `/api/device/sync` | → `DeviceSettingsResponse` (sync off, token deleted; 409 `locked_by_env`) |
| GET | `/api/device/vault` | → `DeviceVaultResponse` (`path`, `lockedByEnv`). This machine only. |
| PUT | `/api/device/vault` | `DeviceVaultRequest` (`{ path }`) → `DeviceVaultResponse` with `restart`, then exits with 75 (see [Restarting](#restarting-to-apply-a-change-exit-code-75)); the same vault answers without `restart` (400 not an existing folder or in `$DDL_HOME`, 409 `locked_by_env`, or `conflict` while an import runs, the vault syncs or a restart is pending). This machine only. |
| POST | `/api/import/obsidian/preview` | `ObsidianImportPreviewRequest` (`{ source }`) → `ObsidianImportPreview` (reads the folder, writes nothing; 400 a source that isn't allowed). This machine only. |
| GET | `/api/import/obsidian` | → `ObsidianImportStatusResponse` (`{ job, imported? }`: the running import or update, or the last one, `null` before any; `imported`, from the vault's manifest, when this vault was imported: the Obsidian vault, when, the last update and the previous vault). This machine only. |
| POST | `/api/import/obsidian` | `ObsidianImportRequest` (`{ source, destination? }`) → 202 `ObsidianImportJobResponse` (400 source or destination not allowed, 409 a job runs); `import.progress` events follow it. This machine only. |
| POST | `/api/import/obsidian/cancel` | → `ObsidianImportJobResponse` (the stopped job, once its staging folder is removed; 404 nothing runs). This machine only. |
| POST | `/api/import/obsidian/update` | → 202 `ObsidianImportJobResponse` (404 this vault wasn't imported, or the Obsidian vault moved; 409 a job runs). This machine only. |
| GET | `/api/machine` | → `MachineStatusResponse` (the always-on machine, this device's pairing, the last check) |
| POST | `/api/machine/pair` | `MachinePairRequest` (`url`, `code`, optional `name`) → `MachineStatusResponse` (400, 401 `pairing_rejected`, 429 `rate_limited`, 502 `machine_unreachable`) |
| POST | `/api/machine/check` | → `MachineStatusResponse` (checked now) |
| DELETE | `/api/machine/pairing` | → `MachineStatusResponse` (credential deleted; revoked on the machine when it answers) |
| POST | `/api/computer/permissions/open` | `ComputerPermissionsOpenRequest` (`{ pane: "accessibility" \| "screenRecording" }`) → `{ ok: true }` (404 off macOS, 500 if it didn't open) |
| POST | `/api/pairing-codes` | `PairingCodeRequest` (`{ name? }`) → 201 `PairingCodeResponse` (429 with 3 codes outstanding or 50 devices paired) |
| POST | `/api/pair` | **No bearer.** `PairRequest` (`{ code, name, kind }`) → 201 `PairResponse` (token for `app`/`daemon`, `Set-Cookie` for `browser`; 400, 401 `pairing_rejected`, 413 over 1 KB, 429 `rate_limited`) |
| GET | `/api/devices` | → `PairedDevicesResponse` (`current: true` on the caller) |
| DELETE | `/api/devices/<id>` | → 204 (400 malformed id, 404 unknown); closes that device's WebSockets |

Notes:

- `<path>` is encoded per segment (`encodeVaultPath`). `baseVersion`: a version string makes the
  write conditional, `null` means create-only, omitting it overwrites.
- Send `x-ddl-client-id: <id>` (`CLIENT_ID_HEADER`) on writes; the resulting `vault.changed` event
  carries that `clientId` so the writer can ignore its own echo.
- `daily`: `today` and dates use the daemon's local time zone. A missing note is created from the
  configured template (rendered with `{{title}}`, `{{date}}`, `{{time}}`) or `- [ ] `; if another
  writer creates it first, theirs is returned with `created: false`.
- Thread actions that take longer than 3 s answer `202 { ok: true, pending: true }` and finish in
  the background.
- `thr_orchestrator` (`ORCHESTRATOR_THREAD_ID`) is the orchestrator's own chat: it's listed with
  the other threads (without `notePath`, so a `?notePath=` filter leaves it out) and records every
  orchestrator turn. `POST …/messages` on it is a direct message the orchestrator answers in the
  chat, `POST …/cancel` stops the turn in progress (a no-op when idle), and `…/retry` answers 503
  `agent_unavailable`. While the agent can't run (`DDL_AGENT_MODE=off`, no harness) it stays idle
  and a message gets a note saying why; only when the agent runtime couldn't load at all (the null
  runtime) is there no such thread.
- Routines are files in the vault's `Routines/` folder (see "Routines" in
  [docs/AGENT_SYSTEM.md](../../docs/AGENT_SYSTEM.md#routines)). Listing, creating, pausing and
  resuming only touch those files, so they work whatever the agent's state: with
  `DDL_AGENT_MODE=off`, when the agent runtime failed to load, and on a device that doesn't hold
  the agent lease (the null runtime reads them, and follows the synced scheduler state for next
  and last runs). Running one needs the agent: `run` checks the routine exists (404), then answers
  503 `agent_unavailable` with the reason when the agent can't run here (off, not configured,
  switched off, or running on another device), and 409 `conflict` when the routine can't start
  now (a run of it is going, its file has a problem, or today's extra runs are used up). A run's
  thread has `routineId`; list a routine's runs with `/api/threads?routineId=<id>`. Create and
  pause errors: 400 `invalid_request` (the name, schedule or instructions, with the reason in
  `message`), 404 `not_found`, 409 `conflict`.
- `computer/permissions/open` runs `open` on a fixed System Settings deep link for the pane (the
  pane, then Privacy & Security); nothing from the request reaches the command. `AgentStatusResponse`
  reports `execution.computerAccess`: both permissions, whether app control is available, and the
  app macOS attributes the daemon's permissions to (found by walking the parent process chain).
- `agent/status` also reports `placement` (the stored placement, `heldHere` when the agent is held on
  this device, `runsOn`, the relay state and a handover `note`) and this daemon's `readiness`
  (harness ready or its problem, a model credential present, browser, desktop control, connectors),
  booleans and counts only. `agent.status` fires when either changes.
- `device`: a new placement applies live. Switching away from `this_device` stops the agent, syncs
  and releases the lease; switching to it asks for the lease and takes it over from the always-on
  machine (the note says so while it happens).
- `device/sync` answers once the new setup runs: a held lease is released after the agent stopped
  and synced, the old engine stops, and the new one starts (no restart needed).
- `machine/*`: outbound calls to the machine are https only (plain http only to loopback), time out
  after 5 s, don't follow redirects and send the token only in `Authorization`. `pair` calls the
  machine's `POST /api/pair` as kind `daemon` with this device's name, and sets
  `remote.alwaysOnMachine` in the (synced) app settings. `GET /api/machine` checks again in the
  background when the last check is older than 30 s; nothing polls while nobody asks.
- `import/obsidian*` and `device/vault`: see [Importing from Obsidian](#importing-from-obsidian).
- Everything outside `/api/*` and `/ws` serves the built UI with SPA fallback. Hashed files under
  `/assets/` are cached immutably. If there is no build, a short page explains how to create one.

## WebSocket (`/ws`)

Connect to `ws://127.0.0.1:<port>/ws` with `Authorization: Bearer <token>` (or `?token=<token>`,
which works on loopback Hosts only; on a remote host it is refused even when valid). A paired browser
on a remote host sends its cookie and its page's `Origin` instead. Every credential presented must be
valid, and at most one `?token=`. The upgrade is refused with 401/403/404 on a bad credential, Host,
Origin or path. The server sends `hello` first. Revoking a device closes its sockets with 1008
(`Device revoked`); reconnecting then gets 401.

Server → client (`ServerEvent`):

| Event | When |
| --- | --- |
| `hello` | On connect: `serverVersion`, `apiVersion`. |
| `vault.changed` | Visible files changed. Coalesced over ~30 ms, one change per path. `origin` is `client` (with `clientId`, for writes made through the API), `agent`, `sync` or `external` (another app, such as Obsidian). |
| `task.records` / `task.record` | Agent badges for a note / one task. |
| `thread.upsert` / `thread.message` / `thread.delta` | Thread summaries, messages, streamed text (the orchestrator's chat, `thr_orchestrator`, included). |
| `approval.upsert` | An approval was created or decided. |
| `agent.status` | `AgentStatusResponse` changed (its `orchestrator` is what the orchestrator is doing now, for a client joining mid-turn). |
| `orchestrator.activity` | What the orchestrator is doing: lines it noticed before they settle, each turn's phase (`reading`, `thinking`, `acting`) and its end (`idle` with an outcome). Coalesced, never per keystroke; see docs/AGENT_SYSTEM.md. |
| `surface.frame` | Live browser/computer frame, only to clients subscribed to that thread's surface. |
| `settings.changed` | Settings were saved here, or a change synced from another device was reloaded. |
| `routines.changed` | Every routine (as `GET /api/routines` lists them), whenever one changed: its file, its next run, its last run's status. Also sent when the agent lease moves to or from this device. |
| `routine.notification` | A routine's run finished and its `notify` says to tell the user (`RoutineNotification`: routine, title, one or two lines, thread, status). |
| `import.progress` | An import or update from Obsidian changed phase or state, or copied more (at most every 200 ms): the whole `ObsidianImportJob`, with `result` or `update` once `done`. |
| `error` | A client message was rejected. |

Client → server (`ClientEvent`): `hello { clientId }`, `ping`, `surface.subscribe` /
`surface.unsubscribe { threadId, surface }` (the runtime streams a surface only while at least one
client is subscribed), `thread.read { threadId }`, and `editor.activity { notePath, line }` (so the
orchestrator never acts on a half-typed task).

The server pings every 30 s and drops clients that do not answer. Under backpressure (more than
1 MB buffered) `surface.frame` and `thread.delta` are skipped for that client; the final
`thread.message` carries the full text. A client with more than 16 MB buffered is disconnected and
must reconnect and resync.

## Importing from Obsidian

The user copies their Obsidian vault; Daily Do List makes a **new vault** from it and carries the
current vault over. The Obsidian vault is only ever read, and the current vault is never written:
it stays as the backup. The product decisions are in the spec, `docs/specs/obsidian-migration.md`.

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
     with the new path and routine id (snapshots an older app wrote migrated in on the way), and a
     thread whose task isn't in its note any more is kept with a system note saying it's detached.
     Approvals, artifacts and anything unknown are copied byte for byte; the sync engine's
     snapshots and an earlier import's manifest stay behind;
   - `settings.json`: this vault's, with the new daily-note settings and Obsidian's editor settings;
   - the manifest, `.daily-do-list/import/obsidian.json` (see `docs/DATA_FORMATS.md`), which
     also records the previous vault, so `GET /api/import/obsidian` can say where the backup is
     after the switch.
   The finished staging folder is renamed to the destination. Cancelling, a failure or a daemon
   shutdown removes the staging folder: the destination never holds half an import.
3. **Switch** (`PUT /api/device/vault`), which restarts the daemon on the new vault. Switching is
   refused while the vault syncs: turn sync off first (or point this device at a new sync vault),
   or the old notes would sync into the new one.
4. **Update from Obsidian** (`POST /api/import/obsidian/update`), for a while the user still writes
   in Obsidian: copies what changed there since the manifest. Changed there and not here: replaced.
   Changed on both sides (a merged daily note always counts as changed here): kept, and the Obsidian
   version saved as `Name (Obsidian).md`. New there: copied (as a conflict copy if this vault has
   another file at that path). Deleted here and changed there: written back. It never deletes, and
   its writes are atomic and synced.

Rules that hold throughout:

- The source must be an existing, readable folder that is not, holds nor sits inside `$DDL_HOME` or
  the current vault; the destination must be new or empty (Finder's `.DS_Store` aside), in a
  writable folder, and not inside the source, `$DDL_HOME` or the current vault. Both are compared
  by real path.
- Links are followed only to files inside the vault being read; links elsewhere, links to folders
  and special files are skipped and reported. Files are opened without following links and
  without blocking. Nothing from the source is ever executed.
- Only this machine may call these routes: a paired device gets 403 `forbidden_device`. They aren't
  agent tools, and the safety rules deny agents any call to the daemon's API
  (`network.app-self-access`) and any write under `.daily-do-list/`.
- Threads are carried over as journals (`.daily-do-list/state/journal/threads/`,
  `src/import/sidecar.ts`): thread snapshots an older app wrote are migrated into the journal with
  the thread store's planner (`planSnapshotImports`), the thread events (`thread.created`,
  `thread.imported`) get the new note path and routine id (`remapJournalFile`), a detached thread
  gets its system note appended, and every other line is copied byte for byte.

## The agent relay

When this device's effective placement is `always_on_machine` and it holds a credential for the
machine, the daemon forwards the agent to the always-on machine's daemon, so this device's clients
show and act on the machine's agent with the same API ([docs/ALWAYS_ON.md](../../docs/ALWAYS_ON.md#the-agent-relay)).
Otherwise everything stays local, as without a relay. The code is in `src/relay/`; it reads the
effective placement from the agent supervisor (and reports the relay state back to it, for the
status's `placement` block) and the credential from the machine link (`machine-token`, only while
its URL is the vault's always-on machine), through the interfaces in `src/agent-location.ts`, and
follows their changes live. A relaying device never asks for the agent lease.

**Forwarded** (the allowlist in `src/relay/routes.ts`, derived from the contract):

| Routes | Methods |
| --- | --- |
| `/api/threads`, `/api/threads/<id>` (the orchestrator's `thr_orchestrator` included) | GET |
| `/api/threads/<id>/messages`, `…/cancel`, `…/retry` | POST |
| `/api/approvals`, `/api/approvals/<id>` | GET; POST (decide) on `<id>` |
| `/api/artifacts/<threadId>/<artifactId>` | GET |
| `/api/tasks?notePath=` | GET |
| `/api/routines`, `/api/routines/<id>` | GET; POST (create) on `/api/routines` |
| `/api/routines/<id>/run`, `…/pause`, `…/resume` | POST |
| `/api/agent/status` | GET (the machine's agent, with this device's `placement` block and `readiness`) |

Everything else stays local: notes, folders, daily notes, search, settings (`/api/agent/enabled`
included: it's a synced setting), sync, connectors, computer permissions, device routes, and any
other method or path. It is not an open proxy:

- requests go only to the configured machine URL (`https`, or `http` to loopback in tests), with
  the target rebuilt from the contract's path, validated ids and the query parameters the
  operation declares;
- nothing from the client's request is passed on (its `Authorization`, cookies, `Host`, `Origin`
  and other headers); the relay sends `Authorization: Bearer <machine token>` and, for bodies,
  `Content-Type: application/json`;
- bodies are validated with the contract's schemas first and held to the same 5 MB limit;
  redirects aren't followed; each call times out after 5 s; answers are capped at 32 MB and must
  be the daemon's JSON (or artifact bytes, served with the local artifact headers);
- the token and bodies are never logged.

**Events.** The relay holds one WebSocket to the machine's `/ws`, with the token in the
`Authorization` header (never in the URL). The machine's agent events reach this device's clients
in place of the local runtime's: `thread.*`, `approval.upsert`, `task.record(s)`,
`routines.changed`, `routine.notification`, `orchestrator.activity`, `surface.frame` and
`agent.status` (merged as above).
Clients' `surface.subscribe`/`unsubscribe`, `thread.read` and `editor.activity` go to the machine.
The link pings every 15 s, reconnects with backoff (0.5 s up to 30 s), subscribes to watched
surfaces again, and after every (re)connection pushes the machine's status, routines, approvals and
thread summaries to local clients, and the machine's current orchestrator activity. When it stops
relaying, clients get this device's own activity (nothing in progress) in its place.

**Relay state** (`agent.status` → `placement.relay`): `off` (not relaying), `connecting` (the
first connection; requests are already forwarded), `connected`, `unreachable` (the link is down;
retrying) or `not_paired` (no credential, or the machine refused it). While `unreachable` or
`not_paired`, `problem` says why this device can't act on the agent (the messages below) and
`placement.runsOn` still says where it runs.

**Fallback.** While `unreachable` or `not_paired`, and on any device that doesn't hold the agent
(another device runs it), the daemon serves the agent read-only from the synced sidecar: threads
(each the fold of its journal), approvals, task records and artifacts, parsed with the contract's
persisted formats; it never writes them. Routine files stay listable, creatable and pausable (they
sync). Agent actions (messages, cancel, retry, deciding an approval, running a routine) answer 503
`agent_unavailable` with one of:

- "The always-on machine can't be reached."
- "This device isn't paired with the always-on machine."
- "The always-on machine no longer accepts this device. Pair it again." (it refused the credential)
- "The agent is running on <device>." (another device holds the agent)

A request forwarded while the machine stops answering falls back the same way (reads served here,
actions 503). When the relay state changes, clients should fetch threads, approvals and task
records again.

## Code map

| Module | Role |
| --- | --- |
| `src/main.ts`, `cli.ts` | Entry: start, banner, signal handling; the `pair`/`devices`/`revoke` subcommands. |
| `src/server.ts` | Composition root and ordered shutdown. |
| `src/wiring.ts` | Creates storage, connectors, execution, LLM client, runtime and sync. |
| `src/config.ts`, `env-file.ts`, `token.ts` | Configuration, env files, bearer token. |
| `src/app.ts`, `security.ts`, `errors.ts` | Hono app, Host/Origin/credential guard (loopback vs remote Hosts, device cookie), error mapping. |
| `src/remote-hosts.ts` | The live list of remote hosts the security policy reads. |
| `src/paired-devices.ts`, `pairing.ts`, `routes/pairing.ts` | Device tokens (`devices.json`), pairing codes and their limits, the pairing routes. |
| `src/routes/*` | REST routes and the static web app. |
| `src/ws.ts`, `vault-events.ts`, `write-tracker.ts` | WebSocket hub (upgrade auth, closing revoked devices' sockets) and change attribution. |
| `src/settings-store.ts`, `settings-schema.ts`, `obsidian-import.ts` | Vault-backed settings. |
| `src/null-runtime.ts`, `null-execution.ts` | Fallbacks when agents are unavailable (routine files stay editable through `@ddl/agent/routines`). |
| `src/sync-setup.ts`, `sync-controller.ts` | Sync service target (device identity, token), and the sync engine, replaceable while running. |
| `src/agent-supervisor.ts` | Whether and how this daemon runs the agent: standalone, under the lease (by placement and priority), or watching the always-on machine run it. |
| `src/agent-lease.ts`, `leased-runtime.ts` | The agent lease (priorities, takeover, yielding), and the runtime that exists only while holding it. |
| `src/agent-location.ts` | Read-only views for the relay: the placement and the machine credential. |
| `src/device-settings.ts`, `home-files.ts`, `remote-hosts.ts` | Device-local settings, atomic writes in `$DDL_HOME`, the remote hosts registry. |
| `src/machine-link.ts` | Pairing with and checking the always-on machine. |
| `src/readiness.ts` | This daemon's readiness to run the agent. |
| `src/import/*`, `routes/import.ts` | Importing an Obsidian vault: `importer.ts` (preview, jobs, update), `places.ts` (where it may read and write), `walk.ts` and `files.ts` (no link escapes, atomic byte-exact copies), `carry-over.ts`, `sidecar.ts`, `settings-merge.ts`, `update.ts`, `manifest.ts`; `test-vaults.ts` builds the synthetic vaults the tests use. |
| `src/vault-switch.ts` | Which vault this daemon opens, and restarting on another (`RESTART_EXIT_CODE`). |
| `src/sidecar-view.ts` | The agent's work read-only from the synced sidecar, for a device that doesn't run it. |
| `src/relay/*` | The agent relay: allowlist, calls to the machine, its WebSocket link, the relaying runtime. |
| `src/computer-helper.ts`, `drawing-renderer.ts` | Finding the `ddl-computer` helper and the drawing render page. |
| `build.mjs` | esbuild bundle (workspace packages inlined, third-party dependencies external), then the drawing render page in `dist/drawing-renderer` (`packages/agent/scripts/build-drawing-renderer.mjs`: Excalidraw's export bundled for the browser at build time, so the daemon has no runtime dependency on it). |

Tests are colocated (`*.test.ts`). They use in-memory vaults and temp directories and never touch the
real home directory or the network.
