# Spec: the agent journal

Status: **phase 1 (threads) built** (`dffdfdd`; see
[Phase 1: what was built](#phase-1-what-was-built)). **Phase 2 started:** threads are journal-only
(no more snapshots, see [Phase 2: journal-only threads](#phase-2-journal-only-threads)); approvals,
routines and client ids are next. Fencing, its prerequisite, shipped with the always-on work
(`7ce1e9f`; [always-on.md](./always-on.md), "Fencing"), and the daemon passes the lease epoch to
the journal.

## Why

The agent moves between machines (placement per device, [docs/ALWAYS_ON.md](../ALWAYS_ON.md)).
Today its state is whole JSON files rewritten in place (a thread per file, approvals, records and
routines state as single files); two writers resolve by "newest wins" plus a conflict copy, a run
in progress stops at handover, and a routine can run twice if its start didn't sync. Temporal was
considered and rejected (2026-09-25): a central server and database every device would depend on,
workflow histories outside the vault, and replay needs deterministic code with every side effect
as an activity, while our agent loop lives inside the harness.

## Design

- **Append-only events** with unique ids and `(epoch, seq)` from the lease grant: messages, tool
  calls and results, approvals requested and decided, routine runs scheduled, started and
  finished, thread status changes. Stored as JSONL in the sidecar (for example
  `.daily-do-list/state/journal/threads/<threadId>.jsonl`); current state is a fold of the
  events.
- **Merging is a union** by event id: appends from different machines never produce conflict
  copies (the sync engine gets a JSONL merge rule). Fencing keeps a former holder from appending
  under an old grant.
- **Write-ahead for side effects:** before a tool runs, append "about to run" (tool, target, its
  approval); after, append the result. A new holder never redoes a finished step; a step with
  "about to run" and no result is uncertain and is **never re-run automatically**: the thread
  shows "Interrupted during: …" and the user decides. Side effects happen at most once.
- **Resume, don't stop:** after a handover the new holder rebuilds the harness session from the
  journal (the transcript and tool results) and continues the run.
- **Idempotency:** every mutation that crosses the relay carries a client-generated id (messages,
  approval decisions, Run now), so retries apply once.
- **Routines:** "run started" is journaled before the run begins, so catch-up after a handover sees
  it and doesn't start a second run.
- **Migration:** existing thread files are read once and converted; the old files stayed
  readable (phase 1) until the snapshots were dropped (phase 2).

## Phases

**Phase 1 (threads), built**, from `main` after routines, in parallel with the always-on streams:

- The journal is the source of truth for threads; `ThreadStore`'s public API stays the same, so
  the orchestrator, subagents, routes and clients don't change.
- **The thread file (`.daily-do-list/threads/<id>.json`) was still written, as a snapshot derived
  from the journal** (until phase 2). The relay's read-only view (always-on S3), older daemons and
  every client kept reading it unchanged.
- The sync engine merges journal files as a union of lines by event id (never a conflict copy);
  the snapshot stayed last-writer-wins, and fencing (always-on S2) keeps former holders out.
- Write-ahead around tool calls; an unfinished side effect becomes "Interrupted during: …" and is
  never re-run automatically.
- Resume after a restart of the agent runtime (the same code path a handover will use).
- Migration: existing thread files become journals on first load; nothing is lost.

**Phase 2 (the always-on work it waited for has merged):** threads journal-only (built),
approvals and routines state on the journal, and client-generated ids for idempotent mutations
through the relay (an additive wire change).

## Phase 1: what was built

Docs: [AGENT_SYSTEM.md](../AGENT_SYSTEM.md#the-journal-write-ahead-interrupted-steps-and-resuming)
(write-ahead, interrupted steps, resuming) and
[DATA_FORMATS.md](../DATA_FORMATS.md#thread-journal--statejournalthreadsthreadidjsonl) (the format).

Decisions, beyond the design above:

- **Where.** `.daily-do-list/state/journal/threads/<threadId>.jsonl`: under the agent-owned
  `state/` folder, so fencing covers it without a new prefix in `AGENT_OWNED_PREFIXES`, and outside
  `threads/`, so a reader of snapshots (older apps) never sees a journal there. Phase 2's journals
  go next to it in `state/journal/`; the sync rule and local-fs's stat versions key on that folder.
- **Format.** One compact JSON event per line, each with `v: 1`, an `evt_…` id, `(epoch, seq)` and
  `at`; readers order by `(epoch, seq, id)`. The epoch comes from a provider
  (`AgentRuntimeOptions.leaseEpoch`, 0 until the lease carries one). A bad line is skipped and
  reported; a line with a newer `v` leaves the whole thread alone. Registered in
  `PERSISTED_FORMATS` with golden fixtures.
- **Snapshots** (until phase 2). Written from the fold, byte for byte what the old store wrote (a
  property test ran the old store, kept as an oracle, against the new one). On load, a snapshot was
  merged into
  the journal (`thread.imported`) only when it held something the journal lacked: an app version
  without the journal writing the same vault, text streamed before a crash, a sync conflict copy.
  Messages the journal trimmed stay trimmed.
- **Migration** was on first load, in memory; the journal file was written with the thread's first
  change, starting with a `thread.imported` event holding the thread as loaded. Phase 2 replaced
  it (below).
- **Appends** use an optional `StorageProvider.append` (local-fs, memory); journals are versioned
  by stat on local-fs, so an append costs its flush, not the journal's length.
- **Write-ahead** is a harness decorator around every harness, so it covers Pi, the Cursor CLI and
  the scripted harness alike, and the orchestrator as well as subagents. "About to run" is durable
  before the call for effectful calls only (the evaluator's `effectful`), since a read can safely
  be redone; its target is the evaluator's summary. The gate reports how it allowed a call through
  an `onAllowed` hook, and its decision is passed on unchanged.
- **Uncertain steps don't resume.** A run whose last step may or may not have happened is shown as
  interrupted ("Interrupted during: …") and waits for the user; Retry lists those steps for the
  agent to check, and asks through the gate again. Everything else resumes by itself.
- **Resume** rebuilds the last session from the journal (prompts, the model's text — `run.text` —,
  tool calls and results) and keeps its session id across restores. Pi restores it as message
  history. The Cursor CLI can't be given messages over ACP and its session store is cleaned when
  the harness starts, so the conversation leads the first prompt as text; a session that can't be
  restored at all is interrupted, to retry. Approvals left pending are cancelled at restart and
  asked again. A routine's run is adopted by the scheduler with a fresh time limit. The
  orchestrator's own turn isn't resumed (its tasks are triaged again, as before).

Left for later (phase 2 or after):

- Approvals and routines state on the journal (with "run started" before a run begins), and
  client-generated ids for mutations through the relay.
- Compaction: journals grow with their thread (the orchestrator's chat most). Compacting needs a
  marker every device honors, or a union brings compacted events back.
- Resuming the orchestrator's turn, and a Cursor session restored natively if ACP learns to seed
  one.

## Phase 2: journal-only threads

The snapshots existed so the relay's read-only view, older daemons and clients could keep reading
threads unchanged. Clients read threads through the daemon's API, and the read-only view now folds
journals, so the store stops writing `threads/<id>.json`: every reader folds the journal
(`foldJournal`), and the snapshot merge logic, the old store kept as an oracle and its interop
tests are gone.

- **Migration, once per file, at every load** (`packages/agent/src/threads/journal/migrate.ts`,
  run by `ThreadStore.load` before it reads journals, so only the lease holder writes). For each
  thread with snapshots (its own file and sync conflict copies), the events it lacks are planned
  exactly as the phase 1 store merged them on load: fold the journal, then for each snapshot in
  merge order (own file, then copies from the most recently updated), a `thread.imported` event if
  the snapshot holds something the fold lacks. The events are appended, the journal is read back,
  and planning again must find nothing missing; only then is the snapshot deleted.
- **Why it's safe.** `thread.imported` is an existing v1 event, so phase 1 daemons fold the
  migrated journals too. Each event's id is a hash of the snapshot's content (key order aside) and
  its `(epoch, seq)` follows the journal it's appended to, so two devices migrating the same files
  at once write identical lines, which the union merge keeps once; an event already in the journal
  counts as held. Appends and deletes are conditional: a snapshot rewritten meanwhile stays for the
  next load, and a crash between the append and the delete leaves a snapshot that the next load
  removes without appending anything. Unreadable snapshots and ones a newer app wrote are left
  untouched and reported, a partly invalid one is copied into `corrupt/` before it goes, and
  nothing is written to a journal a newer app wrote (nor a journal started for a thread whose own
  snapshot a newer app wrote).
- **Deleted, not left ignored.** A snapshot left in place would go stale and be re-examined at
  every start. A phase 1 daemon that later holds the lease rewrites snapshots from the journal (so
  they hold nothing new) and keeps appending to the journal; the next load here finds nothing to
  import and deletes them again. Nothing an older daemon writes can replace a journal (journals are
  never rewritten) or bring back what it lost: trimmed messages stay trimmed.
- **Journal conflict copies** a third-party sync made (`thr_a 2.jsonl`), which the snapshot's
  conflict copy used to cover, are merged the same way: their events the journal lacks are
  appended as they are (the union the SyncEngine makes), then the copy goes.
- **The import** from Obsidian writes each old-vault thread as a journal, migrating its snapshots
  on the way with the same planner, then remapping note paths and routine ids.
- **Upgrade note.** A device on an older version shows another device's threads read-only from
  snapshots, which aren't written any more: upgrade every device together (as fencing already
  requires). The snapshot decoder (`decodePersistedThread`) stays only for the migration.

## Open questions

- Journal compaction.
- Whether artifacts stay as files next to the journal (yes in phase 1: the journal holds their
  metadata).
- ~~How much of a run can resume inside the Cursor CLI harness~~: phase 1 restores it as text in a
  new session's first prompt (above).
