# Daemon protocol

How clients (the web UI today; the macOS/iOS shells and a native iPhone app later) talk to the
daemon. The TypeScript types live in `packages/core/src/protocol.ts` and `agent-types.ts`; the
runtime schemas, route table, test arbitraries and fixtures live in `@ddl/contract`
(`packages/contract`). Everything below the "Reference" heading is generated from the contract.

## Transport and auth

- **REST/JSON** under `/api/*` on `http://127.0.0.1:<port>` (default 7331). Request bodies are
  JSON (`Content-Type: application/json`), at most 5 MB.
- **WebSocket** at `/ws`: the server pushes `ServerEvent`s; the client sends small `ClientEvent`s.
  All messages are JSON text frames (binary frames are rejected).
- **Auth**: every `/api/*` request carries `Authorization: Bearer <token>`; the WebSocket passes
  the token as `?token=`. The daemon only binds to loopback and rejects foreign `Host` headers
  (DNS rebinding) and unknown `Origin` headers (CSRF). Requests without an `Origin` (native
  clients) are fine. Rejected WebSocket upgrades answer a bare HTTP 401/403/404.
- `X-DDL-Client-Id: <clientId>` on writes lets the daemon attribute the change; the resulting
  `vault.changed` event carries that `clientId` so the writer can ignore its own echo.

## Versioning and the handshake

`API_VERSION` is an integer that changes only for **breaking** changes. A client and a daemon
interoperate exactly when their API versions are equal; within a version every change is
additive (see "Compatibility rules" in `packages/contract/README.md`).

1. `GET /api/health` returns `apiVersion` (and the daemon build `version`): check it before
   anything else.
2. On `/ws`, the server's first event is `{"type":"hello","serverVersion","apiVersion"}`.
3. The client's first message is `{"type":"hello","clientId","apiVersion","clientVersion"}`.
   `apiVersion` is optional for clients that predate the handshake (treated as 1).
4. On a mismatch the daemon sends `{"type":"error","code":"incompatible_api_version"}` and
   closes with code **4426**; clients should stop reconnecting and ask the user to update
   whichever side is older. A client that sees an incompatible `hello.apiVersion` should do the
   same without waiting for the close.

## Strict requests, tolerant responses

- **Requests** (REST bodies and client events) are strict: unknown keys are rejected with
  400 `invalid_request` (or a WebSocket `error` event). This catches typos and never silently
  drops a setting. Query strings are the exception: unknown parameters are ignored.
- **Responses and server events** are tolerant: a newer daemon may add keys, and clients must
  ignore keys they don't know. Clients must also ignore server event `type`s they don't know.
- Error responses always have the `ApiErrorBody` shape (`{"error": code, "message"?}`); treat an
  unknown `error` code like any failure with that HTTP status.

## Conventions

- **Identifiers** are non-empty strings of at most 200 characters. Ids clients put in URLs
  (threads, approvals, artifacts) match `^[A-Za-z0-9_.:-]{1,200}$`.
- **Timestamps** are epoch milliseconds (non-negative safe integers).
- **Paths** are vault-relative POSIX paths without leading `/`, `.`/`..` segments or trailing
  slashes (`Daily/2026-09-23.md`). In URLs each segment is percent-encoded
  (`/api/notes/Daily/Sept%20notes%20%231.md`). Hidden paths (dot-files, `.obsidian`, the agent
  sidecar `.daily-do-list/`) are never accessible through the API.
- **Dates** are local calendar dates `YYYY-MM-DD` (never UTC); `today` in `/api/daily/today`
  is the daemon's local date.
- **Lines** are 0-based.
- **Deletes are soft**: notes and folders move into the vault's `.trash/`.
- **Optimistic concurrency**: send the `version` you edited from as `baseVersion`; `null` means
  "create only". A stale version answers 409 with the current note.

## Event stream semantics

- Events are best-effort: `thread.delta` and `surface.frame` may be dropped for slow clients
  (the final `thread.message` repairs text), and a client that falls far behind is disconnected.
  After a reconnect, refetch what you display (tree, open notes, records, threads, approvals).
- `thread.message` with an existing message `id` replaces that message (tool calls and streaming
  text are updated in place).
- `surface.frame` events only flow to clients that sent `surface.subscribe` for that thread and
  surface; subscriptions must be re-sent after a reconnect.

## Changing the protocol

Follow "How to add a route or event" in `packages/contract/README.md`: update the core type, the
schema, the route table and the fixtures, then run `pnpm --filter @ddl/contract generate` to
refresh `packages/contract/schema/*.json` and the reference below. Tests fail while any of these
disagree.

<!-- BEGIN GENERATED REFERENCE (pnpm --filter @ddl/contract generate); edits below are overwritten -->

## Reference

API version: **1**. Machine-readable: `packages/contract/schema/wire.schema.json` (every schema) and `packages/contract/schema/routes.json` (every route).

### REST routes

| Route | Method | Path | Body | Success |
| --- | --- | --- | --- | --- |
| `health` | GET | `/api/health` | — | 200 [`HealthResponse`](#healthresponse) |
| `tree` | GET | `/api/vault/tree` | — | 200 [`VaultTreeResponse`](#vaulttreeresponse) |
| `note` | GET | `/api/notes/*` | — | 200 [`NoteResponse`](#noteresponse) |
| `note` | PUT | `/api/notes/*` | [`WriteNoteRequest`](#writenoterequest) | 200 [`WriteNoteResponse`](#writenoteresponse), 201 [`WriteNoteResponse`](#writenoteresponse) |
| `note` | DELETE | `/api/notes/*` | — | 200 [`TrashResponse`](#trashresponse) |
| `rename` | POST | `/api/notes-rename` | [`RenameRequest`](#renamerequest) | 200 [`RenameResponse`](#renameresponse) |
| `folders` | POST | `/api/folders` | [`CreateFolderRequest`](#createfolderrequest) | 201 [`CreateFolderResponse`](#createfolderresponse) |
| `folders` | DELETE | `/api/folders` | — | 200 [`TrashResponse`](#trashresponse) |
| `daily` | GET | `/api/daily/:date` | — | 200 [`DailyNoteResponse`](#dailynoteresponse) |
| `search` | GET | `/api/search` | — | 200 [`SearchResponse`](#searchresponse) |
| `settings` | GET | `/api/settings` | — | 200 [`SettingsResponse`](#settingsresponse) |
| `settings` | PUT | `/api/settings` | [`UpdateSettingsRequest`](#updatesettingsrequest) | 200 [`SettingsResponse`](#settingsresponse) |
| `settings` | PATCH | `/api/settings` | [`UpdateSettingsRequest`](#updatesettingsrequest) | 200 [`SettingsResponse`](#settingsresponse) |
| `agentStatus` | GET | `/api/agent/status` | — | 200 [`AgentStatusResponse`](#agentstatusresponse) |
| `agentEnabled` | PUT | `/api/agent/enabled` | [`SetAgentEnabledRequest`](#setagentenabledrequest) | 200 [`AgentStatusResponse`](#agentstatusresponse) |
| `agentEnabled` | POST | `/api/agent/enabled` | [`SetAgentEnabledRequest`](#setagentenabledrequest) | 200 [`AgentStatusResponse`](#agentstatusresponse) |
| `tasks` | GET | `/api/tasks` | — | 200 [`TaskRecordsResponse`](#taskrecordsresponse) |
| `threads` | GET | `/api/threads` | — | 200 [`ThreadListResponse`](#threadlistresponse) |
| `thread` | GET | `/api/threads/:id` | — | 200 [`ThreadResponse`](#threadresponse) |
| `threadMessages` | POST | `/api/threads/:id/messages` | [`PostMessageRequest`](#postmessagerequest) | 200 [`ThreadActionResponse`](#threadactionresponse), 202 [`ThreadActionResponse`](#threadactionresponse) |
| `threadCancel` | POST | `/api/threads/:id/cancel` | — | 200 [`ThreadActionResponse`](#threadactionresponse), 202 [`ThreadActionResponse`](#threadactionresponse) |
| `threadRetry` | POST | `/api/threads/:id/retry` | — | 200 [`ThreadActionResponse`](#threadactionresponse), 202 [`ThreadActionResponse`](#threadactionresponse) |
| `approvals` | GET | `/api/approvals` | — | 200 [`ApprovalListResponse`](#approvallistresponse) |
| `approval` | GET | `/api/approvals/:id` | — | 200 [`ApprovalResponse`](#approvalresponse) |
| `approval` | POST | `/api/approvals/:id` | [`ApprovalDecisionRequest`](#approvaldecisionrequest) | 200 [`ApprovalResponse`](#approvalresponse) |
| `artifact` | GET | `/api/artifacts/:threadId/:artifactId` | — | 200 bytes |
| `connectors` | GET | `/api/connectors` | — | 200 [`ConnectorsResponse`](#connectorsresponse) |
| `ws` | GET | `/ws` | — | — |

Every `/api/*` route can also answer 401 (`unauthorized`), 403 (`forbidden_host`, `forbidden_origin`), 500 (`internal_error`). Methods a route doesn't list answer 404 `not_found`.

#### `health` — `/api/health`

**GET** — Liveness, daemon and API versions.

- Responses:
  - `200` [`HealthResponse`](#healthresponse) — Healthy.

#### `tree` — `/api/vault/tree`

**GET** — Every visible file and folder.

- Responses:
  - `200` [`VaultTreeResponse`](#vaulttreeresponse) — The vault tree.

#### `note` — `/api/notes/*`

- Path parameter `path`: string (1–1024 chars) — Vault path of a text note, each segment percent-encoded.

**GET** — Read a note.

- Responses:
  - `200` [`NoteResponse`](#noteresponse) — The note.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_path` — Malformed, hidden or non-text path.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — No such note.

**PUT** — Create or overwrite a note (optimistic concurrency via `baseVersion`).

- Body: [`WriteNoteRequest`](#writenoterequest)
- Responses:
  - `200` [`WriteNoteResponse`](#writenoteresponse) — Overwritten.
  - `201` [`WriteNoteResponse`](#writenoteresponse) — Created.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request`, `invalid_path` — Malformed JSON or failed validation.
  - `409` [`ConflictResponse`](#conflictresponse) `conflict` — `baseVersion` is stale (or `null` and the note exists).
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.

**DELETE** — Move a note to `.trash/`.

- Responses:
  - `200` [`TrashResponse`](#trashresponse) — Moved to the trash.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_path` — Malformed, hidden or non-text path.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — No such note.

#### `rename` — `/api/notes-rename`

**POST** — Rename or move a note, or a folder with its contents.

- Body: [`RenameRequest`](#renamerequest)
- Responses:
  - `200` [`RenameResponse`](#renameresponse) — Renamed.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request`, `invalid_path` — Malformed JSON or failed validation.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — The source doesn't exist.
  - `409` see `routes.json` `conflict` — The target exists (a note conflict carries the existing note).
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.

#### `folders` — `/api/folders`

**POST** — Create a folder (and its parents).

- Body: [`CreateFolderRequest`](#createfolderrequest)
- Responses:
  - `201` [`CreateFolderResponse`](#createfolderresponse) — Created (or already there).
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request`, `invalid_path` — Malformed JSON or failed validation.
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.

**DELETE** — Move a folder and everything in it to `.trash/`.

- Query `path`: Folder path.
- Responses:
  - `200` [`TrashResponse`](#trashresponse) — Moved to the trash.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request`, `invalid_path` — Missing, malformed or hidden path.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — No such folder.

#### `daily` — `/api/daily/:date`

- Path parameter `date`: `"today"` | string (date) — `today` (the daemon's local date) or YYYY-MM-DD.

**GET** — Read a daily note; with `?create=1`, create it from the template if missing.

- Query `create`: `1`, `true` or `yes` = on; anything else = off.
- Responses:
  - `200` [`DailyNoteResponse`](#dailynoteresponse) — The daily note (`created` tells whether it's new).
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request`, `invalid_settings` — Bad date or unusable settings.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Missing and `create` was not requested.

#### `search` — `/api/search`

**GET** — Search note names and contents.

- Query `q`: Query; blank = no hits.
- Query `limit`: Maximum hits (default 50, capped at 200).
- Responses:
  - `200` [`SearchResponse`](#searchresponse) — Hits, best first.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request` — Query too long or bad limit.

#### `settings` — `/api/settings`

**GET** — The effective settings.

- Responses:
  - `200` [`SettingsResponse`](#settingsresponse) — Settings.

**PUT** — Apply a deep-partial settings patch.

- Body: [`UpdateSettingsRequest`](#updatesettingsrequest)
- Responses:
  - `200` [`SettingsResponse`](#settingsresponse) — The new effective settings.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request` — Malformed JSON or failed validation.
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.

**PATCH** — Alias of PUT.

- Body: [`UpdateSettingsRequest`](#updatesettingsrequest)
- Responses:
  - `200` [`SettingsResponse`](#settingsresponse) — The new effective settings.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request` — Malformed JSON or failed validation.
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.

#### `agentStatus` — `/api/agent/status`

**GET** — The agent runtime's state.

- Responses:
  - `200` [`AgentStatusResponse`](#agentstatusresponse) — Status.

#### `agentEnabled` — `/api/agent/enabled`

**PUT** — Pause or resume the agent (persisted as `agent.enabled`).

- Body: [`SetAgentEnabledRequest`](#setagentenabledrequest)
- Responses:
  - `200` [`AgentStatusResponse`](#agentstatusresponse) — The resulting status.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request` — Malformed JSON or failed validation.
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.

**POST** — Alias of PUT.

- Body: [`SetAgentEnabledRequest`](#setagentenabledrequest)
- Responses:
  - `200` [`AgentStatusResponse`](#agentstatusresponse) — The resulting status.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request` — Malformed JSON or failed validation.
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.

#### `tasks` — `/api/tasks`

**GET** — Agent records of a note's tasks.

- Query `notePath`: The note.
- Responses:
  - `200` [`TaskRecordsResponse`](#taskrecordsresponse) — Records.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request`, `invalid_path` — Missing or invalid note path.

#### `threads` — `/api/threads`

**GET** — Thread summaries, optionally filtered by note or task (empty = no filter).

- Query `notePath`
- Query `taskId`
- Responses:
  - `200` [`ThreadListResponse`](#threadlistresponse) — Summaries.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request`, `invalid_path` — Invalid filter.

#### `thread` — `/api/threads/:id`

- Path parameter `id`: string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) — Runtime id, safe to use in URLs.

**GET** — A full thread with its approvals.

- Responses:
  - `200` [`ThreadResponse`](#threadresponse) — The thread.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request` — Invalid thread id.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Unknown thread.

#### `threadMessages` — `/api/threads/:id/messages`

- Path parameter `id`: any JSON

**POST** — Reply in a thread (steers a running subagent or resumes a finished one).

- Body: [`PostMessageRequest`](#postmessagerequest)
- Responses:
  - `200` [`ThreadActionResponse`](#threadactionresponse) — The runtime finished the action.
  - `202` [`ThreadActionResponse`](#threadactionresponse) — Still running in the background (`pending: true`).
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request` — Malformed JSON or failed validation.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Unknown thread.
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.
  - `500` [`ApiErrorBody`](#apierrorbody) `agent_error`, `internal_error` — The runtime failed the action.
  - `503` [`ApiErrorBody`](#apierrorbody) `agent_unavailable` — The agent can't act right now.

#### `threadCancel` — `/api/threads/:id/cancel`

- Path parameter `id`: any JSON

**POST** — Stop the task's agent.

- Responses:
  - `200` [`ThreadActionResponse`](#threadactionresponse) — The runtime finished the action.
  - `202` [`ThreadActionResponse`](#threadactionresponse) — Still running in the background (`pending: true`).
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request` — Invalid thread id.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Unknown thread.
  - `500` [`ApiErrorBody`](#apierrorbody) `agent_error`, `internal_error` — The runtime failed the action.
  - `503` [`ApiErrorBody`](#apierrorbody) `agent_unavailable` — The agent can't act right now.

#### `threadRetry` — `/api/threads/:id/retry`

- Path parameter `id`: any JSON

**POST** — Run the task again.

- Responses:
  - `200` [`ThreadActionResponse`](#threadactionresponse) — The runtime finished the action.
  - `202` [`ThreadActionResponse`](#threadactionresponse) — Still running in the background (`pending: true`).
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request` — Invalid thread id.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Unknown thread.
  - `500` [`ApiErrorBody`](#apierrorbody) `agent_error`, `internal_error` — The runtime failed the action.
  - `503` [`ApiErrorBody`](#apierrorbody) `agent_unavailable` — The agent can't act right now.

#### `approvals` — `/api/approvals`

**GET** — Approval requests, optionally by status.

- Query `status`
- Responses:
  - `200` [`ApprovalListResponse`](#approvallistresponse) — Approvals.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request` — Unknown status.

#### `approval` — `/api/approvals/:id`

- Path parameter `id`: string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) — Runtime id, safe to use in URLs.

**GET** — One approval request.

- Responses:
  - `200` [`ApprovalResponse`](#approvalresponse) — The approval.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request` — Invalid approval id.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Unknown approval.

**POST** — Approve or deny a pending request.

- Body: [`ApprovalDecisionRequest`](#approvaldecisionrequest)
- Responses:
  - `200` [`ApprovalResponse`](#approvalresponse) — The decided approval.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request` — Malformed JSON or failed validation.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Unknown approval.
  - `409` [`ApprovalConflictResponse`](#approvalconflictresponse) `conflict` — Already decided, expired or cancelled (carries its current state).
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.
  - `500` [`ApiErrorBody`](#apierrorbody) `agent_error`, `internal_error` — The runtime failed to record it.
  - `503` [`ApiErrorBody`](#apierrorbody) `agent_unavailable` — The approval system is unavailable.

#### `artifact` — `/api/artifacts/:threadId/:artifactId`

- Path parameter `threadId`: string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) — Runtime id, safe to use in URLs.
- Path parameter `artifactId`: string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) — Runtime id, safe to use in URLs.

**GET** — Artifact bytes, sandboxed (`Content-Security-Policy: sandbox`, nosniff).

- Query `download`: `1`, `true` or `yes` = on; anything else = off.
- Responses:
  - `200` bytes — The bytes with the artifact's type; active content (HTML, SVG, PDF…) is always an attachment.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request` — Invalid id.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Unknown artifact.

#### `connectors` — `/api/connectors`

**GET** — MCP connector states.

- Responses:
  - `200` [`ConnectorsResponse`](#connectorsresponse) — Connectors.

#### `ws` — `/ws`

**GET** — WebSocket upgrade (`?token=`). Rejected upgrades answer 401/403/404 with an empty body.

- Query `token`: The bearer token.
- Responses:
  - `403` [`ApiErrorBody`](#apierrorbody) `forbidden_host` — Foreign Host header.
  - `426` [`ApiErrorBody`](#apierrorbody) `upgrade_required` — Plain HTTP request without a WebSocket upgrade.

### Error codes

| Code | Meaning |
| --- | --- |
| `invalid_json` | The body is not JSON. |
| `invalid_request` | Body, query or route parameter failed validation (the message says which). |
| `invalid_path` | A vault path is malformed, hidden (dot-files, the sidecar) or not a text note. |
| `invalid_settings` | The stored settings make the request impossible. |
| `unauthorized` | Missing or wrong bearer token. |
| `forbidden_host` | The Host header is not a loopback address of this daemon (DNS rebinding). |
| `forbidden_origin` | The Origin header is not allowed (CSRF). |
| `not_found` | Unknown route (or method), or the addressed item doesn't exist. |
| `conflict` | Stale `baseVersion`, existing target, or an approval that is no longer pending. |
| `payload_too_large` | Request body over 5 MB. |
| `upgrade_required` | `/ws` requested without a WebSocket upgrade. |
| `http_error` | Raised by the HTTP framework itself. |
| `agent_error` | An agent action failed unexpectedly. |
| `internal_error` | Unexpected daemon failure. |
| `agent_unavailable` | The agent can't act right now (mode off, missing API key, safety system down). |

### WebSocket `/ws`

Server → client ([`ServerEvent`](#serverevent)); clients ignore types they don't know:

| `type` | Schema | Description |
| --- | --- | --- |
| `hello` | [`ServerHelloEvent`](#serverhelloevent) | First event on every connection. |
| `vault.changed` | [`VaultChangedEvent`](#vaultchangedevent) | Vault paths changed (coalesced). Clients skip batches carrying their own `clientId`. |
| `task.records` | [`TaskRecordsEvent`](#taskrecordsevent) | Snapshot of a note's task records. |
| `task.record` | [`TaskRecordEvent`](#taskrecordevent) | One task record changed. |
| `thread.upsert` | [`ThreadUpsertEvent`](#threadupsertevent) | A thread was created or its summary changed. |
| `thread.message` | [`ThreadMessageEvent`](#threadmessageevent) | A message was added or replaced (same `id`) in a thread. |
| `thread.delta` | [`ThreadDeltaEvent`](#threaddeltaevent) | Streaming text appended to a `streaming` text message (droppable; the final message repairs gaps). |
| `approval.upsert` | [`ApprovalUpsertEvent`](#approvalupsertevent) | An approval request was created or decided. |
| `agent.status` | [`AgentStatusEvent`](#agentstatusevent) | The agent status changed. |
| `surface.frame` | [`SurfaceFrameEvent`](#surfaceframeevent) | A live surface frame; only sent to clients subscribed to that thread's surface (droppable). |
| `settings.changed` | [`SettingsChangedEvent`](#settingschangedevent) | The effective settings changed. |
| `error` | [`ServerErrorEvent`](#servererrorevent) | Something the client sent was rejected (or the connection is about to close). |

Client → server ([`ClientEvent`](#clientevent)); anything else is answered with an `error` event:

| `type` | Schema | Description |
| --- | --- | --- |
| `hello` | [`ClientHelloEvent`](#clienthelloevent) | First message a client sends: its id and the API version it speaks. |
| `ping` | [`ClientPingEvent`](#clientpingevent) | Keep-alive. |
| `surface.subscribe` | [`SurfaceSubscribeEvent`](#surfacesubscribeevent) | Start receiving `surface.frame` events for a thread's surface. |
| `surface.unsubscribe` | [`SurfaceUnsubscribeEvent`](#surfaceunsubscribeevent) | Stop receiving frames for a thread's surface. |
| `thread.read` | [`ThreadReadEvent`](#threadreadevent) | The user has seen a thread (clears its unread count). |
| `editor.activity` | [`EditorActivityEvent`](#editoractivityevent) | Where the user is typing, so the orchestrator never jumps on a half-written task. |

### Schemas

#### TaskAgentStatus

Lifecycle of the agent's work on one to-do item (drives the badge next to the task).

Type: `"idle"` | `"triaging"` | `"queued"` | `"working"` | `"waiting_approval"` | `"waiting_user"` | `"done"` | `"failed"` | `"cancelled"` | `"ignored"`

#### TaskAgentRecord

Everything a client needs to render the agent badge for one task line.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `taskId` | string (1–200 chars) | yes | Identifier. |
| `notePath` | string (1–4096 chars) | yes | Canonical vault-relative path (no leading `/`, `.`/`..` or empty segments). |
| `date` | string (date) \| `null` | yes | Local ISO date when the note is a daily note. |
| `text` | string | yes | Latest task text. |
| `line` | integer (≥ 0) | yes | Last known 0-based line. |
| `status` | [`TaskAgentStatus`](#taskagentstatus) | yes |  |
| `summary` | string | no | One-line status shown inline in the editor. |
| `threadId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) \| `null` | yes |  |
| `updatedAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `unread` | integer (≥ 0) | yes | Agent messages the user has not seen yet. |

_Tolerant: clients must ignore keys they don't know._

#### RiskLevel

Safety evaluator's risk estimate for an action.

Type: `"low"` | `"medium"` | `"high"` | `"critical"`

#### ActionCategory

Coarse effect category used by the safety evaluator and shown on approval cards.

Type: `"read"` | `"compute"` | `"network"` | `"file_write"` | `"browser_input"` | `"form_submission"` | `"computer_control"` | `"communication"` | `"publishing"` | `"payment"` | `"booking"` | `"account"` | `"credentials"` | `"privacy"` | `"destructive"` | `"system"` | `"unknown"`

#### ApprovalScope

How far an approval reaches: this call, the rest of this task, or always.

Type: `"once"` | `"task"` | `"always"`

#### ApprovalDecision

The user's answer to an approval request.

Type: `"approve"` | `"deny"`

#### ApprovalStatus

Lifecycle of an approval request.

Type: `"pending"` | `"approved"` | `"denied"` | `"expired"` | `"cancelled"`

#### ApprovalRequest

A risky action paused by the safety gate until the user decides.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `threadId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) \| `null` | yes |  |
| `taskId` | string (1–200 chars) \| `null` | yes |  |
| `toolName` | string (1–200 chars) | yes | Tool name, e.g. `browser_click`. |
| `toolLabel` | string | no |  |
| `input` | any JSON | yes | Tool arguments exactly as the agent proposed them. |
| `summary` | string | yes | Human-readable description of the action. |
| `risk` | [`RiskLevel`](#risklevel) | yes |  |
| `categories` | [`ActionCategory`](#actioncategory)[] | yes |  |
| `reason` | string | yes | Why the safety evaluator wants a human in the loop. |
| `status` | [`ApprovalStatus`](#approvalstatus) | yes |  |
| `scope` | [`ApprovalScope`](#approvalscope) | no | Scope the user granted when approving. |
| `decisionNote` | string | no |  |
| `createdAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `decidedAt` | integer (≥ 0) | no | Epoch milliseconds. |
| `expiresAt` | integer (≥ 0) | no | Epoch milliseconds. |

_Tolerant: clients must ignore keys they don't know._

#### ArtifactKind

How a client should render an artifact.

Type: `"markdown"` | `"code"` | `"html"` | `"image"` | `"json"` | `"text"` | `"file"`

#### ArtifactMeta

An agent-produced file attached to a thread (bytes via `GET /api/artifacts/:threadId/:artifactId`).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `threadId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `title` | string | yes |  |
| `kind` | [`ArtifactKind`](#artifactkind) | yes |  |
| `mimeType` | string (1–255 chars) | yes |  |
| `language` | string (≤ 100 chars) | no | Code language hint for `code` artifacts. |
| `path` | string (1–4096 chars) | yes | Vault-relative sidecar path of the artifact body. |
| `size` | integer (≥ 0) | yes |  |
| `createdAt` | integer (≥ 0) | yes | Epoch milliseconds. |

_Tolerant: clients must ignore keys they don't know._

#### MessageAuthor

Who wrote a thread message: `you`, `orchestrator`, `system` or `subagent:<name>`.

Type: `"you"` | `"orchestrator"` | `"system"` | string (`^subagent:[\s\S]{1,100}$`)

#### TextMessage

Markdown text from the agent, the user or the system.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (1–200 chars) | yes | Identifier. |
| `author` | [`MessageAuthor`](#messageauthor) | yes |  |
| `createdAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `kind` | `"text"` | yes |  |
| `role` | `"agent"` \| `"user"` \| `"system"` | yes |  |
| `text` | string | yes |  |
| `streaming` | boolean | no | True while tokens are still streaming in (see `thread.delta`). |

_Tolerant: clients must ignore keys they don't know._

#### ToolCallStatus

`blocked`: the safety gate refused the call.

Type: `"running"` | `"ok"` | `"error"` | `"blocked"`

#### ToolCallMessage

A tool call made by an agent, updated in place as it runs.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (1–200 chars) | yes | Identifier. |
| `author` | [`MessageAuthor`](#messageauthor) | yes |  |
| `createdAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `kind` | `"tool_call"` | yes |  |
| `toolCallId` | string (1–200 chars) | yes | Identifier. |
| `toolName` | string (1–200 chars) | yes | Tool name, e.g. `browser_click`. |
| `label` | string | no |  |
| `input` | any JSON | yes |  |
| `status` | [`ToolCallStatus`](#toolcallstatus) | yes |  |
| `resultPreview` | string | no | Short, UI-safe preview of the result. |
| `endedAt` | integer (≥ 0) | no | Epoch milliseconds. |

_Tolerant: clients must ignore keys they don't know._

#### ApprovalMessage

Marks where in the thread an approval was requested.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (1–200 chars) | yes | Identifier. |
| `author` | [`MessageAuthor`](#messageauthor) | yes |  |
| `createdAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `kind` | `"approval"` | yes |  |
| `approvalId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |

_Tolerant: clients must ignore keys they don't know._

#### ArtifactMessage

Marks where in the thread an artifact was created.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (1–200 chars) | yes | Identifier. |
| `author` | [`MessageAuthor`](#messageauthor) | yes |  |
| `createdAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `kind` | `"artifact"` | yes |  |
| `artifactId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |

_Tolerant: clients must ignore keys they don't know._

#### StatusMessage

A task status change, with an optional note.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (1–200 chars) | yes | Identifier. |
| `author` | [`MessageAuthor`](#messageauthor) | yes |  |
| `createdAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `kind` | `"status"` | yes |  |
| `status` | [`TaskAgentStatus`](#taskagentstatus) | yes |  |
| `text` | string | no |  |

_Tolerant: clients must ignore keys they don't know._

#### ThreadMessage

One entry of a task thread, discriminated by `kind`.

Type: [`TextMessage`](#textmessage) | [`ToolCallMessage`](#toolcallmessage) | [`ApprovalMessage`](#approvalmessage) | [`ArtifactMessage`](#artifactmessage) | [`StatusMessage`](#statusmessage)

#### SurfaceKind

A live visual surface a thread can expose.

Type: `"browser"` | `"computer"`

#### Thread

A task's full conversation: messages, artifacts and live surfaces.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `taskId` | string (1–200 chars) \| `null` | yes |  |
| `notePath` | string (1–4096 chars) \| `null` | yes |  |
| `title` | string | yes | Task text snapshot (kept in sync as the task is edited). |
| `status` | [`TaskAgentStatus`](#taskagentstatus) | yes |  |
| `createdAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `updatedAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `surfaces` | [`SurfaceKind`](#surfacekind)[] | yes |  |
| `messages` | [`ThreadMessage`](#threadmessage)[] | yes |  |
| `artifacts` | [`ArtifactMeta`](#artifactmeta)[] | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ThreadSummary

A thread without its messages, for lists and badges.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `taskId` | string (1–200 chars) \| `null` | yes |  |
| `notePath` | string (1–4096 chars) \| `null` | yes |  |
| `title` | string | yes | Task text snapshot (kept in sync as the task is edited). |
| `status` | [`TaskAgentStatus`](#taskagentstatus) | yes |  |
| `createdAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `updatedAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `surfaces` | [`SurfaceKind`](#surfacekind)[] | yes |  |
| `messageCount` | integer (≥ 0) | yes |  |
| `lastMessagePreview` | string | no |  |
| `artifactCount` | integer (≥ 0) | yes |  |
| `pendingApprovals` | integer (≥ 0) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### SurfaceFrameAction

The action that produced a frame, for overlays (x/y in frame pixels).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | string (1–100 chars) | yes |  |
| `x` | number | no |  |
| `y` | number | no |  |
| `text` | string | no |  |

_Tolerant: clients must ignore keys they don't know._

#### SurfaceFrame

One frame of a live surface (browser screencast or desktop screenshot).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `threadId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `surface` | [`SurfaceKind`](#surfacekind) | yes |  |
| `mimeType` | `"image/jpeg"` \| `"image/png"` | yes |  |
| `data` | string (base64, ≥ 1 chars) | yes | Base64-encoded image bytes. |
| `width` | integer (1–16384) | yes |  |
| `height` | integer (1–16384) | yes |  |
| `url` | string | no | Browser only. |
| `title` | string | no | Browser only. |
| `action` | [`SurfaceFrameAction`](#surfaceframeaction) | no |  |
| `ts` | integer (≥ 0) | yes | Epoch milliseconds. |

_Tolerant: clients must ignore keys they don't know._

#### ThemePreference

UI theme.

Type: `"system"` | `"light"` | `"dark"`

#### EditorSettings

Editor preferences.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `vimMode` | boolean | yes |  |
| `vimrc` | string (≤ 16384 chars) | yes | Vim startup ex commands, one per line; lines starting with `"` are comments. |
| `livePreview` | boolean | yes | Obsidian-style live preview. |
| `readableLineLength` | boolean | yes |  |
| `fontSize` | number (8–48) | yes |  |
| `spellcheck` | boolean | yes |  |
| `showLineNumbers` | boolean | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### DailyNoteSettings

Where daily notes live (mirrors Obsidian's daily-notes config).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `folder` | string (≤ 512 chars) | yes | Vault folder for the notes; empty = vault root. |
| `format` | string (≤ 128 chars) | yes | Moment-style file name format; may contain `/` for nested folders. |
| `template` | string (≤ 512 chars) | yes | Template note path; empty = no template. |

_Tolerant: clients must ignore keys they don't know._

#### WeeklyNoteSettings

Where weekly notes live.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `folder` | string (≤ 512 chars) | yes | Vault folder for the notes; empty = vault root. |
| `format` | string (≤ 128 chars) | yes | Moment-style file name format; may contain `/` for nested folders. |
| `template` | string (≤ 512 chars) | yes | Template note path; empty = no template. |

_Tolerant: clients must ignore keys they don't know._

#### AgentWatchWindow

Days around today whose daily notes the orchestrator watches.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pastDays` | integer (0–366) | yes |  |
| `futureDays` | integer (0–366) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### AgentSettings

Orchestrator and subagent settings.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | yes | Master switch: when false the orchestrator ignores note changes. |
| `settleMs` | integer (0–120000) | yes | Quiet period after the last edit to a task before the orchestrator looks at it. |
| `maxConcurrentSubagents` | integer (1–32) | yes |  |
| `actOnExistingTasks` | boolean | yes |  |
| `approvalTimeoutMs` | integer (60000–2592000000) | yes | How long an approval request waits before it is auto-denied. |
| `model` | string (`^\S(?:[\s\S]*\S)?$`, 1–200 chars) | yes | OpenRouter model id for the orchestrator and subagents. |
| `judgeModel` | string (`^\S(?:[\s\S]*\S)?$`, 1–200 chars) | yes | OpenRouter model id for the safety judge. |
| `watch` | [`AgentWatchWindow`](#agentwatchwindow) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### AppSettings

All user settings (stored in the vault sidecar so they travel with the vault).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `theme` | [`ThemePreference`](#themepreference) | yes |  |
| `editor` | [`EditorSettings`](#editorsettings) | yes |  |
| `dailyNotes` | [`DailyNoteSettings`](#dailynotesettings) | yes |  |
| `weeklyNotes` | [`WeeklyNoteSettings`](#weeklynotesettings) | yes |  |
| `agent` | [`AgentSettings`](#agentsettings) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### UpdateSettingsRequest

A deep partial of AppSettings (PATCH semantics). Unknown keys are rejected.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `theme` | [`ThemePreference`](#themepreference) | no |  |
| `editor` | object | no |  |
| `dailyNotes` | object | no |  |
| `weeklyNotes` | object | no |  |
| `agent` | object | no |  |

_Strict: unknown keys are rejected._

#### AgentMode

`live` (real model), `mock` (deterministic scripts) or `off`.

Type: `"live"` | `"mock"` | `"off"`

#### HealthResponse

Liveness and versions. Clients should check `apiVersion` before anything else.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ok` | `true` | yes |  |
| `version` | string (1–100 chars) | yes | Daemon build version. |
| `apiVersion` | integer (≥ 1) | yes | Protocol major version (see API_VERSION). |
| `vaultName` | string (≤ 1024 chars) | yes |  |
| `agentMode` | [`AgentMode`](#agentmode) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### VaultEntry

A visible file or folder of the vault (hidden paths are never listed).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string (1–4096 chars) | yes | Canonical vault-relative path (no leading `/`, `.`/`..` or empty segments). |
| `kind` | `"file"` \| `"folder"` | yes |  |
| `size` | integer (≥ 0) | no | Bytes (files only). |
| `mtime` | integer (≥ 0) | no | Epoch milliseconds. |
| `version` | string (1–256 chars) | no | Opaque content version. |

_Tolerant: clients must ignore keys they don't know._

#### VaultTreeResponse

Every visible file and folder of the vault.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `vaultName` | string (≤ 1024 chars) | yes |  |
| `entries` | [`VaultEntry`](#vaultentry)[] | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### NoteResponse

A note's content and version.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string (1–4096 chars) | yes | Canonical vault-relative path (no leading `/`, `.`/`..` or empty segments). |
| `content` | string | yes |  |
| `version` | string (1–256 chars) | yes | Send back as `baseVersion` for optimistic concurrency. |
| `mtime` | integer (≥ 0) | yes | Epoch milliseconds. |

_Tolerant: clients must ignore keys they don't know._

#### WriteNoteRequest

Body of `PUT /api/notes/<path>`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `content` | string (≤ 5242880 chars) | yes |  |
| `baseVersion` | string (1–256 chars) \| `null` | no | Version edited from; `null` = create only (409 if it exists); omit to overwrite. |

_Strict: unknown keys are rejected._

#### WriteNoteResponse

The written note's canonical path and new version.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string (1–4096 chars) | yes | Canonical vault-relative path (no leading `/`, `.`/`..` or empty segments). |
| `version` | string (1–256 chars) | yes | Opaque content version. |
| `mtime` | integer (≥ 0) | yes | Epoch milliseconds. |

_Tolerant: clients must ignore keys they don't know._

#### RenameRequest

Renames a note, or a folder with everything inside it when `from` is a folder.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `from` | string (1–1024 chars) | yes |  |
| `to` | string (1–1024 chars) | yes |  |

_Strict: unknown keys are rejected._

#### FolderRenameResponse

Result of renaming a folder.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string (1–4096 chars) | yes | Canonical vault-relative path (no leading `/`, `.`/`..` or empty segments). |
| `moved` | integer (≥ 0) | yes | Number of files moved. |

_Tolerant: clients must ignore keys they don't know._

#### RenameResponse

A renamed note answers like a write; a renamed folder reports how many files moved.

Type: [`WriteNoteResponse`](#writenoteresponse) | [`FolderRenameResponse`](#folderrenameresponse)

#### CreateFolderRequest

Body of `POST /api/folders`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string (1–1024 chars) | yes |  |

_Strict: unknown keys are rejected._

#### CreateFolderResponse

The created folder's canonical path.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string (1–4096 chars) | yes | Canonical vault-relative path (no leading `/`, `.`/`..` or empty segments). |

_Tolerant: clients must ignore keys they don't know._

#### TrashResponse

Deletes are soft: the note or folder moved into the vault's `.trash/` folder.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ok` | `true` | yes |  |
| `trashedTo` | string (1–4096 chars) | yes | Where it went, e.g. `.trash/Old.md`. |

_Tolerant: clients must ignore keys they don't know._

#### OkResponse

Success without data.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ok` | `true` | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ThreadActionResponse

200 when the runtime finished the action; 202 with `pending: true` when it continues in the background.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `ok` | `true` | yes |  |
| `pending` | `true` | no |  |

_Tolerant: clients must ignore keys they don't know._

#### DailyNoteResponse

A daily note, created from the template when requested.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string (1–4096 chars) | yes | Canonical vault-relative path (no leading `/`, `.`/`..` or empty segments). |
| `content` | string | yes |  |
| `version` | string (1–256 chars) | yes | Send back as `baseVersion` for optimistic concurrency. |
| `mtime` | integer (≥ 0) | yes | Epoch milliseconds. |
| `date` | string (date) | yes | Local calendar date YYYY-MM-DD. |
| `created` | boolean | yes | True when this request created the note. |

_Tolerant: clients must ignore keys they don't know._

#### SearchHit

`name`: the note's name matched (line 0); `content`: the 0-based `line` matched.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string (1–4096 chars) | yes | Canonical vault-relative path (no leading `/`, `.`/`..` or empty segments). |
| `kind` | `"name"` \| `"content"` | yes |  |
| `line` | integer (≥ 0) | yes |  |
| `preview` | string | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### SearchResponse

Search hits, best first.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `hits` | [`SearchHit`](#searchhit)[] | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### SettingsResponse

The effective settings.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `settings` | [`AppSettings`](#appsettings) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ConnectorStatus

State of one MCP connector.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string (1–200 chars) | yes |  |
| `transport` | `"stdio"` \| `"http"` \| `"sse"` | yes |  |
| `state` | `"disabled"` \| `"idle"` \| `"connecting"` \| `"connected"` \| `"error"` | yes |  |
| `toolCount` | integer (≥ 0) | yes |  |
| `error` | string | no |  |

_Tolerant: clients must ignore keys they don't know._

#### ExecutionStatus

The execution provider and what it can do.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | string (1–200 chars) | yes |  |
| `capabilities` | object | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### AgentStatusResponse

The agent runtime's state (also pushed as `agent.status`).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `mode` | [`AgentMode`](#agentmode) | yes |  |
| `enabled` | boolean | yes |  |
| `model` | string (`^\S(?:[\s\S]*\S)?$`, 1–200 chars) | yes |  |
| `running` | integer (≥ 0) | yes |  |
| `queued` | integer (≥ 0) | yes |  |
| `pendingApprovals` | integer (≥ 0) | yes |  |
| `connectors` | [`ConnectorStatus`](#connectorstatus)[] | yes |  |
| `execution` | [`ExecutionStatus`](#executionstatus) | yes |  |
| `problem` | string | no | Why the agent cannot run, when it can't. |

_Tolerant: clients must ignore keys they don't know._

#### SetAgentEnabledRequest

Body of `PUT|POST /api/agent/enabled` (persisted as `agent.enabled`).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | yes |  |

_Strict: unknown keys are rejected._

#### TaskRecordsResponse

The agent records of one note's tasks.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `records` | [`TaskAgentRecord`](#taskagentrecord)[] | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ThreadListResponse

Thread summaries.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `threads` | [`ThreadSummary`](#threadsummary)[] | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ThreadResponse

A full thread and every approval requested in it.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `thread` | [`Thread`](#thread) | yes |  |
| `approvals` | [`ApprovalRequest`](#approvalrequest)[] | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### PostMessageRequest

A user reply in a thread. Surrounding whitespace is trimmed; it must not be empty.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string (1–20000 chars) | yes |  |

_Strict: unknown keys are rejected._

#### ApprovalListResponse

Approval requests.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `approvals` | [`ApprovalRequest`](#approvalrequest)[] | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ApprovalResponse

One approval request.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `approval` | [`ApprovalRequest`](#approvalrequest) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ApprovalDecisionRequest

Body of `POST /api/approvals/:id`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `decision` | [`ApprovalDecision`](#approvaldecision) | yes |  |
| `scope` | [`ApprovalScope`](#approvalscope) | no |  |
| `note` | string (≤ 2000 chars) | no |  |

_Strict: unknown keys are rejected._

#### ConnectorsResponse

Every configured MCP connector.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `connectors` | [`ConnectorStatus`](#connectorstatus)[] | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ApiErrorCode

Machine-readable error code. Treat unknown codes like any failure with that HTTP status.

Type: `"invalid_json"` | `"invalid_request"` | `"invalid_path"` | `"invalid_settings"` | `"unauthorized"` | `"forbidden_host"` | `"forbidden_origin"` | `"not_found"` | `"conflict"` | `"payload_too_large"` | `"upgrade_required"` | `"http_error"` | `"agent_error"` | `"internal_error"` | `"agent_unavailable"`

#### ApiErrorBody

Body of every error response.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `error` | [`ApiErrorCode`](#apierrorcode) | yes |  |
| `message` | string | no | Human-readable explanation. |

_Tolerant: clients must ignore keys they don't know._

#### ConflictResponse

409 of a note write or rename whose target changed; `current` is null if the note is gone.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `error` | `"conflict"` | yes |  |
| `message` | string | no |  |
| `current` | [`NoteResponse`](#noteresponse) \| `null` | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ApprovalConflictResponse

409 of an approval decision when the approval is no longer pending.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `error` | `"conflict"` | yes |  |
| `message` | string | no |  |
| `approval` | [`ApprovalRequest`](#approvalrequest) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### VaultChangeOrigin

Who changed the vault: another program, a client (see `clientId`), the agent, or sync.

Type: `"external"` | `"client"` | `"agent"` | `"sync"`

#### VaultChange

One changed path.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string (1–4096 chars) | yes | Canonical vault-relative path (no leading `/`, `.`/`..` or empty segments). |
| `kind` | `"created"` \| `"modified"` \| `"deleted"` | yes |  |
| `version` | string (1–256 chars) | no | Opaque content version. |

_Tolerant: clients must ignore keys they don't know._

#### WsErrorCode

Machine-readable reason of a server `error` event.

Type: `"invalid_json"` | `"invalid_message"` | `"binary_unsupported"` | `"too_many_subscriptions"` | `"subscribe_failed"` | `"incompatible_api_version"`

#### ServerHelloEvent

First event on every connection.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"hello"` | yes |  |
| `serverVersion` | string (1–100 chars) | yes |  |
| `apiVersion` | integer (≥ 1) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### VaultChangedEvent

Vault paths changed (coalesced). Clients skip batches carrying their own `clientId`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"vault.changed"` | yes |  |
| `changes` | [`VaultChange`](#vaultchange)[] | yes |  |
| `origin` | [`VaultChangeOrigin`](#vaultchangeorigin) | yes |  |
| `clientId` | string (`^[A-Za-z0-9_-]{1,128}$`) | no | Client id chosen by the client. |

_Tolerant: clients must ignore keys they don't know._

#### TaskRecordsEvent

Snapshot of a note's task records.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"task.records"` | yes |  |
| `notePath` | string (1–4096 chars) | yes | Canonical vault-relative path (no leading `/`, `.`/`..` or empty segments). |
| `records` | [`TaskAgentRecord`](#taskagentrecord)[] | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### TaskRecordEvent

One task record changed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"task.record"` | yes |  |
| `record` | [`TaskAgentRecord`](#taskagentrecord) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ThreadUpsertEvent

A thread was created or its summary changed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"thread.upsert"` | yes |  |
| `thread` | [`ThreadSummary`](#threadsummary) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ThreadMessageEvent

A message was added or replaced (same `id`) in a thread.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"thread.message"` | yes |  |
| `threadId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `message` | [`ThreadMessage`](#threadmessage) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ThreadDeltaEvent

Streaming text appended to a `streaming` text message (droppable; the final message repairs gaps).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"thread.delta"` | yes |  |
| `threadId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `messageId` | string (1–200 chars) | yes | Identifier. |
| `delta` | string | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ApprovalUpsertEvent

An approval request was created or decided.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"approval.upsert"` | yes |  |
| `approval` | [`ApprovalRequest`](#approvalrequest) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### AgentStatusEvent

The agent status changed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"agent.status"` | yes |  |
| `status` | [`AgentStatusResponse`](#agentstatusresponse) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### SurfaceFrameEvent

A live surface frame; only sent to clients subscribed to that thread's surface (droppable).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"surface.frame"` | yes |  |
| `threadId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `surface` | [`SurfaceKind`](#surfacekind) | yes |  |
| `mimeType` | `"image/jpeg"` \| `"image/png"` | yes |  |
| `data` | string (base64, ≥ 1 chars) | yes | Base64-encoded image bytes. |
| `width` | integer (1–16384) | yes |  |
| `height` | integer (1–16384) | yes |  |
| `url` | string | no | Browser only. |
| `title` | string | no | Browser only. |
| `action` | [`SurfaceFrameAction`](#surfaceframeaction) | no |  |
| `ts` | integer (≥ 0) | yes | Epoch milliseconds. |

_Tolerant: clients must ignore keys they don't know._

#### SettingsChangedEvent

The effective settings changed.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"settings.changed"` | yes |  |
| `settings` | [`AppSettings`](#appsettings) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### ServerErrorEvent

Something the client sent was rejected (or the connection is about to close).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"error"` | yes |  |
| `message` | string | yes |  |
| `code` | [`WsErrorCode`](#wserrorcode) | no |  |

_Tolerant: clients must ignore keys they don't know._

#### ServerEvent

Every server → client WebSocket message, discriminated by `type`.

Type: [`ServerHelloEvent`](#serverhelloevent) | [`VaultChangedEvent`](#vaultchangedevent) | [`TaskRecordsEvent`](#taskrecordsevent) | [`TaskRecordEvent`](#taskrecordevent) | [`ThreadUpsertEvent`](#threadupsertevent) | [`ThreadMessageEvent`](#threadmessageevent) | [`ThreadDeltaEvent`](#threaddeltaevent) | [`ApprovalUpsertEvent`](#approvalupsertevent) | [`AgentStatusEvent`](#agentstatusevent) | [`SurfaceFrameEvent`](#surfaceframeevent) | [`SettingsChangedEvent`](#settingschangedevent) | [`ServerErrorEvent`](#servererrorevent)

#### ClientHelloEvent

First message a client sends: its id and the API version it speaks.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"hello"` | yes |  |
| `clientId` | string (`^[A-Za-z0-9_-]{1,128}$`) | yes | Client id chosen by the client. |
| `apiVersion` | integer (≥ 1) | no | API_VERSION the client was built against; absent = 1 (legacy clients). |
| `clientVersion` | string (1–100 chars) | no | e.g. `web/0.1.0`. |

_Strict: unknown keys are rejected._

#### ClientPingEvent

Keep-alive.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"ping"` | yes |  |

_Strict: unknown keys are rejected._

#### SurfaceSubscribeEvent

Start receiving `surface.frame` events for a thread's surface.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"surface.subscribe"` | yes |  |
| `threadId` | string (1–200 chars) | yes | Identifier. |
| `surface` | [`SurfaceKind`](#surfacekind) | yes |  |

_Strict: unknown keys are rejected._

#### SurfaceUnsubscribeEvent

Stop receiving frames for a thread's surface.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"surface.unsubscribe"` | yes |  |
| `threadId` | string (1–200 chars) | yes | Identifier. |
| `surface` | [`SurfaceKind`](#surfacekind) | yes |  |

_Strict: unknown keys are rejected._

#### ThreadReadEvent

The user has seen a thread (clears its unread count).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"thread.read"` | yes |  |
| `threadId` | string (1–200 chars) | yes | Identifier. |

_Strict: unknown keys are rejected._

#### EditorActivityEvent

Where the user is typing, so the orchestrator never jumps on a half-written task.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"editor.activity"` | yes |  |
| `notePath` | string (1–1024 chars) | yes |  |
| `line` | integer (≥ 0) | yes |  |

_Strict: unknown keys are rejected._

#### ClientEvent

Every client → server WebSocket message, discriminated by `type`.

Type: [`ClientHelloEvent`](#clienthelloevent) | [`ClientPingEvent`](#clientpingevent) | [`SurfaceSubscribeEvent`](#surfacesubscribeevent) | [`SurfaceUnsubscribeEvent`](#surfaceunsubscribeevent) | [`ThreadReadEvent`](#threadreadevent) | [`EditorActivityEvent`](#editoractivityevent)

<!-- END GENERATED REFERENCE -->
