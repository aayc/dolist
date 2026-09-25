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
| `threads/<threadId>.json` | `packages/agent/src/threads/store.ts` | JSON, compact (a snapshot of the journal) | 1 | yes |
| `state/journal/threads/<threadId>.jsonl` | `packages/agent/src/threads/store.ts` | JSON Lines, append-only | 1 (per line) | yes (merged as a union of lines) |
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
decide what to do with the data. Journals (`*.jsonl`) follow them line by line instead (see
[Thread journal](#thread-journal--statejournalthreadsthreadidjsonl)): every line carries its own
version, a line that can't be read is skipped and reported (never quarantined), and a journal is
never rewritten, only appended to.

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

- Since the [thread journal](#thread-journal--statejournalthreadsthreadidjsonl), this file is a
  snapshot derived from the thread's journal: the store rewrites it from the journal's fold after
  every change (debounced as below), byte for byte what the store wrote before journals existed.
  Readers that don't parse journals (the relay's read-only view, older daemons, every client) keep
  reading it unchanged. When both exist, the journal is the source of truth.
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
  older version is loaded but its own file is still never written (and, without a journal, the
  thread is never journaled either: it runs in memory only, as before).
- External changes are not watched: the in-memory copy stays authoritative until its next write
  (merge) or a restart. An externally deleted file is recreated at the thread's next change.
- Threads whose task no longer exists are kept; replying in one gets a system note instead of
  agent work.

Version history: unversioned (before the contract) → **1**: same shape plus `version`. The legacy
reader defaulted missing `taskId`/`notePath` to `null` and `artifacts`/`surfaces` to `[]`; the
migration does the same.

### Thread journal — `state/journal/threads/<threadId>.jsonl`

The source of truth for one thread: an append-only log of events, one compact JSON object per
line, `\n`-terminated. The thread is the fold of its events; `threads/<threadId>.json` is a
snapshot derived from it. It lives under the agent-owned `state/` folder, so the agent lease's
fencing covers it, and outside `threads/`, so readers of snapshots never see it. Schema:
`packages/contract/src/persisted/thread-journal.ts`.

```text
{ v: 1, id: "evt_…", epoch, seq, at, type, …payload }
```

- **Envelope.** `v` is the event's format version. `id` is unique (the union merge keys on it).
  `epoch` is the agent lease's grant (0 until leases carry one; the store takes it from an
  `epoch()` provider), `seq` grows with every append to the journal. `at` is epoch ms.
- **Order.** Readers sort by `(epoch, seq, id)` (a no-op for a journal one device wrote), so two
  copies merged as a union fold the same way everywhere. A duplicated id counts once (its first
  line).
- **Thread events** (the fold): `thread.created` (`thread`: id, taskId, notePath, title, status,
  createdAt, optional routineId — ignored if the thread already exists), `thread.imported`
  (`thread`: a whole thread in the snapshot's shape, merged in with `mergePersistedThreads`;
  messages the journal trimmed stay trimmed), `message` (added, or replacing the one with its id),
  `status`, `title`, `trim` (`keep` the newest messages), `surface`, `sources` (merged by URL,
  newest kept, capped at 50), `artifact` (metadata; the body is a file as before). `message`,
  `status` and `artifact` move `updatedAt` forward (never back).
- **Agent-state events** (not part of the thread's visible state): `tool.requested` (`call`,
  `tool`, `session`, display-safe `input`), `tool.decided` (`allowed`, `reason`, `via`:
  `evaluator|policy|grant|approval`, `approvalId`), `tool.started` (the write-ahead record: `tool`,
  `target` in words, `approvalId`, `effectful: false` for calls that change nothing),
  `tool.finished` (`outcome`: `ok|error|blocked`, `output`: what the model read, redacted and
  capped at 8 000 characters, kept for subagents only), `tool.interrupted`, `run.prompted`
  (`session`, `text`: a prompt the thread's agent session got, capped at 32 000 characters) and
  `run.text` (the model's final text of one message).
- **Reading.** A line that isn't JSON, isn't an object, has an invalid `v`, an unknown `type` or
  an invalid payload is skipped and reported (`line 7`, never its content); list entries that fail
  (a source) are dropped one by one. A cut-off last line (a crash mid-append) is skipped, and the
  next append starts on a new line. A line with a greater `v` than this build knows means a newer
  app writes this journal: the thread is not loaded and nothing about it is written. A journal
  without a thread event is folded from what follows (a placeholder header) and merged with the
  snapshot.
- **Writing.** Events are appended in batches with the thread's debounced snapshot writes, with
  `StorageProvider.append` (conditional on the version last seen; local-fs versions journals by
  stat, so an append never re-reads the file). Streaming text is journaled once final (a flush
  journals it as it is). Right away: a prompt, and a finished effectful tool call's result. And
  durably, before the call runs: an effectful call's `tool.started`. A journal that changed
  underneath is re-read at the next append, its new events folded in order (the thread emits
  `thread.message` for what it gained), and what wasn't written yet is renumbered after them. One
  that disappeared starts again with a `thread.imported` of the thread in memory.
- **Loading.** The journal wins; each snapshot of the thread (its own file and sync conflict
  copies) is merged in with a `thread.imported` event only if it holds something the journal lacks
  (an older app's changes, text streamed before a crash), and a snapshot that is missing or behind
  the journal is rewritten.
- **Migration.** A thread with only a snapshot is migrated on first load: in memory at once, and
  its journal file is written with the thread's first change, starting with a `thread.imported`
  event holding the thread exactly as loaded. So nothing is written for threads that are only read
  (and no vault-wide burst of writes at the first start), and the migration is lossless: that
  journal alone folds to the same thread.
- **Sync.** The SyncEngine merges a journal that changed on both sides as the union of both
  copies' lines (never a conflict copy); see [SYNC.md](./SYNC.md#conflicts).

Version history: **1** only.

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
  watch?: { pastDays?, futureDays? (0–366) }, actOnExistingTasks?, approvalTimeoutMs? (1 min–30 days),
  approvalPolicy? ("ask_every_action" | "ask_risky" | "ask_high_risk" | "run_everything") } }
```

- **Approval policy:** `agent.approvalPolicy` decides when agents ask before acting (see
  `packages/agent/src/safety/README.md`). Files without it, and files with a policy this version
  doesn't know, load with `ask_risky`, the behavior before the setting existed; an unknown value
  stays in the file. Agents can't write this file: changing anything in `.daily-do-list/` is a hard
  deny of the safety rules.

- **Agent harness:** `agent.harness` picks what runs the agent: `pi` on the OpenRouter
  `agent.model`, or `cursor` (the Cursor CLI) on `agent.cursorModel`. `judgeModel` is an OpenRouter
  model with either harness. Files written before these keys existed have neither and load with
  `pi` and the default Cursor model (`claude-opus-5-5`); a harness this version doesn't know
  (written by a newer app) falls back
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
  this app can use are seeded). A first run with nothing to seed writes no file, so a device
  joining a synced vault pulls the vault's settings rather than replacing them. Newer → defaults apply and updates are refused with an explanation
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

## Drawings — `Excalidraw/<Name>.excalidraw.md` (vault content, owned by @ddl/core)

Drawings are user notes, not sidecar state: plain files in the Obsidian Excalidraw plugin's format,
so the plugin opens ours and we open its. `packages/core/src/drawings/` reads and writes them
(pure; the web app, the daemon and the agent share it) and the Swift engine follows the same rules.
Clients read and write them through the notes API like any note (`readNote`, `writeNote` with
`baseVersion`); there is no drawing route.

- **Names:** new drawings go in `Excalidraw/`, named like the plugin names them in local time
  (`newDrawingName`: `Drawing 2026-09-25 11.52.33`; `drawingPathForName`; `uniqueDrawingPath`
  adds `_0`, `_1`, … like the plugin). `isDrawingPath` checks the name; `isDrawingMarkdown`
  checks the frontmatter, since the plugin can turn any note into a drawing.
- **Layout:** frontmatter with `excalidraw-plugin: parsed` and `tags: [excalidraw]`, the plugin's
  notice line, `# Excalidraw Data`, `## Text Elements` (each text element's text, then
  ` ^<element id>`), optional `## Element Links` and `## Embedded Files`, `%%`, `## Drawing` with
  the scene in a fenced block, `%%`. We write `json` (tab-indented, like the plugin); we read `json`
  and `compressed-json` (LZ-String base64 in 256-character lines, the plugin's default; the
  vendored LZ-String keeps its MIT notice).
- **Scene:** Excalidraw's exported scene (`type: "excalidraw"`, `version: 2`, `source`,
  `elements`, `appState`, `files`). The types model the elements we understand and pass everything
  else through.
- **Round trips:** `serializeDrawingFile(scene, previous)` keeps what it doesn't regenerate:
  frontmatter keys, the text above the drawing data, other sections, and scene, `appState`, file and
  element fields the new scene lacks (an editor that drops fields it doesn't know loses nothing).
  `## Text Elements` is regenerated from the scene.
- **Plugin rules we follow:** `## Text Elements` wins over the scene when they differ (the plugin
  treats it as the truth); `rawText` follows the text once it changes; `source` names the plugin
  version whose format we write (any other value makes the plugin flag every text container as
  legacy-wrapped); new element ids should be 8 characters from `[0-9a-zA-Z]`
  (`newDrawingElementId`), since the plugin re-keys longer text element ids.
- **Unreadable files:** `parseDrawingFile` never throws; a scene it can't read comes back empty with
  `readable: false` and `problems`, and `serializeDrawingFile` refuses to write over it.
- **Embeds:** `![[Name.excalidraw|360|right-wrap]]` — alias, size (`360`, `360x240`, `x240`,
  `50%`) and style (`left`, `right`, `center`, `left-wrap`, `right-wrap`; none is full width), split
  the way the plugin does (`parseDrawingEmbed`, `formatDrawingEmbed`, `findDrawingEmbeds`).
- **Concurrent edits:** `mergeDrawingElements(base, local, remote)` merges two edits of a drawing
  by element id: the newer edit wins (higher `version`, then lower `versionNonce`, Excalidraw's
  rule), and `base` (the file both started from) tells a deletion from an addition, so an element
  one side dropped and the other didn't change is gone while one the other side changed survives.
  Local additions go after the element before them locally; with fractional `index`es on every
  element, the result is sorted by them. Clients save the merge over the newer version.
- **Description:** `describeDrawing(scene, { title })` is the bounded (2 000 code points),
  deterministic text the agent sees for a drawing.
- **Fixtures:** `packages/core/test/drawings/` holds drawings in both forms with their expected
  parse, description and round trip; TypeScript and Swift replay the same files (the contract is
  in its README).

## Golden fixtures

`packages/contract/fixtures/persisted/<format>/`, byte-exact (Biome ignores the folder):

| Name | Meaning | Asserted by |
| --- | --- | --- |
| `v1*.json` | valid current files; `*invalid*` ones contain entries that must be dropped | exact loaded state and repair |
| `legacy-unversioned*.json` | files written before formats carried `version` | exact loaded state, upgrade on next write |
| `corrupt*.json` | must be quarantined byte for byte, never loaded | quarantine path and content |
| `future-version*.json` | written by a newer app: never read or overwritten | file unchanged after running |

`thread-journal/*.jsonl` follows the same naming (`v1*`, `corrupt*`, `future-version*`; journals
have no legacy form): every event type, a migrated thread, two writers out of order, invalid lines
and a cut-off last line, a newer app's line, garbage and an empty file.

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
- Journals are never compacted: a thread's journal grows with the thread (the orchestrator's chat
  trims its messages, not its journal). Compaction needs a marker every device honors, or a union
  would bring compacted events back; it is planned with the agent journal's later phases.
- A sync conflict copy of a journal made by a third-party sync (iCloud Drive, Dropbox) is not
  merged; the snapshot's conflict copy, which is, carries the same messages.
