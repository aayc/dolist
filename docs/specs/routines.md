# Spec: routines (standing jobs the agent runs on a schedule)

Status: built (`a42bcf3`). How it works: [AGENT_SYSTEM.md](../AGENT_SYSTEM.md#routines); the UI:
[apps/web/README.md](../../apps/web/README.md#routines); journeys J12 and J13 in
[USER_JOURNEYS.md](../USER_JOURNEYS.md).

Decided with the user:

- **Definitions live in the vault**, one markdown file per routine in `Routines/`, so they are
  plain files: editable in Obsidian, synced and versioned. The body is the instructions; the
  frontmatter holds the schedule in natural language, `notify`, `uses` and `paused`. A schedule
  the parser can't read is an error on the routine, never a guess.
- **Each run is a chat thread** under its routine (not in the task inbox), told the previous
  run's result so it can say what's new; with `notify: when changed` only a run that found
  something new notifies.
- **Approvals follow the global approval policy**, including agents creating or editing routine
  files: the user chose no special guard.
- **Creation by saying it** ("every morning, brief me on…" in a note or the orchestrator's chat),
  and **Repeat this** on a finished task's thread, where the user gives the schedule.
- **A missed run catches up once**, not once per missed slot; Run now has a small daily budget and
  every run a time limit; the scheduler's state stays in the sidecar, never in the routine file.
