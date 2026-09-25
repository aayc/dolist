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

| Route | Method | Path | Auth | Body | Success |
| --- | --- | --- | --- | --- | --- |
| `health` | GET | `/api/health` | `bearer` | — | 200 [`HealthResponse`](#healthresponse) |
| `tree` | GET | `/api/vault/tree` | `bearer` | — | 200 [`VaultTreeResponse`](#vaulttreeresponse) |
| `note` | GET | `/api/notes/*` | `bearer` | — | 200 [`NoteResponse`](#noteresponse) |
| `note` | PUT | `/api/notes/*` | `bearer` | [`WriteNoteRequest`](#writenoterequest) | 200 [`WriteNoteResponse`](#writenoteresponse), 201 [`WriteNoteResponse`](#writenoteresponse) |
| `note` | DELETE | `/api/notes/*` | `bearer` | — | 200 [`TrashResponse`](#trashresponse) |
| `rename` | POST | `/api/notes-rename` | `bearer` | [`RenameRequest`](#renamerequest) | 200 [`RenameResponse`](#renameresponse) |
| `folders` | POST | `/api/folders` | `bearer` | [`CreateFolderRequest`](#createfolderrequest) | 201 [`CreateFolderResponse`](#createfolderresponse) |
| `folders` | DELETE | `/api/folders` | `bearer` | — | 200 [`TrashResponse`](#trashresponse) |
| `daily` | GET | `/api/daily/:date` | `bearer` | — | 200 [`DailyNoteResponse`](#dailynoteresponse) |
| `search` | GET | `/api/search` | `bearer` | — | 200 [`SearchResponse`](#searchresponse) |
| `settings` | GET | `/api/settings` | `bearer` | — | 200 [`SettingsResponse`](#settingsresponse) |
| `settings` | PUT | `/api/settings` | `bearer` | [`UpdateSettingsRequest`](#updatesettingsrequest) | 200 [`SettingsResponse`](#settingsresponse) |
| `settings` | PATCH | `/api/settings` | `bearer` | [`UpdateSettingsRequest`](#updatesettingsrequest) | 200 [`SettingsResponse`](#settingsresponse) |
| `agentStatus` | GET | `/api/agent/status` | `bearer` | — | 200 [`AgentStatusResponse`](#agentstatusresponse) |
| `agentEnabled` | PUT | `/api/agent/enabled` | `bearer` | [`SetAgentEnabledRequest`](#setagentenabledrequest) | 200 [`AgentStatusResponse`](#agentstatusresponse) |
| `agentEnabled` | POST | `/api/agent/enabled` | `bearer` | [`SetAgentEnabledRequest`](#setagentenabledrequest) | 200 [`AgentStatusResponse`](#agentstatusresponse) |
| `tasks` | GET | `/api/tasks` | `bearer` | — | 200 [`TaskRecordsResponse`](#taskrecordsresponse) |
| `threads` | GET | `/api/threads` | `bearer` | — | 200 [`ThreadListResponse`](#threadlistresponse) |
| `thread` | GET | `/api/threads/:id` | `bearer` | — | 200 [`ThreadResponse`](#threadresponse) |
| `threadMessages` | POST | `/api/threads/:id/messages` | `bearer` | [`PostMessageRequest`](#postmessagerequest) | 200 [`ThreadActionResponse`](#threadactionresponse), 202 [`ThreadActionResponse`](#threadactionresponse) |
| `threadCancel` | POST | `/api/threads/:id/cancel` | `bearer` | — | 200 [`ThreadActionResponse`](#threadactionresponse), 202 [`ThreadActionResponse`](#threadactionresponse) |
| `threadRetry` | POST | `/api/threads/:id/retry` | `bearer` | — | 200 [`ThreadActionResponse`](#threadactionresponse), 202 [`ThreadActionResponse`](#threadactionresponse) |
| `approvals` | GET | `/api/approvals` | `bearer` | — | 200 [`ApprovalListResponse`](#approvallistresponse) |
| `approval` | GET | `/api/approvals/:id` | `bearer` | — | 200 [`ApprovalResponse`](#approvalresponse) |
| `approval` | POST | `/api/approvals/:id` | `bearer` | [`ApprovalDecisionRequest`](#approvaldecisionrequest) | 200 [`ApprovalResponse`](#approvalresponse) |
| `artifact` | GET | `/api/artifacts/:threadId/:artifactId` | `bearer` | — | 200 bytes |
| `routines` | GET | `/api/routines` | `bearer` | — | 200 [`RoutineListResponse`](#routinelistresponse) |
| `routines` | POST | `/api/routines` | `bearer` | [`CreateRoutineRequest`](#createroutinerequest) | 201 [`RoutineResponse`](#routineresponse) |
| `routine` | GET | `/api/routines/:id` | `bearer` | — | 200 [`RoutineResponse`](#routineresponse) |
| `routineRun` | POST | `/api/routines/:id/run` | `bearer` | — | 200 [`RoutineRunResponse`](#routinerunresponse) |
| `routinePause` | POST | `/api/routines/:id/pause` | `bearer` | — | 200 [`RoutineResponse`](#routineresponse) |
| `routineResume` | POST | `/api/routines/:id/resume` | `bearer` | — | 200 [`RoutineResponse`](#routineresponse) |
| `connectors` | GET | `/api/connectors` | `bearer` | — | 200 [`ConnectorsResponse`](#connectorsresponse) |
| `syncStatus` | GET | `/api/sync/status` | `bearer` | — | 200 [`SyncStatusResponse`](#syncstatusresponse) |
| `computerPermissionsOpen` | POST | `/api/computer/permissions/open` | `bearer` | [`ComputerPermissionsOpenRequest`](#computerpermissionsopenrequest) | 200 [`OkResponse`](#okresponse) |
| `device` | GET | `/api/device` | `bearer` | — | 200 [`DeviceSettingsResponse`](#devicesettingsresponse) |
| `device` | PATCH | `/api/device` | `bearer` | [`DeviceSettingsPatch`](#devicesettingspatch) | 200 [`DeviceSettingsResponse`](#devicesettingsresponse) |
| `deviceSync` | PUT | `/api/device/sync` | `bearer` | [`DeviceSyncSetupRequest`](#devicesyncsetuprequest) | 200 [`DeviceSettingsResponse`](#devicesettingsresponse) |
| `deviceSync` | DELETE | `/api/device/sync` | `bearer` | — | 200 [`DeviceSettingsResponse`](#devicesettingsresponse) |
| `pairingCodes` | POST | `/api/pairing-codes` | `bearer` | [`PairingCodeRequest`](#pairingcoderequest) | 201 [`PairingCodeResponse`](#pairingcoderesponse) |
| `pair` | POST | `/api/pair` | `pairing_code` | [`PairRequest`](#pairrequest) | 201 [`PairResponse`](#pairresponse) |
| `devices` | GET | `/api/devices` | `bearer` | — | 200 [`PairedDevicesResponse`](#paireddevicesresponse) |
| `pairedDevice` | DELETE | `/api/devices/:id` | `bearer` | — | 204 no body |
| `machine` | GET | `/api/machine` | `bearer` | — | 200 [`MachineStatusResponse`](#machinestatusresponse) |
| `machinePair` | POST | `/api/machine/pair` | `bearer` | [`MachinePairRequest`](#machinepairrequest) | 200 [`MachineStatusResponse`](#machinestatusresponse) |
| `machineCheck` | POST | `/api/machine/check` | `bearer` | — | 200 [`MachineStatusResponse`](#machinestatusresponse) |
| `machinePairing` | DELETE | `/api/machine/pairing` | `bearer` | — | 200 [`MachineStatusResponse`](#machinestatusresponse) |
| `ws` | GET | `/ws` | `upgrade` | — | — |

Auth:

- `bearer`: `Authorization: Bearer <token>`, plus the Host and Origin checks.
- `pairing_code`: No bearer token: the pairing code in the body is the credential (Host and Origin are still checked).
- `upgrade`: WebSocket upgrade with the bearer token (`?token=`) and the Host check.

Every `/api/*` route can also answer 401 (`unauthorized`), 403 (`forbidden_host`, `forbidden_origin`), 500 (`internal_error`), unless it lists that status itself. Methods a route doesn't list answer 404 `not_found`.

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

**GET** — Thread summaries, optionally filtered by note, task or routine (empty = no filter).

- Query `notePath`
- Query `taskId`
- Query `routineId`: Only this routine's runs.
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

#### `routines` — `/api/routines`

**GET** — Every routine with its schedule, next and last run, plus the starter templates.

- Responses:
  - `200` [`RoutineListResponse`](#routinelistresponse) — Routines and templates.

**POST** — Create a routine: writes `Routines/<name>.md` (works while the agent is off).

- Body: [`CreateRoutineRequest`](#createroutinerequest)
- Responses:
  - `201` [`RoutineResponse`](#routineresponse) — Created.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request`, `invalid_path` — Malformed JSON or failed validation.
  - `409` [`ApiErrorBody`](#apierrorbody) `conflict` — A routine with that name exists.
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.

#### `routine` — `/api/routines/:id`

- Path parameter `id`: string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) — Runtime id, safe to use in URLs.

**GET** — One routine.

- Responses:
  - `200` [`RoutineResponse`](#routineresponse) — The routine.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request` — Invalid routine id.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Unknown routine.

#### `routineRun` — `/api/routines/:id/run`

- Path parameter `id`: any JSON

**POST** — Run a routine now (counts against its extra runs for today).

- Responses:
  - `200` [`RoutineRunResponse`](#routinerunresponse) — The run started.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request` — Invalid routine id.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Unknown routine.
  - `409` [`ApiErrorBody`](#apierrorbody) `conflict` — It can't run now: a run is going, it has a problem, or today's extra runs are used up.
  - `503` [`ApiErrorBody`](#apierrorbody) `agent_unavailable` — The agent can't run here right now.

#### `routinePause` — `/api/routines/:id/pause`

- Path parameter `id`: any JSON

**POST** — Pause a routine: sets `paused: true` in its file (works while the agent is off).

- Responses:
  - `200` [`RoutineResponse`](#routineresponse) — The routine as its file now reads.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request` — Invalid routine id.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Unknown routine.
  - `409` [`ApiErrorBody`](#apierrorbody) `conflict` — The file changed while it was being written; try again.

#### `routineResume` — `/api/routines/:id/resume`

- Path parameter `id`: any JSON

**POST** — Resume a routine: sets `paused: false` in its file; it runs from its next slot.

- Responses:
  - `200` [`RoutineResponse`](#routineresponse) — The routine as its file now reads.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request` — Invalid routine id.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Unknown routine.
  - `409` [`ApiErrorBody`](#apierrorbody) `conflict` — The file changed while it was being written; try again.

#### `connectors` — `/api/connectors`

**GET** — MCP connector states.

- Responses:
  - `200` [`ConnectorsResponse`](#connectorsresponse) — Connectors.

#### `syncStatus` — `/api/sync/status`

**GET** — The vault's sync state (and, with the sync service, this device's name).

- Responses:
  - `200` [`SyncStatusResponse`](#syncstatusresponse) — Sync status.

#### `computerPermissionsOpen` — `/api/computer/permissions/open`

**POST** — Open System Settings at a privacy pane computer use needs (Accessibility or Screen Recording).

- Body: [`ComputerPermissionsOpenRequest`](#computerpermissionsopenrequest)
- Responses:
  - `200` [`OkResponse`](#okresponse) — System Settings opened.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request` — Malformed JSON or failed validation.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Not a Mac: there is no System Settings to open.
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.
  - `500` [`ApiErrorBody`](#apierrorbody) `internal_error` — System Settings didn't open.

#### `device` — `/api/device`

**GET** — This daemon's device-local settings (name, placement, remote hosts, sync).

- Responses:
  - `200` [`DeviceSettingsResponse`](#devicesettingsresponse) — The device settings.

**PATCH** — Change the device's name, placement or remote hosts; applies live.

- Body: [`DeviceSettingsPatch`](#devicesettingspatch)
- Responses:
  - `200` [`DeviceSettingsResponse`](#devicesettingsresponse) — The device settings now.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request` — Malformed JSON or failed validation.
  - `409` [`ApiErrorBody`](#apierrorbody) `locked_by_env` — An environment variable sets this field (see `lockedByEnv`).
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.

#### `deviceSync` — `/api/device/sync`

**PUT** — Sync this vault with the sync service (the token is stored 0600 in `$DDL_HOME`, never returned).

- Body: [`DeviceSyncSetupRequest`](#devicesyncsetuprequest)
- Responses:
  - `200` [`DeviceSettingsResponse`](#devicesettingsresponse) — The device settings now.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request` — Malformed JSON or failed validation.
  - `409` [`ApiErrorBody`](#apierrorbody) `locked_by_env` — An environment variable sets this field (see `lockedByEnv`).
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.

**DELETE** — Stop syncing with the sync service and delete the saved token.

- Responses:
  - `200` [`DeviceSettingsResponse`](#devicesettingsresponse) — The device settings now.
  - `409` [`ApiErrorBody`](#apierrorbody) `locked_by_env` — An environment variable sets this field (see `lockedByEnv`).

#### `pairingCodes` — `/api/pairing-codes`

**POST** — Issue a single-use pairing code for a new device (valid for a few minutes).

- Body: [`PairingCodeRequest`](#pairingcoderequest)
- Responses:
  - `201` [`PairingCodeResponse`](#pairingcoderesponse) — The code.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request` — Malformed JSON or failed validation.
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.
  - `429` [`ApiErrorBody`](#apierrorbody) `rate_limited` — Too many codes outstanding.

#### `pair` — `/api/pair`

**POST** — Exchange a pairing code for a device credential: a token for `app` and `daemon`, an HttpOnly cookie for `browser`.

- Body: [`PairRequest`](#pairrequest)
- Responses:
  - `201` [`PairResponse`](#pairresponse) — Paired.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request` — Malformed JSON or failed validation.
  - `401` [`ApiErrorBody`](#apierrorbody) `pairing_rejected` — Wrong, expired or already used code.
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.
  - `429` [`ApiErrorBody`](#apierrorbody) `rate_limited` — Too many attempts; try again in a minute.

#### `devices` — `/api/devices`

**GET** — The devices paired with this daemon.

- Responses:
  - `200` [`PairedDevicesResponse`](#paireddevicesresponse) — Paired devices.

#### `pairedDevice` — `/api/devices/:id`

- Path parameter `id`: string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) — Runtime id, safe to use in URLs.

**DELETE** — Revoke a paired device: its credential stops working and its sockets close.

- Responses:
  - `204` no body — Revoked.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_request` — Invalid device id.
  - `404` [`ApiErrorBody`](#apierrorbody) `not_found` — Unknown device.

#### `machine` — `/api/machine`

**GET** — The always-on machine: address, this device's pairing and its last known status.

- Responses:
  - `200` [`MachineStatusResponse`](#machinestatusresponse) — Machine status.

#### `machinePair` — `/api/machine/pair`

**POST** — Pair this device with the always-on machine using a code it issued, and make it the vault's always-on machine.

- Body: [`MachinePairRequest`](#machinepairrequest)
- Responses:
  - `200` [`MachineStatusResponse`](#machinestatusresponse) — Paired: the machine's status.
  - `400` [`ApiErrorBody`](#apierrorbody) `invalid_json`, `invalid_request` — Malformed JSON or failed validation.
  - `401` [`ApiErrorBody`](#apierrorbody) `unauthorized`, `pairing_rejected` — Missing or invalid bearer token (`unauthorized`), or the machine rejected the code (`pairing_rejected`).
  - `413` [`ApiErrorBody`](#apierrorbody) `payload_too_large` — Body over 5 MB.
  - `429` [`ApiErrorBody`](#apierrorbody) `rate_limited` — The machine refused more attempts for now.
  - `502` [`ApiErrorBody`](#apierrorbody) `machine_unreachable` — The machine didn't answer.

#### `machineCheck` — `/api/machine/check`

**POST** — Check the always-on machine now (reachability, version, agent, readiness).

- Responses:
  - `200` [`MachineStatusResponse`](#machinestatusresponse) — The fresh status.

#### `machinePairing` — `/api/machine/pairing`

**DELETE** — Forget this device's credential for the always-on machine (revoked on the machine when it answers).

- Responses:
  - `200` [`MachineStatusResponse`](#machinestatusresponse) — Unpaired: the machine's status.

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
| `pairing_rejected` | The pairing code is wrong, expired or already used (checked here, or by the always-on machine). |
| `forbidden_host` | The Host header is not a loopback address of this daemon (DNS rebinding). |
| `forbidden_origin` | The Origin header is not allowed (CSRF). |
| `not_found` | Unknown route (or method), or the addressed item doesn't exist. |
| `conflict` | Stale `baseVersion`, existing target, or an approval that is no longer pending. |
| `locked_by_env` | The device setting is set by an environment variable (see `lockedByEnv`); change it there. |
| `payload_too_large` | Request body over 5 MB. |
| `upgrade_required` | `/ws` requested without a WebSocket upgrade. |
| `rate_limited` | Too many pairing attempts, or too many pairing codes outstanding; try later. |
| `http_error` | Raised by the HTTP framework itself. |
| `agent_error` | An agent action failed unexpectedly. |
| `internal_error` | Unexpected daemon failure. |
| `machine_unreachable` | The always-on machine didn't answer (network, TLS or timeout). |
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
| `routines.changed` | [`RoutinesChangedEvent`](#routineschangedevent) | Every routine, whenever one changed (its file, its schedule, its last run). |
| `routine.notification` | [`RoutineNotificationEvent`](#routinenotificationevent) | A routine's run finished and its `notify` says to tell the user (clients show a notification). |
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
| `anchor` | `"line"` | no | Present when the thread is attached to a non-task line (taskId is then the anchor id, text the line): clients highlight that line. |

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

#### CitedSource

A web page an agent found or read, as a citation preview.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes |  |
| `title` | string | no |  |
| `snippet` | string | no | A sentence or two from the search result or the page. |

_Tolerant: clients must ignore keys they don't know._

#### OrchestratorThreadId

The id of the orchestrator's own chat: a thread with `taskId` and `notePath` null that records each orchestrator turn (a `status` line saying what woke it, its streamed text, its tool calls, whose inputs carry the `taskId` they act on) and takes the user's direct messages (`POST /api/threads/:id/messages`). Its status is `working` during a turn, `idle` otherwise.

Type: `"thr_orchestrator"`

#### Thread

A task's full conversation: messages, artifacts and live surfaces. The orchestrator's own chat is a thread too (see `OrchestratorThreadId`).

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
| `routineId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | no | Set on a routine's runs: the routine (`Routine.id`) this thread is one run of. Clients list these under their routine, not in the task inbox. |
| `messages` | [`ThreadMessage`](#threadmessage)[] | yes |  |
| `artifacts` | [`ArtifactMeta`](#artifactmeta)[] | yes |  |
| `sources` | [`CitedSource`](#citedsource)[] | no | Web pages the thread cites, with what the agent saw of them: clients preview citations from here, never by fetching. |

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
| `routineId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | no | Set on a routine's runs: the routine (`Routine.id`) this thread is one run of. Clients list these under their routine, not in the task inbox. |
| `messageCount` | integer (≥ 0) | yes |  |
| `lastMessagePreview` | string | no |  |
| `artifactCount` | integer (≥ 0) | yes |  |
| `pendingApprovals` | integer (≥ 0) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### RoutineNotify

When a finished run notifies: `always`, `when_changed` (only when it found something new) or `never`. The file spells `when_changed` as `when changed`.

Type: `"always"` | `"when_changed"` | `"never"`

#### RoutineUse

A capability a routine's runs get (its file's `uses`).

Type: `"web"` | `"browser"` | `"computer"` | `"shell"` | `"files"` | `"connectors"`

#### RoutineRunTrigger

What started a run: its schedule, a slot missed while the Mac slept or the daemon was down (`catch_up`, once however many were missed), or the user (`manual`).

Type: `"schedule"` | `"catch_up"` | `"manual"`

#### RoutineRun

One run of a routine; its thread holds the conversation.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `threadId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `trigger` | [`RoutineRunTrigger`](#routineruntrigger) | yes |  |
| `status` | [`TaskAgentStatus`](#taskagentstatus) | yes |  |
| `startedAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `finishedAt` | integer (≥ 0) | no | Epoch milliseconds. |
| `summary` | string | no | One line: the run's badge text. |
| `changed` | boolean | no | Whether the run found something new since the previous one. |

_Tolerant: clients must ignore keys they don't know._

#### Routine

A standing job the agent runs on a schedule: the file `Routines/<name>.md` (schedule, notify, uses and paused in its frontmatter, the instructions as its body) plus the scheduler's state.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Stable id derived from the file's path (`rtn_…`). |
| `path` | string (1–4096 chars) | yes | Canonical vault-relative path (no leading `/`, `.`/`..` or empty segments). |
| `name` | string (≥ 1 chars) | yes | The file name without `.md`. |
| `schedule` | string | yes | The schedule as written in the file. |
| `scheduleText` | string | no | The schedule in words; absent when it can't be read. |
| `notify` | [`RoutineNotify`](#routinenotify) | yes |  |
| `uses` | [`RoutineUse`](#routineuse)[] | yes |  |
| `paused` | boolean | yes |  |
| `instructions` | string | yes |  |
| `error` | string | no | Why the routine can't run. |
| `nextRunAt` | integer (≥ 0) | no | Absent while paused, invalid or unscheduled. |
| `lastRun` | [`RoutineRun`](#routinerun) | no |  |
| `runCount` | integer (≥ 0) | yes | Runs kept (threads with this `routineId`). |
| `extraRunsLeft` | integer (≥ 0) | yes | Runs that may still start today beyond the schedule. |

_Tolerant: clients must ignore keys they don't know._

#### RoutineTemplate

A starter routine offered by “New routine”.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (1–200 chars) | yes | Identifier. |
| `name` | string (≥ 1 chars) | yes |  |
| `description` | string | yes |  |
| `schedule` | string (≥ 1 chars) | yes |  |
| `notify` | [`RoutineNotify`](#routinenotify) | yes |  |
| `uses` | [`RoutineUse`](#routineuse)[] | yes |  |
| `instructions` | string (≥ 1 chars) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### RoutineNotification

A finished run to tell the user about (sent according to the routine's `notify`).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `routineId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `title` | string | yes | The routine's name. |
| `body` | string | yes | The run's result in a line or two. |
| `threadId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `status` | [`TaskAgentStatus`](#taskagentstatus) | yes |  |
| `at` | integer (≥ 0) | yes | Epoch milliseconds. |

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

#### AgentHarnessKind

What runs the orchestrator and subagent conversations: `pi` (the Pi coding-agent SDK on the OpenRouter `model`) or `cursor` (the Cursor CLI's agent on `cursorModel`, signed in with the user's Cursor account).

Type: `"pi"` | `"cursor"`

#### ApprovalPolicy

When agents ask before acting: `ask_every_action` (every action that changes something), `ask_risky` (what the safety check flags; the default), `ask_high_risk` (only high-risk actions) or `run_everything` (never). Actions the safety check denies stay blocked under every policy.

Type: `"ask_every_action"` | `"ask_risky"` | `"ask_high_risk"` | `"run_everything"`

#### AgentSettings

Orchestrator and subagent settings.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | yes | Master switch: when false the orchestrator ignores note changes. |
| `settleMs` | integer (0–120000) | yes | Quiet period after the last edit to a task before the orchestrator looks at it. |
| `maxConcurrentSubagents` | integer (1–32) | yes |  |
| `actOnExistingTasks` | boolean | yes |  |
| `approvalTimeoutMs` | integer (60000–2592000000) | yes | How long an approval request waits before it is auto-denied. |
| `approvalPolicy` | [`ApprovalPolicy`](#approvalpolicy) | yes |  |
| `harness` | [`AgentHarnessKind`](#agentharnesskind) | yes |  |
| `model` | string (`^\S(?:[\s\S]*\S)?$`, 1–200 chars) | yes | OpenRouter model id for the orchestrator and subagents with the Pi harness. |
| `cursorModel` | string (`^\S(?:[\s\S]*\S)?$`, 1–200 chars) | yes | Model for the orchestrator and subagents with the Cursor harness (`claude-opus-5-5`, `composer-2.5`). The CLI's agent mode runs one preset per model; a variant id from `agent models` (`claude-opus-5-5-high-fast`) runs as its model's preset. |
| `judgeModel` | string (`^\S(?:[\s\S]*\S)?$`, 1–200 chars) | yes | OpenRouter model id for the safety judge (whichever harness runs the agent). |
| `watch` | [`AgentWatchWindow`](#agentwatchwindow) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### AlwaysOnMachine

The always-on machine every device can hand the agent to. Its name and address sync; each device pairs once and keeps its own credential.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string (1–64 chars) | yes | 1–64 characters (e.g. the first label of its host). |
| `url` | string (1–300 chars) | yes | `https://<host>[:port]`: lowercase, no trailing `/`, path, query or credentials; plain http only to loopback. |

_Tolerant: clients must ignore keys they don't know._

#### RemoteSettings

Remote access settings shared by every device (non-secret).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `alwaysOnMachine` | [`AlwaysOnMachine`](#alwaysonmachine) \| `null` | yes | null: no always-on machine. |

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
| `remote` | [`RemoteSettings`](#remotesettings) | yes |  |

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
| `remote` | object | no |  |

_Strict: unknown keys are rejected._

#### AgentPlacement

Where this device's agent runs: `this_device` (here; takes the agent over from the always-on machine), `always_on_machine` (never here; relayed to the always-on machine) or `always_on_host` (this is the always-on machine; it runs the agent when no `this_device` does). Without sync a daemon runs its own agent whatever the placement.

Type: `"this_device"` | `"always_on_machine"` | `"always_on_host"`

#### AgentRunsOn

The device that holds the agent lease.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `deviceId` | string (`^[A-Za-z0-9_-]{1,64}$`) | yes | Device id (as the sync service knows it). |
| `name` | string (`^\S(?:[\s\S]*\S)?$`, 1–100 chars) | yes |  |
| `thisDevice` | boolean | yes |  |
| `alwaysOnMachine` | boolean | yes | The holder requested the lease with priority "host". |

_Tolerant: clients must ignore keys they don't know._

#### RelayState

The link to the always-on machine's agent: `off` (not relaying), `connecting`, `connected`, `unreachable` or `not_paired`.

Type: `"off"` | `"connecting"` | `"connected"` | `"unreachable"` | `"not_paired"`

#### AgentPlacementStatus

This device's placement and who runs the agent now.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `placement` | [`AgentPlacement`](#agentplacement) | yes | The stored choice (see `heldHere` for when it can't apply). |
| `heldHere` | `"no_machine"` \| `"no_sync"` | no | Why the agent is held on this device despite the stored choice: no always-on machine is set up (`no_machine`), or this device doesn't sync (`no_sync`). |
| `runsOn` | [`AgentRunsOn`](#agentrunson) \| `null` | yes | Who runs the agent now (null: nobody, or unknown without sync). |
| `relay` | [`RelayState`](#relaystate) | yes |  |
| `note` | string | no | Short, human ("Taking over from vm-1…", "Handing the agent to vm-1…"). |

_Tolerant: clients must ignore keys they don't know._

#### AgentReadiness

Whether a daemon can run the agent: its harness, a model credential (never the value), the browser, desktop control and connectors.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `harness` | object | yes |  |
| `modelCredential` | boolean | yes | A model credential for the configured harness is present. |
| `browser` | boolean | yes |  |
| `computer` | `"available"` \| `"needs_permissions"` \| `"unsupported"` | yes |  |
| `connectors` | object | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### DeviceSyncSetup

This device's link to the sync service. The vault token is never returned.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string (1–2048 chars) \| `null` | yes | null: not syncing with the sync service. |
| `vault` | string (`^[A-Za-z0-9_-]{1,64}$`) \| `null` | yes | The sync vault id. |
| `hasToken` | boolean | yes | A vault token is saved. |

_Tolerant: clients must ignore keys they don't know._

#### DeviceSettingsResponse

This daemon's device-local settings (kept in `$DDL_HOME`, never synced).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | object | yes |  |
| `placement` | [`AgentPlacement`](#agentplacement) | yes |  |
| `remoteHosts` | string (1–259 chars)[] | yes | Names this daemon answers to besides loopback (e.g. its tailnet name). |
| `sync` | [`DeviceSyncSetup`](#devicesyncsetup) | yes |  |
| `lockedByEnv` | `"placement"` \| `"remoteHosts"` \| `"sync"`[] | yes | Fields set by environment variables; clients show them read-only. |

_Tolerant: clients must ignore keys they don't know._

#### DeviceSettingsPatch

Body of `PATCH /api/device`: only the fields to change.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string (1–64 chars) | no | Trimmed, then 1–64 characters. |
| `placement` | [`AgentPlacement`](#agentplacement) | no |  |
| `remoteHosts` | string (≤ 269 chars)[] | no | DNS names with an optional `:port`, at most 8; trimmed and lowercased. No IPs, schemes or paths. |

_Strict: unknown keys are rejected._

#### DeviceSyncSetupRequest

Body of `PUT /api/device/sync`: point this device at the sync service.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string (1–2048 chars) | yes | The sync service: https (plain http only to loopback). |
| `vault` | string (`^[A-Za-z0-9_-]{1,64}$`) | yes | The vault id printed by `ddl-sync vault create`. |
| `token` | string (1–1024 chars) | no | The vault token; omit to keep the saved one. Stored 0600 in `$DDL_HOME`. |

_Strict: unknown keys are rejected._

#### PairedDeviceKind

`browser` (gets an HttpOnly cookie), `app` (a native client) or `daemon` (another daemon relaying to this one).

Type: `"browser"` | `"app"` | `"daemon"`

#### PairedDevice

A device holding a credential for this daemon.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |
| `name` | string (1–64 chars) | yes |  |
| `kind` | [`PairedDeviceKind`](#paireddevicekind) | yes |  |
| `createdAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `lastSeenAt` | integer (≥ 0) \| `null` | yes | Last use (updated at most once a minute). |
| `current` | boolean | no | The device making this request. |

_Tolerant: clients must ignore keys they don't know._

#### PairingCodeRequest

Body of `POST /api/pairing-codes`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string (1–64 chars) | no | What the new device will be called. |

_Strict: unknown keys are rejected._

#### PairingCodeResponse

A single-use pairing code.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string (8–8 chars) | yes | 8 characters of `23456789ABCDEFGHJKMNPQRSTVWXYZ`; show it as XXXX-XXXX. |
| `expiresAt` | integer (≥ 0) | yes | Epoch milliseconds. |
| `url` | string (≤ 300 chars) \| `null` | yes | `https://<first remote host>` for a QR code; null without remote hosts. |

_Tolerant: clients must ignore keys they don't know._

#### PairRequest

Body of `POST /api/pair`: exchange a pairing code for a device credential.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string (1–32 chars) | yes | The pairing code: 8 characters of `23456789ABCDEFGHJKMNPQRSTVWXYZ`, any case; spaces and dashes are ignored. |
| `name` | string (1–64 chars) | yes |  |
| `kind` | [`PairedDeviceKind`](#paireddevicekind) | yes |  |

_Strict: unknown keys are rejected._

#### PairResponse

The paired device and, for `app` and `daemon` kinds, its token (shown once). A browser gets an HttpOnly cookie instead.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `device` | [`PairedDevice`](#paireddevice) | yes |  |
| `token` | string (16–512 chars) | no | Send as `Authorization: Bearer <token>`. |

_Tolerant: clients must ignore keys they don't know._

#### PairedDevicesResponse

Every device paired with this daemon.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `devices` | [`PairedDevice`](#paireddevice)[] | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### MachineStatusResponse

The always-on machine from this device's side: its address, this device's pairing and what the machine reports.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `machine` | [`AlwaysOnMachine`](#alwaysonmachine) \| `null` | yes | null: no always-on machine configured. |
| `paired` | boolean | yes | This device holds a credential for the machine. |
| `reachable` | boolean \| `null` | yes | null: not checked yet, or no machine. |
| `checkedAt` | integer (≥ 0) \| `null` | yes |  |
| `version` | string (1–100 chars) | no | The machine's daemon version. |
| `agent` | object | no | Where the agent runs, as the machine reports it. |
| `readiness` | [`AgentReadiness`](#agentreadiness) | no | The machine's readiness. |
| `error` | string | no | Why the last check or pairing failed. |

_Tolerant: clients must ignore keys they don't know._

#### MachinePairRequest

Body of `POST /api/machine/pair`: pair this device with the always-on machine.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string (1–300 chars) | yes | `https://<tailnet name>[:port]`; case and a trailing `/` are normalized. |
| `code` | string (1–32 chars) | yes | The pairing code: 8 characters of `23456789ABCDEFGHJKMNPQRSTVWXYZ`, any case; spaces and dashes are ignored. |
| `name` | string (1–64 chars) | no | Default: the first label of the host. |

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

#### ComputerHostApp

The app macOS attributes the daemon's privacy permissions to (the Daily Do List app, or the terminal or editor it runs from).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string (1–200 chars) | yes | As listed in System Settings. |
| `path` | string (1–1024 chars) | no | The `.app` bundle. |
| `bundleId` | string (1–200 chars) | no |  |

_Tolerant: clients must ignore keys they don't know._

#### ComputerAccess

Computer use on this Mac: its two privacy permissions and whether agents can operate apps in the background.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `accessibility` | boolean | yes | Input and reading other apps' UI. |
| `screenRecording` | boolean | yes | Screenshots. macOS applies a new grant after the host app restarts. |
| `appControl` | boolean | yes | The `ddl-computer` helper is available; otherwise computer use is screen-level only. |
| `hostApp` | [`ComputerHostApp`](#computerhostapp) | no | Absent when it can't be determined. |

_Tolerant: clients must ignore keys they don't know._

#### ExecutionStatus

The execution provider and what it can do.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | string (1–200 chars) | yes |  |
| `capabilities` | object | yes |  |
| `computerAccess` | [`ComputerAccess`](#computeraccess) | no | Present where computer use exists (macOS with computer use enabled). |

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
| `placement` | [`AgentPlacementStatus`](#agentplacementstatus) | no | Where the agent runs for this device, and who runs it now. |
| `readiness` | [`AgentReadiness`](#agentreadiness) | no | This daemon's own readiness to run the agent. |

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

#### RoutineListResponse

Every routine (sorted by name) and the starter templates for “New routine”.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `routines` | [`Routine`](#routine)[] | yes |  |
| `templates` | [`RoutineTemplate`](#routinetemplate)[] | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### RoutineResponse

One routine.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `routine` | [`Routine`](#routine) | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### CreateRoutineRequest

Body of `POST /api/routines`: a new routine file `Routines/<name>.md`. The daemon checks the name (a file name) and the schedule (400 with the reason when it can't be read).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string (1–100 chars) | yes | The file name, without `.md`. |
| `schedule` | string (1–200 chars) | yes | e.g. `every weekday at 7:30`. |
| `instructions` | string (1–8000 chars) | yes | What each run does. |
| `notify` | [`RoutineNotify`](#routinenotify) | no | Default `always`. |
| `uses` | [`RoutineUse`](#routineuse)[] | no |  |
| `paused` | boolean | no |  |

_Strict: unknown keys are rejected._

#### RoutineRunResponse

A run started now: the routine and the run's thread.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `routine` | [`Routine`](#routine) | yes |  |
| `threadId` | string (`^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$`) | yes | Runtime id, safe to use in URLs. |

_Tolerant: clients must ignore keys they don't know._

#### SyncState

`idle`, `syncing`, `error` (see `lastError`) or `disabled` (no sync target).

Type: `"idle"` | `"syncing"` | `"error"` | `"disabled"`

#### SyncTargetKind

`none`, `local` (another folder), `s3`, or `remote` (the sync service shared with other devices).

Type: `"none"` | `"local"` | `"s3"` | `"remote"`

#### SyncStatusResponse

The vault's sync state.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `state` | [`SyncState`](#syncstate) | yes |  |
| `target` | [`SyncTargetKind`](#synctargetkind) | yes |  |
| `lastSyncedAt` | integer (≥ 0) \| `null` | yes | When the last pass finished; null before it. |
| `pendingChanges` | integer (≥ 0) | yes | Files changed on either side and not synced yet. |
| `conflicts` | string (1–4096 chars)[] | yes | Conflict copies waiting to be resolved. |
| `lastError` | string | no |  |
| `remoteHost` | string (1–300 chars) | no | The sync server (`remote` only). |
| `deviceName` | string (1–100 chars) | no | This device's name as other devices see it (`remote` only). |

_Tolerant: clients must ignore keys they don't know._

#### ComputerPermissionPane

A System Settings privacy pane computer use needs.

Type: `"accessibility"` | `"screenRecording"`

#### ComputerPermissionsOpenRequest

Body of `POST /api/computer/permissions/open`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `pane` | [`ComputerPermissionPane`](#computerpermissionpane) | yes |  |

_Strict: unknown keys are rejected._

#### ApiErrorCode

Machine-readable error code. Treat unknown codes like any failure with that HTTP status.

Type: `"invalid_json"` | `"invalid_request"` | `"invalid_path"` | `"invalid_settings"` | `"unauthorized"` | `"pairing_rejected"` | `"forbidden_host"` | `"forbidden_origin"` | `"not_found"` | `"conflict"` | `"locked_by_env"` | `"payload_too_large"` | `"upgrade_required"` | `"rate_limited"` | `"http_error"` | `"agent_error"` | `"internal_error"` | `"machine_unreachable"` | `"agent_unavailable"`

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

#### RoutinesChangedEvent

Every routine, whenever one changed (its file, its schedule, its last run).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"routines.changed"` | yes |  |
| `routines` | [`Routine`](#routine)[] | yes |  |

_Tolerant: clients must ignore keys they don't know._

#### RoutineNotificationEvent

A routine's run finished and its `notify` says to tell the user (clients show a notification).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"routine.notification"` | yes |  |
| `notification` | [`RoutineNotification`](#routinenotification) | yes |  |

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

Type: [`ServerHelloEvent`](#serverhelloevent) | [`VaultChangedEvent`](#vaultchangedevent) | [`TaskRecordsEvent`](#taskrecordsevent) | [`TaskRecordEvent`](#taskrecordevent) | [`ThreadUpsertEvent`](#threadupsertevent) | [`ThreadMessageEvent`](#threadmessageevent) | [`ThreadDeltaEvent`](#threaddeltaevent) | [`ApprovalUpsertEvent`](#approvalupsertevent) | [`AgentStatusEvent`](#agentstatusevent) | [`SurfaceFrameEvent`](#surfaceframeevent) | [`SettingsChangedEvent`](#settingschangedevent) | [`RoutinesChangedEvent`](#routineschangedevent) | [`RoutineNotificationEvent`](#routinenotificationevent) | [`ServerErrorEvent`](#servererrorevent)

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
