# DailyDoListClient

Swift client of the local Daily Do List daemon (`apps/daemon`): REST under `/api/*` and the `/ws`
event stream. Foundation only (macOS 14+, iOS 17+), Swift 6 strict concurrency. Wire types come from
`DailyDoListModels`; the protocol itself is documented in `docs/PROTOCOL.md`.

| Type | What |
| --- | --- |
| `DaemonClient` | The protocol the app codes against (REST calls + `connect`/`events`/`send`). |
| `HTTPDaemonClient` | The real client: `URLSession` REST + `URLSessionWebSocketTask` events. |
| `FakeDaemonClient` | `DailyDoListClientTestSupport`: the tests' daemon (below). |
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

Every request but `pair` carries `Authorization: Bearer <token>`. Writes (`PUT`/`PATCH`/`POST`/`DELETE`, and
`GET /api/daily/…?create=1`, which writes the note) also carry `x-ddl-client-id`, so the daemon tags
the resulting `vault.changed` with this client's id. URLSession sends `Host: 127.0.0.1:<port>` and no
`Origin`, which is what the daemon's DNS-rebinding/CSRF guard accepts from native clients (verified
against a live daemon). Vault paths are percent-encoded per segment like `encodeURIComponent`
(`APIRoute`); `2xx` answers (including `201` and thread actions' `202 {pending: true}`) decode into
the `DailyDoListModels` types. `artifact(threadId:artifactId:)` returns the raw bytes and the media
type without parameters (`text/markdown`, not `text/markdown; charset=utf-8`).

Routines: `routines()` (`GET /api/routines`: every routine and the starter templates),
`routine(_:)`, `createRoutine(_:)` (`POST /api/routines`, 201; writes `Routines/<name>.md`),
`runRoutine(_:)` (the new run's thread id with the routine), `pauseRoutine(_:)` /
`resumeRoutine(_:)` (they rewrite the file's `paused:` line), and `threads(routineId:)`
(`GET /api/threads?routineId=`: a routine's runs). The routes' refusals keep the daemon's reason
in the error body: 400 for a name or schedule it can't use, 409 for a taken name or a run that
can't start now (a run going, a problem, no extra runs left today), 503 when the agent can't run
on this device.

This device, pairing and the always-on machine: `syncStatus()`, `deviceSettings()` /
`updateDeviceSettings(_:)` (`PATCH /api/device`: name, placement, remote hosts; 409
`locked_by_env` for a field an environment variable sets), `setUpSync(_:)` / `turnOffSync()`
(`PUT`/`DELETE /api/device/sync`; a nil token keeps the saved one, which is never returned),
`createPairingCode(_:)` (201; 429 `rate_limited` with too many outstanding), `pair(_:)`,
`pairedDevices()`, `revokeDevice(_:)` (204), and `machineStatus()`, `pairMachine(_:)`,
`checkMachine()`, `forgetMachine()` (`/api/machine*`; 502 `machine_unreachable`). `pair` is sent
**without** the bearer token: the code in the body is the credential. `DaemonClient`'s default
implementations of these answer like a daemon that predates them (404), so fakes that don't
need them don't implement them.

### Errors

All methods throw `DaemonClientError`:

- `.unreachable(reason)` — connection refused, timeout, connection lost (any `URLError` but cancel).
- `.unauthorized` — 401.
- `.pairingRejected(message)` — 401 `pairing_rejected` from `pair` or `pairMachine`: the pairing
  code was wrong, expired or already used (here, or on the always-on machine). Only those two
  routes read it: every other 401 is `.unauthorized`, and so is `pairMachine`'s 401 `unauthorized`
  (its bearer token was rejected).
- `.conflict(ConflictResponse)` — 409 on `writeNote` or a note `rename`; `current` is the note on
  disk now (nil when gone). A folder rename onto an existing folder is `.http(409, …)` instead (no
  `current` in the body).
- `.approvalConflict(ApprovalConflictResponse)` — 409 on `decideApproval`: already decided.
- `.rateLimited(retryAfter:body:)` — 429 (too many pairing attempts, pairing codes waiting, or
  the machine refusing more): `retryAfter` is the daemon's `Retry-After` in seconds when it sent
  one (`pair` does: when the next attempt can go).
- `.http(status:body:)` — any other non-2xx; `body` is the `ApiErrorBody` when there is one.
  `error.httpStatus` and `error.apiErrorCode` read them off any case. For a 400
  `invalid_request`, `body.problems` splits the daemon's validation report (one
  `✖ <message>\n  → at <path>` per problem) into `ValidationProblem`s (`path`, `message`); a
  message in another form is one problem without a path.
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
  `hello(clientId, apiVersion, clientVersion)`. The token rides in the URL only for a loopback
  daemon (`localhost`, `127.0.0.0/8`, `::1`: `DaemonEndpoint.isLoopback`), which every daemon
  accepts; any other host gets `wss://<host>/ws` with `Authorization: Bearer <token>`, since remote
  hosts refuse `?token=` (`DaemonEndpoint.webSocketRequest`). States: `.idle` → `.connecting` →
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

## FakeDaemonClient (tests)

The `DailyDoListClientTestSupport` library: a vault with the daemon's `baseVersion` semantics
(versions, 409s with the current note, renames, daily notes from a template), writes that can be
held, failures injected per call (`fail("readNote:Ideas.md", with:)`), a call log (`calls`,
`calls("thread:")`), a hand-driven event stream (`emit`), and canned answers per call
(`script { $0.agentStatus = { … } }`). Unscripted, agent and routine calls answer from `State`,
and the device, pairing and import calls like a daemon without those routes (404). It holds no
daemon logic: flows that need the daemon's real behavior belong in the integration tests
(`apps/macos/IntegrationTests`), which run the real daemon with the mock agent.

## Tests

```sh
apps/macos/scripts/test.sh DailyDoListClient
```

REST runs against a `URLProtocol` stub; the event stream against an in-process RFC 6455 server
(`Tests/…/Support/TestWebSocketServer.swift`) that also records the exact upgrade request. The
request bodies the HTTP client sends are validated in exact mode against
`packages/contract/schema/wire.schema.json`, whose validator is checked against the golden
fixtures. The integration tests (`apps/macos/IntegrationTests`) cover the real daemon.
