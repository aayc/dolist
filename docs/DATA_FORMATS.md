# Data formats

Everything the app persists, where it lives, who owns it, and the rules that keep old, new and
other devices' copies compatible. The files in the vault sidecar (`.daily-do-list/`) sync with the
notes (a vault in iCloud Drive, the SyncEngine, S3 later) and the planned iPhone app will read
them, so their formats are a data contract: versioned, validated, backward compatible and robust to
corruption.

- **Schemas:** `packages/contract/src/persisted/` — one zod schema per format with an explicit
  integer `version`, a lenient decoder with migrations, an exact encoder and merge rules, exported
  from `@ddl/contract` with a `Persisted`/`PERSISTED_` prefix (`PERSISTED_FORMATS` lists them).
  The modules are pure and isomorphic, so a native shell or the web app can read the files with the
  same code as the daemon.
- **Loader:** `PersistedFile` (`packages/contract/src/persisted/file.ts`) applies the compatibility
  rules below for every owner.
- **Golden files:** `packages/contract/fixtures/persisted/<format>/` (see
  [Golden fixtures](#golden-fixtures)). They are the compatibility promise: a change that cannot
  load them fails CI.
- **Type lockstep:** tests assert that each schema's type and the TypeScript type the code uses are
  mutually assignable (`packages/contract/test/persisted/types.test.ts`,
  `packages/agent/test/persistence/types.test.ts`), so either side changing alone fails
  `pnpm typecheck`.

## Inventory

### Vault sidecar (`<vault>/.daily-do-list/`)

| Path | Owner | Format | Version | Synced by the SyncEngine |
| --- | --- | --- | --- | --- |
| `threads/<threadId>.json` | `packages/agent/src/threads/store.ts` | JSON, compact | 1 | yes |
| `artifacts/<threadId>/<artifactId>.<ext>` | `packages/agent/src/threads/store.ts` | raw UTF-8 text | — | yes |
| `artifacts/<threadId>/<artifactId>.<ext>.b64` | `packages/agent/src/threads/store.ts` | base64 of the bytes | — | yes |
| `state/tasks/<hash(notePath)>.json` | `packages/agent/src/orchestrator/task-watcher.ts` | JSON, compact | 1 | **no** (excluded in `apps/daemon/src/wiring.ts`) |
| `state/records.json` | `packages/agent/src/orchestrator/records.ts` | JSON, compact | 1 | yes |
| `state/approvals.json` | `packages/agent/src/safety/approval-store.ts` | JSON, pretty | 1 | yes |
| `settings.json` | `apps/daemon/src/settings-store.ts` | JSON, pretty, user-editable | 1 | yes |
| `corrupt/…` | `PersistedFile` (all owners) | copies / moved originals | — | yes |
| `sync/<targetId>.json` | `packages/storage/src/sync/snapshot.ts` | JSON | `format: 1` | **never** (per device) |

"Synced by the SyncEngine" is about the app's own sync. A vault that lives in a synced folder
(iCloud Drive, Dropbox) carries *every* sidecar file, including the ones marked "no", so readers
must treat all of them as possibly written by another device or app version.

### App home (`$DDL_HOME`, default `~/.daily-do-list/`, machine-local, never synced)

Owned by other slices; listed so the inventory is complete.

| Path | What | Owner |
| --- | --- | --- |
| `config.json` | Daemon config: vault path, port, agent mode, model, sync target, execution provider, allowed origins, log level | `apps/daemon/src/config.ts` |
| `daemon-token` | Bearer token, 64 hex chars + newline, mode `0600` | `apps/daemon/src/token.ts` |
| `.env` | Secrets such as `OPENROUTER_API_KEY` | `apps/daemon/src/env-file.ts` |
| `mcp.json` | MCP connectors (`{ "mcpServers": { … } }`) | `packages/connectors` |
| `pi/` | Pi harness agent dir (`auth.json`, `models.json`); sessions are in memory | `packages/agent/src/harness/pi/` |
| `workspaces/<key>/` | Per-task scratch folders, mode `0700` | `packages/agent/src/execution/local/workspace.ts` |
| `browser-profile/` | The agent browser's profile (cookies, logins), mode `0700` | `packages/agent/src/execution/local/provider.ts` |

## Compatibility rules

These apply to every JSON file in the sidecar. `PersistedFile` implements them; owners only
decide what to do with the data.

1. **Every file carries `version`**, a positive integer. The current version is what this build
   writes (`PERSISTED_THREAD_VERSION`, …).
2. **Read old.** A file without `version` is a legacy file: it is upgraded in memory to version 1
   by the format's `migrateUnversioned`, then like any older version by one migration step per
   version (`migrations[n]`: n → n+1). The upgraded shape is written back only when the owner next
   writes the file for its own reasons.
3. **Never overwrite newer.** A file whose `version` is greater than this build knows was written
   by a newer app (on another device, or before a downgrade). It is not read, not moved and never
   written this run; the owner runs without it (see each format). This holds for files that turn
   newer while the daemon runs: every write is conditional (below), so it is detected first.
4. **Quarantine corrupt.** An empty file, invalid JSON (truncated, garbage), a top level that is
   not an object, an invalid `version` (`0`, `"1"`, `1.5`) or invalid top-level fields make the
   file corrupt. It is moved with `rename` to `.daily-do-list/corrupt/<path inside the sidecar>`
   with a UTC timestamp before the extension, for example
   `threads/thr_a.json` → `corrupt/threads/thr_a.20260923T215800123Z.json` (`-2`, `-3`, … on
   collisions). `rename` keeps the exact bytes, even invalid UTF-8. The owner then treats the file
   as absent. If the move fails, the file is never written this run, so the evidence survives.
5. **Salvage entries, keep evidence.** Invalid entries of a list or map (a message, a record, a
   grant, a tracked task) are dropped one by one and reported. Right before the first write that
   replaces such a file, its original is copied into `corrupt/` the same way; if that copy fails,
   the file is not rewritten. A file that is never rewritten is never copied.
6. **Unknown fields** in a known version are tolerated on read. The agent's state files are
   rewritten from their schema, so unknown fields are **dropped** on the next write.
   `settings.json` is patched in place and **keeps** unknown keys and values it cannot use.
7. **Writes are atomic and conditional.** Owners always write whole files; atomicity is the
   provider's job (LocalFs writes a temp file, fsyncs and renames; the memory provider is atomic;
   S3 PUTs are atomic). Each write passes `ifMatch` with the content version last read or written.
   A conflict means someone else changed the file: it is re-read and classified again (newer →
   stop writing, corrupt → quarantine, valid → the owner merges or overwrites, see each format),
   then written again (up to 4 attempts; after that the save fails and the owner's usual retry
   applies).
8. **Readers are total.** Decoders never throw, whatever the bytes. Problems they report contain
   paths and expectations only, never file content, so they are safe to log.
9. **Encoding.** UTF-8 JSON. A leading byte order mark and CRLF line endings are accepted on read
   and never written. Writers end files with a newline. Timestamps are epoch milliseconds (any
   finite number is accepted; writers produce integers). Dates are local calendar dates
   `YYYY-MM-DD`. Line numbers are 0-based.

### When to bump a version

Bump the format's version (and add a migration step plus fixtures) for any change an older reader
would get wrong or silently drop: a new enum value (message kind, task status, risk level,
category, …), a changed type or meaning, a renamed or removed field, a new required field, or a new
field that must survive an older app rewriting the file. Optional additions that are harmless to
lose may skip the bump. Older apps then leave the file alone (rule 3) instead of damaging it.

## Formats

### Thread — `threads/<threadId>.json`

One agent thread: the conversation attached to a to-do item.

```text
{ version: 1, id, taskId: string|null, notePath: string|null, title, status: TaskAgentStatus,
  createdAt, updatedAt, messages: ThreadMessage[], artifacts: ArtifactMeta[], surfaces: ("browser"|"computer")[] }
```

- `id` must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`: it becomes the file name and the artifact
  folder, so a crafted id cannot redirect writes (it used to be possible to save a thread over
  `state/records.json`).
- Messages are a union on `kind`: `text` (`role`, `text`, optional `streaming`), `tool_call`
  (`toolCallId`, `toolName`, optional `label`, `input` as JSON — absent when the call had none,
  `status: running|ok|error|blocked`, optional `resultPreview`, `endedAt`), `approval`
  (`approvalId`), `artifact` (`artifactId`), `status` (`status`, optional `text`). Every message has
  `id`, `author` (`you`, `orchestrator`, `system` or `subagent:<name>`) and `createdAt`.
- `ArtifactMeta`: `id`, `threadId`, `title`, `kind` (`markdown|code|html|image|json|text|file`),
  `mimeType`, optional `language`, `path`, `size` (bytes), `createdAt`. `path` must be a clean path
  under `.daily-do-list/artifacts/` (readers refuse anything else, so metadata cannot point at a
  note or at other state).
- Readers treat a message saved with `streaming: true` as finished (its writer died mid-stream).
- Duplicate message or artifact ids are replayed as upserts: first position, last copy.

Behavior of the thread store:

- Only direct children of `threads/` ending in `.json` are read. A file named like an id
  (`thr_a.json`) must contain that thread, or it is quarantined. Other names, such as a sync
  conflict copy `thr_a (conflict 2026-09-23 1830).json`, are merged into the thread they contain;
  the merged thread is written back to its own file and the copy is left in place.
- Merging (`mergePersistedThreads`) never loses anything: messages and artifacts are unioned by id
  (ours wins for an id present on both sides; entries only on the other side are interleaved by
  `createdAt`), surfaces are unioned, and title/status/taskId/notePath come from the copy updated
  last. It is idempotent.
- Writes are debounced (400 ms; streaming deltas never schedule one) and chained per thread. If the
  file changed underneath (another device), the store merges it, emits `thread.message` for the
  messages it gained, and writes the union.
- A thread whose file is from a newer app is not loaded and never written; a copy of it with an
  older version is loaded but its own file is still never written.
- External changes are not watched: the in-memory copy stays authoritative until its next write
  (merge) or a restart. An externally deleted file is recreated at the thread's next change.
- Threads whose task no longer exists are kept; replying in one gets a system note instead of
  agent work.

Version history: unversioned (before the contract) → **1**: same shape plus `version`. The legacy
reader defaulted missing `taskId`/`notePath` to `null` and `artifacts`/`surfaces` to `[]`; the
migration does the same.

### Artifact bodies — `artifacts/<threadId>/<artifactId>.<ext>[.b64]`

Not JSON. Text artifacts are stored as their UTF-8 text. Binary artifacts (the storage API is
text-only) are stored as standard padded base64 (RFC 4648 §4) on one line, under an extra `.b64`
suffix; readers also accept line breaks and missing padding, and return nothing (with a warning)
for a body that is not base64 instead of decoding garbage. The extension comes from the kind,
language or MIME type (`artifactExtension`). The body is written before its metadata, so a crash
can leave a body without metadata (ignored, never deleted) but not metadata without a body; if a
body is missing anyway, reading the artifact returns nothing.

### Tracker state — `state/tasks/<hash(notePath)>.json`

The task watcher's identity tracking for one daily note (`hash` is `hashString` from `@ddl/core`).

```text
{ version: 1, notePath, contentVersion: string|null, tasks: TrackedTask[],
  settled: { [taskId]: { task: TrackedTask, announced: boolean } } }
```

`TrackedTask`: `id`, `text`, `status` (`open|done|in_progress|cancelled|deferred|other`), `line`,
`depth`, `parentId`, `notes: string[]`, `firstSeenAt`, `updatedAt`. `settled` keys must equal
`task.id`; `notePath` must equal the note it is loaded for.

- Corrupt state, or state recorded for another note, is quarantined. A file from a newer app is
  left alone and never written. In both cases the note is not new, so its current tasks are
  baselined as already known (as without `actOnExistingTasks`) instead of being acted on again
  under fresh ids; later edits are detected against that baseline. (Previously a corrupt file
  made the watcher redo every open task of the note.)
- Writes are debounced (300 ms); a concurrent valid change is overwritten (the state is this
  machine's scratch data).
- State is keyed by note path. Renaming or moving daily notes (or changing the daily-note folder or
  format) starts fresh tracking for the moved notes, governed by `actOnExistingTasks`; the old
  state files stay where they are. It assumes one daemon per vault: two machines running the
  daemon on one synced vault overwrite each other's tracker state.

Version history: **1** only (files without `version` are read as version 1).

### Task records — `state/records.json`

The agent badge state of every task plus the last subagent spec per task (so Retry survives
restarts).

```text
{ version: 1, records: TaskAgentRecord[], specs: { [taskId]: SubagentSpec } }
```

`TaskAgentRecord`: `taskId`, `notePath`, `date` (`YYYY-MM-DD` or `null`), `text`, `line`, `status`
(`TaskAgentStatus`), optional `summary`, `threadId` (or `null`), `updatedAt`, `unread`.
`SubagentSpec`: `taskId` (equal to its key), `goal`, optional `instructions`, `capabilities`
(`web|browser|computer|shell|files|connectors`).

- Corrupt → quarantined, records start empty and the next save writes a fresh file. Newer → left
  alone, records live in memory only this run. A read error at startup is retried at the first
  save, which merges the file instead of overwriting it.
- On load, inactive records untouched for 60 days are dropped, as are specs without a record.
  Records of notes that no longer exist are kept until then.
- A concurrent change is merged (`mergePersistedRecords`): union by task id, the record updated
  last wins, specs only on the other side are added. Deletions are not tracked, so a removed
  record can come back from another copy (harmless: records of tasks that are not in any note are
  never shown).

Version history: **1** only. The writer always wrote `version: 1`; files without it are read with
the defaults the old reader applied (`date`/`threadId` → `null`, `unread` → `0`).

### Approvals — `state/approvals.json`

Standing grants ("approve for this task", "always approve") plus pending and the 200 most recently
decided approvals.

```text
{ version: 1, grants: ApprovalGrant[], approvals: ApprovalRequest[] }
```

`ApprovalGrant`: `toolName`, `scope` (`task|always`), `taskId` (required for `task`, normalized to
`null` for `always`), `createdAt`, optional `categories` (the grant covers only calls whose
categories are all listed), optional `risk` (the grant does not cover riskier calls).
`ApprovalRequest`: `id`, `threadId`, `taskId`, `toolName`, optional `toolLabel`, `input`, `summary`,
`risk`, `categories`, `reason`, `status` (`pending|approved|denied|expired|cancelled`), optional
`scope`, `decisionNote`, `decidedAt`, `expiresAt`, and `createdAt`.

- Grants widen what agents may do without asking, so a grant with an unknown risk level or
  category, malformed `categories`, or a task grant without a task is dropped, never repaired into
  something broader. (The old parser kept such grants without their `risk`/`categories`, which made
  them cover every risk level or category.)
- Approvals left pending by a previous process load as `expired` ("The app restarted before a
  decision was made.") and the file is rewritten.
- Corrupt or newer files are ignored by the broker. `createApprovalStateFile` applies the full
  rules (quarantine, never overwrite newer, conditional writes with `mergeApprovalStates`: union,
  a decided copy beats a pending one); the broker in `safety/approvals.ts` still reads and writes
  the file directly until it switches to it (tracked by `it.fails` tests in
  `packages/agent/test/persistence/approvals.test.ts`).

Version history: **1** only. The writer always wrote `version: 1`; files without it are accepted.

### Settings — `settings.json`

The user's explicit `AppSettings` overrides (a deep partial), merged over the defaults (which
include `DDL_MODEL` from the daemon config).

```text
{ version: 1, theme?, editor?: { vimMode?, vimrc? (≤16384), livePreview?, readableLineLength?,
  fontSize? (8–48), spellcheck?, showLineNumbers? }, dailyNotes?/weeklyNotes?: { folder? (≤512), format? (≤128),
  template? (≤512) }, agent?: { enabled?, settleMs? (0–120000), maxConcurrentSubagents? (1–32),
  harness? ("pi" | "cursor"), model?, cursorModel?, judgeModel? (1–200 chars, trimmed),
  watch?: { pastDays?, futureDays? (0–366) }, actOnExistingTasks?, approvalTimeoutMs? (1 min–30 days) } }
```

- **Agent harness:** `agent.harness` picks what runs the agent: `pi` on the OpenRouter
  `agent.model`, or `cursor` (the Cursor CLI) on `agent.cursorModel`. `judgeModel` is an OpenRouter
  model with either harness. Files written before these keys existed have neither and load with
  `pi` and `composer-2.5`; a harness this version doesn't know (written by a newer app) falls back
  to `pi` like any other invalid value, and stays in the file.

- **Per-field fallback:** each stored value is validated on its own; an invalid one falls back to
  its default and is reported, the rest of the file still applies. Daily/weekly note settings
  that together would put notes in a hidden folder or outside the vault fall back as a section.
  A bad hand edit in one section never blocks updates to another.
- **Patched in place:** an update re-reads the file, changes only the fields it sets, and writes
  it back conditionally. Unknown keys (settings a newer app added) and invalid values survive, and
  a change synced from another device while the daemon runs is kept. Updates are validated
  (values and keys) even without the HTTP schema in front of the store; the ranges match
  `PUT /api/settings` (a test compares both).
- Corrupt → quarantined, and settings start over as on first run (seeded from the vault's Obsidian
  config: `.obsidian/daily-notes.json`, `app.json`, `appearance.json`, BOM tolerated; only values
  this app can use are seeded). Newer → defaults apply and updates are refused with an explanation
  until the app is updated. A read error at startup no longer stops the daemon: defaults apply and
  the first update re-reads the file.
- External edits otherwise apply on the next start (the store does not watch the file).

Version history: unversioned (before the contract) → **1**: same object plus `version`, added on
the next write.

### Quarantine — `corrupt/`

Created by `PersistedFile`: moved corrupt originals and copies of partly invalid files, mirroring
their path inside the sidecar with a UTC timestamp (`corrupt/state/records.20260923T120000000Z.json`).
Nothing reads or deletes these files; they are there for a human (or a future repair tool) to
inspect and restore. Moving a file also syncs as its deletion.

### Sync snapshot — `sync/<targetId>.json` (owned by @ddl/storage)

The SyncEngine's per-device record of the last synced state:
`{ format: 1, targetId, savedAt, entries: { [path]: { p, t, b? } }, conflicts: string[] }` (`p`/`t`:
primary/target versions, `b`: merge base for text up to 256 KiB). It is never synced, and a
snapshot that is unreadable or belongs to another target is ignored (a full re-sync). It predates
this contract and uses `format` rather than `version`.

## Golden fixtures

`packages/contract/fixtures/persisted/<format>/`, byte-exact (Biome ignores the folder):

| Name | Meaning | Asserted by |
| --- | --- | --- |
| `v1*.json` | valid current files; `*invalid*` ones contain entries that must be dropped | exact loaded state and repair |
| `legacy-unversioned*.json` | files written before formats carried `version` | exact loaded state, upgrade on next write |
| `corrupt*.json` | must be quarantined byte for byte, never loaded | quarantine path and content |
| `future-version*.json` | written by a newer app: never read or overwritten | file unchanged after running |

`artifacts/` holds the bodies `threads/v1.json` points at (one deliberately missing, one orphan).
Every fixture is decoded by `packages/contract/test/persisted/fixtures.test.ts` and loaded through
the real owner in `packages/agent/test/persistence/*.test.ts` (thread store, task records,
approval broker, task watcher) and `apps/daemon/src/settings-store.test.ts`.

Never edit an existing fixture to make a change pass: add a new one (for example `v2.json`) and
keep the old ones loading.

## Changing a format

1. Change the schema in `packages/contract/src/persisted/<format>.ts`, bump its version and add a
   `migrations[old]` step (keep `migrateUnversioned`).
2. Update the TypeScript type and the owner in the same change; the lockstep tests fail otherwise.
3. Add fixtures for the new version and a test that the previous version's fixtures migrate to
   the expected state.
4. Update this document (schema summary and version history).

## Known limitations

- Threads and settings are not reloaded live when another device changes them; changes merge at
  the next write or apply on restart.
- Sync conflict copies of single-file state (`records (conflict …).json`, `approvals`, `settings`)
  are left for the user; only thread conflict copies are merged.
- The approval broker does not use `createApprovalStateFile` yet (see Approvals).
