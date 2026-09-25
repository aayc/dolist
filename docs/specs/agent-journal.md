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

## Open questions

- Snapshot cadence and journal compaction.
- Whether artifacts stay as files next to the journal (probably yes).
- How much of a run can resume inside the Cursor CLI harness, which keeps its own session state.
