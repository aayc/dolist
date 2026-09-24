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
| `OPENROUTER_API_KEY` | — | Required for `live` agents. Without it the agent reports a problem; notes keep working. |

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

- `sync`: `{ "kind": "none" }`, `{ "kind": "local", "root": "~/Library/Mobile Documents/…" }` or
  `{ "kind": "s3", "bucket": "…", "prefix": "…", "region": "…" }`.
- `execution`: `local` (browser headless by default; computer use defaults to on for macOS only) or
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
| GET | `/api/threads[?notePath=&taskId=]` | → `ThreadListResponse` |
| GET | `/api/threads/<id>` | → `ThreadResponse` |
| POST | `/api/threads/<id>/messages` | `PostMessageRequest` → `{ ok: true }` |
| POST | `/api/threads/<id>/cancel` | → `{ ok: true }` |
| POST | `/api/threads/<id>/retry` | → `{ ok: true }` |
| GET | `/api/approvals[?status=pending]` | → `ApprovalListResponse` |
| GET | `/api/approvals/<id>` | → `{ approval }` |
| POST | `/api/approvals/<id>` | `ApprovalDecisionRequest` → `{ approval }` (404 unknown, 409 already decided with `approval`) |
| GET | `/api/artifacts/<threadId>/<artifactId>[?download=1]` | → artifact bytes |
| GET | `/api/connectors` | → `{ connectors: ConnectorStatus[] }` |

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
| `thread.upsert` / `thread.message` / `thread.delta` | Thread summaries, messages, streamed text. |
| `approval.upsert` | An approval was created or decided. |
| `agent.status` | `AgentStatusResponse` changed. |
| `surface.frame` | Live browser/computer frame, only to clients subscribed to that thread's surface. |
| `settings.changed` | Settings were saved. |
| `error` | A client message was rejected. |

Client → server (`ClientEvent`): `hello { clientId }`, `ping`, `surface.subscribe` /
`surface.unsubscribe { threadId, surface }` (the runtime streams a surface only while at least one
client is subscribed), `thread.read { threadId }`, and `editor.activity { notePath, line }` (so the
orchestrator never acts on a half-typed task).

The server pings every 30 s and drops clients that do not answer. Under backpressure (more than
1 MB buffered) `surface.frame` and `thread.delta` are skipped for that client; the final
`thread.message` carries the full text. A client with more than 16 MB buffered is disconnected and
must reconnect and resync.

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
| `src/null-runtime.ts`, `null-execution.ts` | Fallbacks when agents are unavailable. |
| `build.mjs` | esbuild bundle (workspace packages inlined, third-party dependencies external). |

Tests are colocated (`*.test.ts`). They use in-memory vaults and temp directories and never touch the
real home directory or the network.
