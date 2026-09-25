# Spec (draft): the agent journal

Status: not started. It begins right after routines lands on `main` (it reworks the thread,
approval and routine state routines just changed). Fencing, its prerequisite, ships with the
always-on work ([always-on.md](./always-on.md), "Fencing").

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
  `.daily-do-list/journal/threads/<threadId>.jsonl`); current state is a fold of the events, with
  snapshots for speed.
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
- **Migration:** existing thread files are read once and converted; the old files stay readable
  until every device runs the journal.

## Phases

**Phase 1 (threads), now**, from `main` after routines, in parallel with the always-on streams:

- The journal is the source of truth for threads; `ThreadStore`'s public API stays the same, so
  the orchestrator, subagents, routes and clients don't change.
- **Today's thread file (`.daily-do-list/threads/<id>.json`) is still written, as a snapshot
  derived from the journal.** The relay's read-only view (always-on S3), older daemons and every
  client keep reading it unchanged; readers never parse the journal.
- The sync engine merges journal files as a union of lines by event id (never a conflict copy);
  the snapshot stays last-writer-wins, and fencing (always-on S2) keeps former holders out.
- Write-ahead around tool calls; an unfinished side effect becomes "Interrupted during: …" and is
  never re-run automatically.
- Resume after a restart of the agent runtime (the same code path a handover will use).
- Migration: existing thread files become journals on first load; nothing is lost.

**Phase 2, after the always-on work merges:** approvals and routines state on the journal, and
client-generated ids for idempotent mutations through the relay (an additive wire change).

## Open questions

- Snapshot cadence and journal compaction.
- Whether artifacts stay as files next to the journal (probably yes).
- How much of a run can resume inside the Cursor CLI harness, which keeps its own session state.
