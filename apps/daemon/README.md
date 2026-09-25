# @ddl/daemon

The local Daily Do List server. It owns the markdown vault (through a `StorageProvider`), serves
the web UI, exposes the REST + WebSocket API used by every client (web today, the macOS/iOS shells
later) and runs the always-on agent runtime. Agents can run shell commands and drive a browser and
the desktop, so the daemon is locked down: it binds `127.0.0.1` only, every API call needs a bearer
token, and foreign `Host`/`Origin` headers are rejected.

## Running

```sh
pnpm dev          # daemon (tsx watch) + Vite dev server → http://localhost:5173
pnpm dev:mock     # same, with the deterministic mock agent (DDL_AGENT_MODE=mock)
pnpm build        # bundles the daemon to apps/daemon/dist/main.js and builds apps/web/dist
pnpm start        # production: the daemon serves the built UI → http://127.0.0.1:7331
```

From this package: `pnpm dev`, `pnpm build`, `pnpm start`, `pnpm test`, `pnpm typecheck`.

The banner prints the URL, never the token. `SIGINT`/`SIGTERM`/`SIGHUP` shut down gracefully (the
agent runtime flushes threads and records first); a second signal exits immediately.

## Configuration

Precedence: environment variable → `$DDL_HOME/config.json` → default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DDL_HOME` | `~/.daily-do-list` | Machine-local state (created with mode `0700`). |
| `DDL_VAULT` | `~/DailyDoList` | Vault folder. Point it at an existing Obsidian vault to reuse it. |
| `DDL_PORT` | `7331` | Port on `127.0.0.1`. `0` picks a free port. |
| `DDL_AGENT_MODE` | `live` | `live`, `mock` (scripted agent, no model calls) or `off`. |
| `DDL_MODEL` | `deepseek/deepseek-v4.1-flash` | Default OpenRouter model (used until the vault's settings pick one). |
| `DDL_WEB_DIST` | `apps/web/dist` | Built web UI to serve. |
| `DDL_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `DDL_COMPUTER_HELPER` | found automatically | The `ddl-computer` helper for app control (macOS), or `off`. Otherwise: `<entry script dir>/../bin/ddl-computer` (the app bundle's copy), then a dev build in `apps/macos/Packages/DailyDoListComputer/.build/{release,debug}/`. Without one, computer use stays screen-level. |
| `OPENROUTER_API_KEY` | — | Required for `live` agents. Without it the agent reports a problem; notes keep working. |
| `DDL_SYNC_URL`, `DDL_SYNC_VAULT` | — | Sync with the sync service (both, or neither; they override `sync` in `config.json`). |
| `DDL_SYNC_TOKEN` | — | The sync service's vault token (else `$DDL_HOME/sync-token`). Never logged. |

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
| `sync-token` | The sync service's vault token (one line; tightened to `0600` when looser). |
| `device.json` | `{ "id", "name" }` of this device for the sync service, created on first use (the name comes from the host name; edit it freely, never copy the file to another machine). |
| `workspaces/`, browser profile | Agent scratch space, managed by the execution provider. |

`config.json` (all keys optional; relative paths resolve against `$DDL_HOME`, `~` is expanded):

```json
{
  "vaultPath": "~/DailyDoList",
  "port": 7331,
  "agentMode": "live",
  "model": "deepseek/deepseek-v4.1-flash",
  "sync": { "kind": "none" },
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
  `{ "kind": "s3", "bucket": "…", "prefix": "…", "region": "…" }` (stub) or
  `{ "kind": "remote", "url": "https://sync.example.com", "vault": "<vault id>" }` for the sync
  service ([docs/SYNC.md](../../docs/SYNC.md)); `url` must be `https` unless it is this machine.
  The token goes in `sync-token`, never here. With `remote` sync and an agent mode other than `off`,
  the agent runs only while this device holds the vault's agent lease (`src/agent-lease.ts`,
  `src/leased-runtime.ts`); otherwise its status says which device runs it, and its threads,
  approvals and task records show read-only from the synced sidecar (`src/sidecar-view.ts`).
- `execution`: `local` (browser headless by default; computer use defaults to on for macOS only,
  with app control when the helper is found, see `DDL_COMPUTER_HELPER`) or
  `{ "kind": "cloud", "endpoint": "https://…", "apiKeyEnv": "NAME_OF_ENV_VAR" }`.
- `allowedOrigins`: extra exact origins (`scheme://host[:port]`) for other clients, for example a
  Vite dev server on another port or a native shell (`tauri://localhost`). HTTP(S) origins also allow
  their host in the `Host` allowlist.

### App settings

User-facing settings (`AppSettings`: theme, editor, daily/weekly notes, agent) live in the vault at
`.daily-do-list/settings.json`, so they travel with the vault. The file holds only explicit
overrides, merged over the defaults (with `DDL_MODEL` as the default model). On first run the
daemon imports what it can from an existing Obsidian vault: `.obsidian/daily-notes.json` (folder,
format, template; Obsidian's own defaults fill missing keys), `.obsidian/app.json` (vim mode, live
preview, readable line length, line numbers, spellcheck) and `.obsidian/appearance.json` (theme).

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
- **Bearer token** on every `/api/*` request (`Authorization: Bearer <token>`), compared in constant
  time. The WebSocket accepts `?token=` or the same header (the Vite dev proxy injects it).
- **Host allowlist** on every request, including static files, which defeats DNS rebinding:
  `127.0.0.1:<port>`, `localhost:<port>`, `localhost:5173`, `127.0.0.1:5173` (the Vite proxy forwards
  the browser's Host unless `changeOrigin` rewrites it to the daemon's), plus hosts of
  `allowedOrigins`.
- **Origin allowlist** on the API and WebSocket: the daemon and Vite origins plus `allowedOrigins`.
  A missing Origin (curl, native clients, Node) is fine with a valid token; an unknown Origin,
  including `null` (sandboxed iframes), is always rejected. No CORS headers are ever sent.
- **Token hand-off to the browser.** In production `index.html` is rendered per request with
  `<meta name="ddl-token" content="…">` and `Cache-Control: no-store`. It is readable only through
  the allowlisted Host, never from another origin. In development the Vite proxy adds the header.
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

## REST API

All paths come from `API_ROUTES` in `@ddl/core` (`packages/core/src/protocol.ts`). Errors are
`{ "error": "<code>", "message": "…" }` (`ApiErrorBody`). Common codes: `invalid_request` and
`invalid_json` (400), `invalid_path` (400), `unauthorized` (401), `forbidden_host` and
`forbidden_origin` (403), `not_found` (404), `conflict` (409), `payload_too_large` (413),
`agent_unavailable` (503), `agent_error` (500).

| Method | Path | Body → Response |
| --- | --- | --- |
| GET | `/api/health` | → `HealthResponse` |
| GET | `/api/vault/tree` | → `VaultTreeResponse` (visible files and folders) |
| GET | `/api/notes/<path>` | → `NoteResponse` (404 when missing) |
| PUT | `/api/notes/<path>` | `WriteNoteRequest` → `WriteNoteResponse` (201 created, 200 updated, 409 `ConflictResponse`) |
| DELETE | `/api/notes/<path>` | → `{ ok: true }` |
| POST | `/api/notes-rename` | `RenameRequest` → `WriteNoteResponse` (409 `ConflictResponse` if the target exists) |
| POST | `/api/folders` | `CreateFolderRequest` → 201 `{ path }` |
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
| POST | `/api/computer/permissions/open` | `ComputerPermissionsOpenRequest` (`{ pane: "accessibility" \| "screenRecording" }`) → `{ ok: true }` (404 off macOS, 500 if it didn't open) |

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
- Everything outside `/api/*` and `/ws` serves the built UI with SPA fallback. Hashed files under
  `/assets/` are cached immutably. If there is no build, a short page explains how to create one.

## WebSocket (`/ws`)

Connect to `ws://127.0.0.1:<port>/ws?token=<token>` (or send the `Authorization` header). The upgrade
is refused with 401/403/404 on a bad token, Host, Origin or path. The server sends `hello` first.

Server → client (`ServerEvent`):

| Event | When |
| --- | --- |
| `hello` | On connect: `serverVersion`, `apiVersion`. |
| `vault.changed` | Visible files changed. Coalesced over ~30 ms, one change per path. `origin` is `client` (with `clientId`, for writes made through the API), `agent`, `sync` or `external` (another app, such as Obsidian). |
| `task.records` / `task.record` | Agent badges for a note / one task. |
| `thread.upsert` / `thread.message` / `thread.delta` | Thread summaries, messages, streamed text (the orchestrator's chat, `thr_orchestrator`, included). |
| `approval.upsert` | An approval was created or decided. |
| `agent.status` | `AgentStatusResponse` changed. |
| `surface.frame` | Live browser/computer frame, only to clients subscribed to that thread's surface. |
| `settings.changed` | Settings were saved. |
| `routines.changed` | Every routine (as `GET /api/routines` lists them), whenever one changed: its file, its next run, its last run's status. Also sent when the agent lease moves to or from this device. |
| `routine.notification` | A routine's run finished and its `notify` says to tell the user (`RoutineNotification`: routine, title, one or two lines, thread, status). |
| `error` | A client message was rejected. |

Client → server (`ClientEvent`): `hello { clientId }`, `ping`, `surface.subscribe` /
`surface.unsubscribe { threadId, surface }` (the runtime streams a surface only while at least one
client is subscribed), `thread.read { threadId }`, and `editor.activity { notePath, line }` (so the
orchestrator never acts on a half-typed task).

The server pings every 30 s and drops clients that do not answer. Under backpressure (more than
1 MB buffered) `surface.frame` and `thread.delta` are skipped for that client; the final
`thread.message` carries the full text. A client with more than 16 MB buffered is disconnected and
must reconnect and resync.

## The agent relay

When this device's effective placement is `always_on_machine` and it holds a credential for the
machine, the daemon forwards the agent to the always-on machine's daemon, so this device's clients
show and act on the machine's agent with the same API ([docs/ALWAYS_ON.md](../../docs/ALWAYS_ON.md#the-agent-relay)).
Otherwise everything stays local, as without a relay. The code is in `src/relay/`; it reads the
placement and the credential through two small interfaces (`src/relay/sources.ts`) and follows
their changes live. A relaying device never asks for the agent lease.

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
`routines.changed`, `routine.notification`, `surface.frame` and `agent.status` (merged as above).
Clients' `surface.subscribe`/`unsubscribe`, `thread.read` and `editor.activity` go to the machine.
The link pings every 15 s, reconnects with backoff (0.5 s up to 30 s), subscribes to watched
surfaces again, and after every (re)connection pushes the machine's status, routines, approvals and
thread summaries to local clients.

**Relay state** (`agent.status` → `placement.relay`): `off` (not relaying), `connecting` (the
first connection; requests are already forwarded), `connected`, `unreachable` (the link is down;
retrying) or `not_paired` (no credential, or the machine refused it).

**Fallback.** While `unreachable` or `not_paired`, and on any device that doesn't hold the agent
(another device runs it), the daemon serves the agent read-only from the synced sidecar: threads
(conflict copies merged), approvals, task records and artifacts, parsed with the contract's
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
| `src/main.ts` | Entry: start, banner, signal handling. |
| `src/server.ts` | Composition root and ordered shutdown. |
| `src/wiring.ts` | Creates storage, connectors, execution, LLM client, runtime and sync. |
| `src/config.ts`, `env-file.ts`, `token.ts` | Configuration, env files, bearer token. |
| `src/app.ts`, `security.ts`, `errors.ts` | Hono app, Host/Origin/token guard, error mapping. |
| `src/routes/*` | REST routes and the static web app. |
| `src/ws.ts`, `vault-events.ts`, `write-tracker.ts` | WebSocket hub and change attribution. |
| `src/settings-store.ts`, `settings-schema.ts`, `obsidian-import.ts` | Vault-backed settings. |
| `src/null-runtime.ts`, `null-execution.ts` | Fallbacks when agents are unavailable (routine files stay editable through `@ddl/agent/routines`). |
| `src/sidecar-view.ts` | The agent's work read-only from the synced sidecar, for a device that doesn't run it. |
| `src/sync-setup.ts` | Sync service target: device identity, token, lease client. |
| `src/agent-lease.ts`, `leased-runtime.ts` | The agent lease, and the runtime that exists only while holding it. |
| `src/placement-lease.ts` | Asks for the lease only while the agent may run here (never while relaying). |
| `src/relay/*` | The agent relay: allowlist, calls to the machine, its WebSocket link, the relaying runtime. |
| `build.mjs` | esbuild bundle (workspace packages inlined, third-party dependencies external). |

Tests are colocated (`*.test.ts`). They use in-memory vaults and temp directories and never touch the
real home directory or the network.
