# Specs

Implementation specs for work split across parallel streams (one branch and worktree each, merged
by one lead). A spec holds what was decided with the user, the exact wire contract when there is
one, each stream's scope, and the environment rules for agents working next to a running app.
`PROGRESS.md` (at the repo root) says which specs are in flight and where each stream stands.

- [routines.md](./routines.md): standing jobs the agent runs on a schedule.
- [always-on.md](./always-on.md): the agent anywhere — an always-on machine, placement per
  device, pairing, fencing, the relay and Settings (design: [docs/ALWAYS_ON.md](../ALWAYS_ON.md)).
- [drawings.md](./drawings.md): Excalidraw-compatible drawings anchored in notes, text flowing
  around them; the real Excalidraw on the web, a native engine on the Mac; the agent sees them.
- [obsidian-migration.md](./obsidian-migration.md): moving from Obsidian — the editor merge-race
  fix, Import from Obsidian (copy, report first, carry-over, update), attachments, display gaps.
- [agent-journal.md](./agent-journal.md) (draft): append-only agent state, write-ahead for side
  effects, resuming runs after a handover.
