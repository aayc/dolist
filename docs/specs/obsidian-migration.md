# Spec: moving from Obsidian

Status: M (the merge race, `6750f36`) and I0/I1 (Import from Obsidian, `e2fd3ce`) built; B0 and P
not started.

Read `AGENTS.md` first (invariants: plain files, soft deletes, agents never silently change the
user's words, time is local, wire changes in core + contract + Swift together, the keystroke
path). Related: `docs/SYNC.md`, `docs/DATA_FORMATS.md`, `packages/editor/README.md`,
`docs/specs/drawings.md` (embeds).

## Decided with the user (2026-09-25)

- The user is switching from Obsidian (synced with Obsidian Sync). **They copy the vault; they
  don't share the folder** — no double sync. Their Obsidian vault is only ever read.
- Build all of: the editor merge-race fix, an import flow with a report first, carrying over the
  current Daily Do List notes, routines and agent history, the display gaps (images, tables,
  callouts, a backlinks panel), and syncing images and PDFs between devices.

## Streams

### M — the editor merge race (data safety; first)

An open editor re-saved lines that were deleted outside it about 10 s after an agent edit (seen in
a rehearsal: a deleted task came back and the orchestrator ran it again). Find the cause in both
editors (web: the editor's merge of external and agent changes into unsaved typing, `mergeText`,
debounced saves with `baseVersion`; Mac: `MergeEdits`, `NotesStore`, `SaveState`), write failing
regression tests that reproduce it (an external delete while the editor is open and clean, and
while it has unsaved typing; an agent edit followed by an external delete), fix it, and add a
property test: an editor that has no unsaved typing never writes content the vault didn't have.

### I0 — Import from Obsidian (engine, daemon)

- `POST /api/import/obsidian/preview { source }` → a report, without writing anything: notes,
  folders, attachments by type and total size, daily-note and editor settings found
  (`.obsidian/daily-notes.json`, `app.json`, `appearance.json`, `.obsidian.vimrc`), templates
  folder, enabled community plugins (`.obsidian/community-plugins.json`) each with how it fares
  here (e.g. Dataview: queries show as text; Excalidraw: supported; Templater: templates insert as
  plain text; Tasks: task lines work, query blocks show as text), Canvas files (not viewable yet),
  and the carry-over plan for the current vault (below): notes that move, daily notes remapped,
  dates present in both, name collisions.
- `POST /api/import/obsidian { source, destination }` → creates a **new vault** at `destination`
  (default: a new folder next to the current vault, never inside the source) by copying the
  Obsidian vault byte for byte (attachments and `.obsidian/` included, so it still opens in
  Obsidian), then **carries over the current vault**:
  - non-daily notes at the same relative path; a collision keeps both (`Name (Daily Do List).md`);
  - daily notes moved to the Obsidian daily-note folder and format; for a date present in both,
    the Obsidian note is kept and the Daily Do List note's content is appended under a
    `## From Daily Do List` heading (nothing is dropped);
  - `Routines/` and drawings as they are;
  - the agent sidecar (`.daily-do-list/`): threads (snapshots and journals), task records,
    approvals and routines state with note paths (and task lines, where daily notes merged)
    remapped through core's task parser; a task that can't be matched keeps its thread, marked
    detached;
  - settings: agent settings from Daily Do List, daily-note and editor settings from Obsidian.
  The current vault is left untouched (it's the backup), and the import writes a manifest
  (`.daily-do-list/import/obsidian.json`: source, time, a hash per copied file).
- Progress events over the WebSocket; the import is cancellable, and a failed or cancelled import
  removes its partial destination.
- **Switch vaults:** `PUT /api/device/vault { path }` writes `vaultPath` to `$DDL_HOME/config.json`
  and restarts the daemon (the Mac app's supervisor starts it again; a standalone daemon exits with
  a documented code and its README says how to restart).
- **Update from Obsidian:** `POST /api/import/obsidian/update` copies files that changed in the
  source since the manifest, never overwriting a file changed here since the import (keep both),
  and reports what it did. It never deletes.
- Security: the source must be a readable directory outside `DDL_HOME`; symlinks aren't followed
  out of the source; copies go through atomic writes; nothing from the source is executed. Agents
  have no access to these routes.
- Protocol, contract and Swift models in the same change. Tests on temp dirs only, with a
  synthetic Obsidian vault fixture (plugins config, daily notes, attachments, a canvas, Dataview
  blocks, nested folders, unicode names).

### I1 — Import from Obsidian (web and Mac)

A guided flow in both apps (web: Settings → Vault → Import from Obsidian, with a path field;
Mac: the same with a folder picker): pick the vault, read the report, choose the destination,
import with progress, switch. "Update from Obsidian" and "Reveal the old vault" afterwards.

### B0 — binary files and attachment sync (after the always-on work lands)

`StorageProvider` gains binary reads and writes (local-fs, memory, remote) under the shared
contract tests; the sync service stores attachments
(content-addressed, size-limited) and the sync engine syncs them (newest wins, the other kept as a
conflict copy); the daemon serves vault files to clients (`GET /api/files/*`, bearer-authenticated,
correct content type, never executable content inline — the artifact policy applies). This is
also what the editors need to show images.

### P — the display gaps (after the drawings' embed layer, X1/X3)

On the web and the Mac, in live preview: **images** (`![[photo.png|300]]`, `![alt](path)`, with
Obsidian's size and alignment modifiers, sharing the drawings' embed layer and B0's file route),
**tables** (rendered; editing a cell shows the source row), **callouts** (`> [!note] Title`, the
standard types, foldable with `+`/`-`), and a **backlinks panel** (linked mentions with context,
plus unlinked mentions). Keystroke path stays O(line); performance budgets hold.
