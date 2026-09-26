# Spec: the agent journal

Status: **phase 1 (threads) built** (`dffdfdd`), and threads are journal-only (the first part of
phase 2). Approvals, routines state and client ids are next. Fencing, its prerequisite, shipped
with the always-on work (`7ce1e9f`, see [SYNC.md](../SYNC.md#fencing)), and the daemon passes the
lease epoch to the journal.

## Why

The agent moves between machines (placement per device, [docs/ALWAYS_ON.md](../ALWAYS_ON.md)).
Its state was whole JSON files rewritten in place (a thread per file, approvals, records and
routines state as single files): two writers resolve by "newest wins" plus a conflict copy, a run
in progress stopped at handover, and a routine can run twice if its start didn't sync. Temporal was
considered and rejected (2026-09-25): a central server and database every device would depend on,
workflow histories outside the vault, and replay needs deterministic code with every side effect
as an activity, while our agent loop lives inside the harness.

## Design

- **Append-only events** with unique ids and `(epoch, seq)` from the lease grant: messages, tool
  calls and results, approvals requested and decided, routine runs scheduled, started and
  finished, thread status changes. Stored as JSONL in the sidecar under `state/journal/`; current
  state is a fold of the events.
- **Merging is a union** by event id: appends from different machines never produce conflict
  copies. Fencing keeps a former holder from appending under an old grant.
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

## Built

Threads: the format, where it lives and why, the migration of old snapshots and the sync rule are
in [DATA_FORMATS.md](../DATA_FORMATS.md#thread-journal--statejournalthreadsthreadidjsonl);
write-ahead, interrupted steps and resuming (Pi natively, the Cursor CLI from a text transcript)
in [AGENT_SYSTEM.md](../AGENT_SYSTEM.md#the-journal-write-ahead-interrupted-steps-and-resuming).
Decisions beyond the design: write-ahead is a harness decorator, so it covers every harness and
the orchestrator as well as subagents; "about to run" is durable before the call only for
effectful calls (a read can be redone); approvals left pending at a restart are asked again; the
orchestrator's own turn isn't resumed (its tasks are triaged again). Threads are journal-only: a
device on an older version shows another device's threads read-only from snapshots, which aren't
written any more, so every device upgrades together (as fencing already requires).

## Phase 2: what's left

- Approvals and routines state on the journal (with "run started" before a run begins), and
  client-generated ids for idempotent mutations through the relay (an additive wire change).
- Compaction: journals grow with their thread (the orchestrator's chat most). Compacting needs a
  marker every device honors, or a union brings compacted events back.
- Resuming the orchestrator's turn, and a Cursor session restored natively if ACP learns to seed
  one.

## Open questions

- Journal compaction.
- Whether artifacts stay as files next to the journal (yes in phase 1: the journal holds their
  metadata).
