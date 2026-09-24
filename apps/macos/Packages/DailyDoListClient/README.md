# DailyDoListClient

Swift client of the local Daily Do List daemon (`apps/daemon`): REST under `/api/*` and the `/ws`
event stream. Foundation only (macOS 14+, iOS 17+), Swift 6 strict concurrency. Wire types come from
`DailyDoListModels`; the protocol itself is documented in `docs/PROTOCOL.md`.

| Type | What |
| --- | --- |
| `DaemonClient` | The protocol the app codes against (REST calls + `connect`/`events`/`send`). |
| `HTTPDaemonClient` | The real client: `URLSession` REST + `URLSessionWebSocketTask` events. |
| `InMemoryDaemonClient` | A faithful fake daemon for tests, SwiftUI previews and demo mode. |
| `DaemonEndpoint` | Base URL + bearer token; `DaemonEndpoint.discover()` reads the token file. |
| `DaemonClientError` | Every failure, typed. |
| `ConnectionState`, `DaemonStreamItem` | What `events()` streams yield. |

## Quick start

```swift
import DailyDoListClient

let endpoint = try DaemonEndpoint.discover()          // $DDL_HOME (~/.daily-do-list)/daemon-token, port 7331
let client = HTTPDaemonClient(endpoint: endpoint)
guard await client.waitUntilHealthy(timeout: .seconds(10)) else { /* not running or wrong token */ }
guard DaemonProtocol.isCompatible(apiVersion: try await client.health().apiVersion) else { /* update */ }

let events = client.events()                           // start listening before connecting
await client.connect()
for await item in events {
  switch item {
  case .state(let state): /* show online/offline/incompatible */
  case .event(let event): /* reduce into stores; ignore .vaultChanged whose clientId == client.clientId */
  case .resync: /* refetch tree, open notes, records, threads, approvals */
  }
}                                                      // ends after `disconnect()`
```

`HTTPDaemonClient.init(endpoint:session:clientId:clientVersion:options:)` — `session` defaults to
`.shared`, `clientId` to `macos_<32 hex>` (must match `^[A-Za-z0-9_-]{1,128}$`), `clientVersion` to
`macos/<CFBundleShortVersionString>`. `Options` holds `requestTimeout` (15 s), `artifactTimeout`
(60 s), `reconnectBackoff` (0.25 s doubling to 30 s, ±20 % jitter), `helloTimeout` (10 s),
`pingInterval` (25 s, nil disables) and `maximumMessageSize` (16 MiB, for surface frames).

`DaemonEndpoint.discover(home:port:)` trims the token file and throws `DaemonDiscoveryError`
(`tokenFileMissing`, `tokenFileEmpty`, `tokenFileUnreadable`, `invalidPort`). With `port: nil` the
port resolves like the daemon's: `$DDL_PORT`, then `port` in `<home>/config.json`, then 7331.

## REST

Every request carries `Authorization: Bearer <token>`. Writes (`PUT`/`POST`/`DELETE`, and
`GET /api/daily/…?create=1`, which writes the note) also carry `x-ddl-client-id`, so the daemon tags
the resulting `vault.changed` with this client's id. URLSession sends `Host: 127.0.0.1:<port>` and no
`Origin`, which is what the daemon's DNS-rebinding/CSRF guard accepts from native clients (verified
against a live daemon). Vault paths are percent-encoded per segment like `encodeURIComponent`
(`APIRoute`); `2xx` answers (including `201` and thread actions' `202 {pending: true}`) decode into
the `DailyDoListModels` types. `artifact(threadId:artifactId:)` returns the raw bytes and the media
type without parameters (`text/markdown`, not `text/markdown; charset=utf-8`).

### Errors

All methods throw `DaemonClientError`:

- `.unreachable(reason)` — connection refused, timeout, connection lost (any `URLError` but cancel).
- `.unauthorized` — 401.
- `.conflict(ConflictResponse)` — 409 on `writeNote` or a note `rename`; `current` is the note on
  disk now (nil when gone). A folder rename onto an existing folder is `.http(409, …)` instead (no
  `current` in the body).
- `.approvalConflict(ApprovalConflictResponse)` — 409 on `decideApproval`: already decided.
- `.http(status:body:)` — any other non-2xx; `body` is the `ApiErrorBody` when there is one.
  `error.httpStatus` and `error.apiErrorCode` read them off any case.
- `.decoding("<Type> at <codingPath>: <reason>")` — a 2xx body that doesn't match the protocol.
- `.cancelled` — the calling task was cancelled.

Values that URL parsers would silently reinterpret fail locally with the 400 the daemon would give,
without a request: note paths with `.`/`..` segments (`invalid_path`) and thread/approval/artifact
ids outside `^[A-Za-z0-9_.:-]{1,200}$` (`invalid_request`).

`waitUntilHealthy(timeout:pollInterval:)` (on every `DaemonClient`) polls `health()` with growing
intervals; it returns false on timeout, cancellation, or 401 (waiting won't fix a wrong token), and
never holds the caller past the deadline.

## Events and reconnection

- `events()` returns a **new** `AsyncStream` per call (any number of consumers, one global order,
  unbounded buffer). It yields the current state first and **finishes at the next `disconnect()`**
  (after `.state(.disconnected)`); call it again after reconnecting. Dropped streams unregister.
- `connect()` (idempotent) opens `ws://127.0.0.1:<port>/ws?token=…` and sends
  `hello(clientId, apiVersion, clientVersion)`. States: `.idle` → `.connecting` →
  `.connected(serverVersion:)` when the daemon's `hello` arrives with a compatible `apiVersion`; the
  `hello` itself is also delivered as `.event(.hello)`.
- Incompatible `hello.apiVersion`, or close code 4426, → `.incompatible(serverApiVersion:)` and no
  more reconnects (a later `connect()` tries again).
- On close, error, a rejected upgrade (e.g. HTTP 401) or no `hello` within `helloTimeout`:
  `.reconnecting(attempt:reason:)` (attempt 1, 2, … since the last successful connection), backoff
  sleep, retry — until `disconnect()`. After a successful **re**connection the stream yields
  `.connected`, `.event(.hello)`, then `.resync`: events may have been missed, refetch.
- Server events decode as `ServerEvent`; unknown types arrive as `.unknown(type:raw:)`. Malformed
  frames and binary frames are logged (`os.Logger`, subsystem `DailyDoList`) and skipped.
- `send(_:)` is best-effort: dropped unless connected. `surfaceSubscribe`/`surfaceUnsubscribe` are
  tracked (even while disconnected) and the active subscriptions are re-sent after every connect.
- `disconnect()` stops reconnecting, closes the socket (code 1000), emits `.state(.disconnected)`
  and finishes every current stream. `connectionState` reads the current state synchronously.

## InMemoryDaemonClient (tests, previews, demo mode)

```swift
// Demo mode / previews: seeded vault, real-time pacing.
let demo = InMemoryDaemonClient()                                   // seed: .demo, clock: .realTime()

// Tests: deterministic, instant.
let client = InMemoryDaemonClient(seed: .empty, clock: .immediate(), agent: .enabled)
_ = try await client.writeNote("Daily/2026-09-23.md", content: "- [ ] Order a new kettle\n", baseVersion: .createOnly)
let approval = try await client.approvals(status: .pending).first!   // the agent now waits on it
_ = try await client.decideApproval(approval.id, .init(decision: .deny, note: "Not now"))
```

`init(seed:clock:agent:clientId:)`:

- **`Seed`** — `.demo`: today's daily note from the `- [ ] ` template with two tasks the agent already
  finished, previous days with a gap and done tasks (with finished threads and approvals),
  `Templates/Daily.md`, `Projects/…`, `Ideas.md`, `Welcome.md` (synthetic content only). `.empty`, or
  `.files([path: content])`. Tasks already in a seed are never acted on.
- **`SimulationClock`** — `.realTime(speed:)` (default; wall-clock pacing), `.immediate()` (scheduled
  work runs to completion before each call returns), `.manual()` (nothing runs until
  `advance(by:)`/`runUntilIdle()`). The deterministic clocks start at 2026-09-23 09:30 UTC in UTC
  (pass `start:`/`timeZone:` to change); `today` and daily note names use the clock's time zone.
  Given the same calls, `.immediate`/`.manual` fakes emit identical events, ids (`thr_0001`, …) and
  timestamps.
- **`AgentSimulation`** — `.enabled`, or `.disabled` (agent mode `off`: no records or threads; thread
  actions answer 503 `agent_unavailable`).

It follows the daemon's semantics: canonical/hidden path rules, content-hash versions identical to
the daemon's, `baseVersion` (unconditional / create-only / match → `.conflict` with the current
note), soft deletes into `.trash/` with the daemon's ` (YYYY-MM-DD HHmmss[ n])` collision suffixes,
folder rename/delete, daily notes from the template (`today` in local time, `created`, idempotent),
search (every term, name hits first, 0-based lines, previews), settings patches validated against
`SettingsRanges` (→ `.http(400, invalid_request)`), and the same error codes and messages. A parity
run against a live daemon gave identical results for 29 REST scenarios.

The simulated agent (same scripts as the web mock) watches daily notes inside the watch window. A
new open, non-blank task (`- [ ] text`, identity kept across edits like the real tracker) settles
for `agent.settleMs` (1.2 s; longer while `editor.activity` points at its line), then: record `idle` →
`triaging` → `working`, a thread (`thread.upsert`), streamed text (`thread.message` streaming,
`thread.delta` per word, final `thread.message`), tool calls `running` → `ok`, a markdown artifact,
and `done` with a summary. Whole-word `buy|order|book|reserve|email|send|pay` tasks request an
approval (`approval.upsert`) and wait: approve → tool `ok` → `done`; deny → tool `blocked` → `done`
with the note quoted. Tasks mentioning "browse" show a browser surface and send `surface.frame`s (a
16×10 PNG) to subscribers. `maxConcurrentSubagents` queues extra tasks; `cancelThread`,
`retryThread`, `postMessage` (orchestrator reply) and `thread.read` (clears `unread`) work; deleting
a task line drops its record. Writes emit `vault.changed` with origin `client` and this `clientId`.

Extras: `advance(by:)`, `runUntilIdle()`, `pendingActions`, `now`,
`simulateExternalEdit(_:content:)` (origin `external`, `nil` deletes), `connectionState`.
Connection semantics match `HTTPDaemonClient` (`connect` → `.connecting`, `.connected`, `hello`;
`.resync` on reconnect; events only while connected; `disconnect` finishes streams).

Differences from the real daemon: no approval expiry, no `vault.changed` coalescing window,
empty subfolders of a moved folder are not kept (like the daemon), scripts are the web mock's (the
real mock runtime may ask questions after a denial), and nothing persists.

## Tests

```sh
apps/macos/scripts/test.sh DailyDoListClient
DDL_LIVE_DAEMON=1 apps/macos/scripts/test.sh DailyDoListClient   # + read-only checks against a running daemon
```

REST runs against a `URLProtocol` stub; the event stream against an in-process RFC 6455 server
(`Tests/…/Support/TestWebSocketServer.swift`) that also records the exact upgrade request. The fake
is validated in exact mode against `packages/contract/schema/wire.schema.json` and the golden
fixtures, as are the request bodies the HTTP client sends.
