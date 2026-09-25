# Sync between devices

Daily Do List keeps notes as plain markdown files in a folder on each device. To use one vault on
several devices, each device's daemon syncs its folder with a small **sync service**
(`apps/sync`): a per-vault change log in SQLite behind an HTTP API, with live push over a
WebSocket. The files on each device stay the source of truth (the folder still works with
Obsidian); the service is the transport and the shared history. The agent runs on **exactly one**
device at a time, the holder of the vault's agent lease.

Status: phase 1. Binary attachments, end-to-end encryption and a Cloudflare Durable Object host are
planned (see [Limitations](#limitations-and-whats-next)).

## How it fits together

```
 device A                                          device B
 vault folder ◀─▶ SyncEngine ◀─▶ RemoteStorageProvider      RemoteStorageProvider ◀─▶ SyncEngine ◀─▶ vault folder
   (local-fs)     (daemon)          │  HTTPS + WebSocket          │                   (daemon)      (local-fs)
                                    ▼                             ▼
                        ┌───────────────── apps/sync ─────────────────┐
                        │ HTTP API (hono) · stream hub (ws) · leases   │
                        │ SQLite (node:sqlite): vaults, files, folders,│
                        │ changes (append-only, seq per vault), leases │
                        └──────────────────────────────────────────────┘
```

- **The sync service is just another StorageProvider.** `RemoteStorageProvider`
  (`packages/storage/src/remote.ts`, `kind: "remote"`) implements the whole provider contract
  over the API and is created only through `createSyncTarget`. The existing `SyncEngine` does the
  syncing unchanged: snapshots with merge bases, three-way merges of markdown, conflict copies,
  conditional writes with retries, the "never delete without a snapshot" rule, and
  `SyncAbortedError` when a side looks wiped. It passes the shared contract suite and a model-based
  comparison with the in-memory reference provider, both against a real server.
- **Live push.** While the engine runs, the provider holds a WebSocket to the vault's change
  stream. A change from another device arrives as a `self: false` storage event, and the engine
  runs a pass after a short quiet period (`targetDebounceMs`, 250 ms by default). With the default
  1.5 s quiet period on the editing device, an edit reaches the other devices in about two seconds.
  The engine's 30 s interval pass remains as a backstop.
- **Catch-up.** The stream reconnects with a capped exponential backoff (0.5 s doubling to 30 s,
  with jitter). After reconnecting, the provider replays the net effect of the changes it missed
  from the change log (`GET …/changes?since=`), so the engine runs a pass for them. Heartbeats
  carry the vault's latest `seq`, so a missed frame is noticed without reconnecting, and the first
  connection catches up on anything that changed between the engine's first listing and the stream
  becoming ready.
- **Echoes.** Every change records the `X-DDL-Device` of the request. The provider already
  reported its own writes (as `self` events) when it made them, so pushes carrying its own device
  id are not repeated.

## The protocol

The types live in `packages/core/src/sync-service.ts`, shared by the server, the storage client and
future native clients (additive changes only within `SYNC_API_VERSION`).

- JSON under `/v1`, over HTTPS in production (the daemon refuses plain `http` unless the server is
  on `localhost`/`127.0.0.1`/`[::1]`).
- Every vault route needs `Authorization: Bearer <token>`. A token authorizes exactly one vault.
  Mutating requests send `X-DDL-Device: <device id>`.
- Paths are canonical vault paths (`normalizePath` output: no `..`, `.`, empty segments, leading
  `/`, backslashes or NUL), percent-encoded per segment in URLs. Anything else is a 400.
- **Revisions** (`rev`) are opaque and unique within a vault (`r<seq>` today). New content gets a
  new rev; identical content keeps it and appends nothing; a rename carries it to the new path.
- **Change log.** Every accepted write, delete and rename appends to the vault's log, in the same
  transaction, under a per-vault `seq` that only grows (a rename appends a deletion and a creation).

| Method and path | Answer |
| --- | --- |
| `GET /v1/health` | `{ ok, apiVersion }` (no auth, nothing about vaults) |
| `GET …/files?prefix=` | `{ files: [{ path, rev, size, hash, mtime }], seq }` (hidden and junk paths included; clients filter) |
| `GET …/files/<path>` | `{ path, rev, size, hash, mtime, content }`, or 404; `?meta=1` omits `content` |
| `PUT …/files/<path>` `{ content, ifMatch? }` | 201 created / 200 `{ path, rev, size, hash, mtime, created, seq }`; 409 `{ error: "conflict", currentRev }` when `ifMatch` (a rev, or `null` = must not exist) doesn't hold |
| `DELETE …/files/<path>?ifMatch=` | 204, 404, or 409 `{ currentRev }` |
| `POST …/rename` `{ from, to }` | 200 (the moved file), 404, 409 (`to` exists or is a folder) |
| `GET …/folders?prefix=` | `{ folders }` |
| `POST …/folders` `{ path }` | 201 created / 200 already there |
| `DELETE …/folders?path=` | `{ deleted: [files] }` (one change per file) |
| `GET …/changes?since=&limit=` | `{ changes: [{ seq, path, rev, deleted, created, device, at }], seq, more }` |
| `GET …/stream` (WebSocket) | frames `ready { seq, heartbeatMs }`, `change { seq, path, rev, deleted, created, device, at }`, `heartbeat { seq, at }` |
| `GET / POST / DELETE …/leases/agent` | see [the agent lease](#the-agent-lease) |

`…` is `/v1/vaults/<vault id>`. Folders behave like folders on a disk: writing a file creates its
folders, they outlive their files until deleted, and a file and a folder can't share a path (409
`not_a_file`, `not_a_folder` or `path_blocked`). Errors are `{ error, message }` with the codes of
`SyncErrorCode`; clients treat unknown codes by their HTTP status.

## Conflicts

The server never merges: it accepts a write only if the client's `ifMatch` still holds, otherwise
it answers 409 with the current rev, and the engine retries that path on its next pass. Merging
happens on the devices, in the engine, exactly as for a local mirror folder
([packages/storage/README.md](../packages/storage/README.md#sync)):

- Edits to different lines of a note on two devices merge cleanly (three-way merge against the
  last synced version); lines both added at the same spot are all kept.
- Edits to the same line: the device that syncs second keeps its own text and saves the other
  device's as `<name> (conflict YYYY-MM-DD HHmm).md`; the copy then syncs to every device, and
  every device lists it under `conflicts` in its sync status until someone deletes it.
- Other formats (JSON such as the agent's thread files, canvases) keep the newest by modification
  time and save the other as the conflict copy. The server stamps `mtime` with its own clock when
  it accepts a write, so compare notes across devices with that in mind.
- A file deleted on one device and edited on another is restored, never lost. Nothing is ever
  deleted without a snapshot entry, so two devices that sync for the first time only add files
  (identical files are recognized; different ones become conflict copies).
- A server whose vault suddenly lists nothing (a replaced database, say) is refused with
  `SyncAbortedError` instead of deleting every note.

What syncs: every text file in the vault, including the agent's sidecar (`.daily-do-list/threads`,
`artifacts`, `state/records.json`, `approvals.json`, `settings.json`). What doesn't: each device's
own sync snapshot (`.daily-do-list/sync/`), the agent's machine-local scratch data
(`.daily-do-list/state/tasks`), junk and temp files, and binary files (images, PDFs, …).

## Security

This repository is public and these are people's notes, so:

- **Tokens.** `vault create` generates 32 random bytes (base64url), prints them once, and stores
  only their SHA-256. Comparisons are constant-time, and an unknown vault is compared against a
  decoy hash so it answers exactly like a wrong token. `vault rotate-token` replaces a token; open
  streams using the old one are closed at the next heartbeat.
- **No enumeration.** A missing token, a wrong token, another vault's token and an unknown vault
  all get the same 401 (same body, same `WWW-Authenticate`), over HTTP and on the WebSocket upgrade.
  Stream close codes say nothing about other vaults. Per-vault `seq` numbers leak nothing about
  other vaults' activity.
- **Input.** Every path is validated (above); request bodies are capped at twice the file limit
  (JSON escaping), files at 5 MiB by default (`--max-file-mb`), each vault at a quota
  (`--max-vault-mb`, default 1 GiB); malformed JSON and unknown fields are 400s. Each vault is
  rate-limited (a token bucket, default 100 requests/s with bursts of 1 000; 429 with
  `Retry-After`, which the client honors). A vault gets at most 32 open streams, and clients can't
  send anything on them.
- **Logs.** The server logs vault ids, routes, statuses and a per-minute request count per vault;
  never tokens, file contents or paths. The daemon never logs the sync token.
- **On devices.** The token lives in `~/.daily-do-list/sync-token` (tightened to 0600 if needed) or
  `DDL_SYNC_TOKEN`, never in `config.json` (the daemon refuses to start if it finds one there) and
  never in the vault.
- **Transport.** Serve on `127.0.0.1` (the default) and put a TLS-terminating proxy in front. The
  daemon refuses plain `http` to anything but this machine.
- **Content is opaque.** The server stores and returns content as sent and never interprets it, so
  end-to-end encryption can be layered on later without protocol changes. **Until then, whoever
  runs the server can read the notes**: host it yourself, or somewhere you trust, and protect the
  database file and its backups.

## Self-hosting

Build once (from a checkout, after `pnpm install`); the result is a single file with every
dependency bundled, runnable with Node 24.4+ alone:

```bash
pnpm --filter @ddl/sync build        # → apps/sync/dist/main.js (+ main.js.map)
```

Create a vault (the token is printed once; `--json` prints `{ "vault", "token" }` for scripts):

```bash
mkdir -p ~/ddl-sync && chmod 700 ~/ddl-sync      # the database holds your notes
node apps/sync/dist/main.js vault create --name "Personal" --db ~/ddl-sync/sync.db
node apps/sync/dist/main.js vault list --db ~/ddl-sync/sync.db
node apps/sync/dist/main.js vault rotate-token --vault <vault id> --db ~/ddl-sync/sync.db
```

Run the server (it binds `127.0.0.1:7332` unless told otherwise):

```bash
node apps/sync/dist/main.js serve --db ~/ddl-sync/sync.db \
  [--host 127.0.0.1] [--port 7332] [--max-file-mb 5] [--max-vault-mb 1024] \
  [--rate 100] [--burst 1000] [--log-level info]
```

To reach it from other devices, put a TLS-terminating reverse proxy in front, for example Caddy:

```
sync.example.com {
    reverse_proxy 127.0.0.1:7332
}
```

Caddy passes WebSocket upgrades through as is; with nginx, forward `Upgrade`/`Connection` headers
and raise `proxy_read_timeout` above the 25 s heartbeat. Run one server process per database (the
database runs in WAL mode with full fsync, so an acknowledged write survives a power cut). Back it
up with `sqlite3 ~/ddl-sync/sync.db ".backup backup.db"` or by copying the files while the server
is stopped. Vaults are administered with the CLI only; there is no admin HTTP endpoint.

## Setting up a device

On each device (the daemon reads these at startup):

```bash
# The token printed by `vault create`, never inside the vault or config.json:
(umask 077 && printf '%s\n' '<token>' > ~/.daily-do-list/sync-token)
```

and in `~/.daily-do-list/config.json`:

```json
{ "sync": { "kind": "remote", "url": "https://sync.example.com", "vault": "<vault id>" } }
```

(or `DDL_SYNC_URL` and `DDL_SYNC_VAULT`, plus `DDL_SYNC_TOKEN`, in the environment). On first use
the daemon creates `~/.daily-do-list/device.json` with a random device id and a name taken from the
host name; edit `name` to change how other devices refer to this one. Don't copy `device.json` to
another machine (see below).

`GET /api/sync/status` on the daemon reports `state`, `target`, `lastSyncedAt`, `pendingChanges`,
`conflicts`, `lastError`, and with the sync service `remoteHost` and `deviceName`.

To try it on one machine, run the server on a spare port and start two daemons with their own
`DDL_HOME`, `DDL_VAULT` and `DDL_PORT` (none of them the ones you use day to day), each pointing at
`http://127.0.0.1:<port>` with the same vault and token.

## The agent lease

Each vault has one `agent` lease on the server. A daemon that syncs with the sync service (and runs
with `DDL_AGENT_MODE` `live` or `mock`) starts its agent only while it holds the lease:

- It asks for the lease at startup and renews it every 20 s (a grant lasts 60 s). While another
  device holds it, it asks again every 15 s and takes over as soon as that device releases it
  (it does when its daemon stops) or stops renewing (it crashed or went offline: at most 60 s).
- Until then this daemon serves notes and syncs as usual, but its agent is off: its agent status
  says `problem: "The agent is running on <device name>."`, it shows the other device's threads,
  approvals and task records read-only as sync brings them in (agent actions answer 503 with that
  problem), and it writes nothing into the agent's sidecar files.
- On takeover it first runs a sync pass, then creates the agent runtime from the vault as it is now
  (threads, records and approvals written by the previous device's agent included). On release it
  stops the runtime (which flushes its state) and runs a sync pass before letting go.
- A device that can't reach the server doesn't start its agent, and a holder that loses contact
  stops its agent 5 s before its grant could run out on the server, so two agents never overlap.
- Renewal needs the same device id **and** the same random per-process session, so a copied
  `device.json` (a cloned home folder, a migrated Mac) can't run a second agent. A daemon that
  crashed and restarted waits for its old grant to run out (up to a minute).

## Limitations and what's next

Phase 1 limitations:

- Binary attachments (images, PDFs) are not synced; the provider API is text-only.
- No end-to-end encryption yet: the server can read what it stores.
- The change log is never compacted, and the quota is server-wide (one value for every vault).
- File names that differ only in case or Unicode normalization across file systems aren't
  reconciled (as with any sync target).
- Devices notice a released lease by asking every 15 s, not by push.
- Only the device that runs the agent acts on agent threads and approvals; the others show them
  read-only and say where the agent runs (a device relaying to the always-on machine acts through
  it, see [ALWAYS_ON.md](./ALWAYS_ON.md#the-agent-relay)).
- No UI yet: the data is in `GET /api/sync/status` and the agent status.

Phase 2:

- Attachments in S3/R2 (content-addressed, referenced from the change log).
- A Cloudflare Durable Object host (one object per vault with its own SQLite, same protocol).
- End-to-end encryption of content and paths.
- Lease changes pushed on the stream; a "run the agent here" handover in the UI.
- Change-log compaction, per-vault quotas, and the sync status in the web and Mac apps; the iOS
  client (the Swift models already decode the sync status).
